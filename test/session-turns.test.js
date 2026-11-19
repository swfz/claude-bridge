import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  attachCommitHashes,
  buildTurns,
  parseCommitSubjects,
  readSessionTurns,
  summarizeTurns,
  turnPrompt,
} from '../server/session-turns.js';

const execAsync = promisify(exec);

const prompt = (text, timestamp = '2026-10-04T01:00:00.000Z') => ({
  type: 'user',
  timestamp,
  message: { role: 'user', content: text },
});
const assistant = (id, content, usage) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content, ...(usage ? { usage } : {}) },
});
const usage = (input, output, create = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
});
const bash = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const result = (toolUseId, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }],
  },
});

describe('parseCommitSubjects', () => {
  it('reads -m with double or single quotes', () => {
    assert.deepEqual(parseCommitSubjects('git commit -m "fix: 直す"'), ['fix: 直す']);
    assert.deepEqual(parseCommitSubjects("git add . && git commit -q -m 'feat: 足す'"), ['feat: 足す']);
  });

  it('reads the first line of a heredoc message', () => {
    const command = "git commit -q -F - <<'EOF'\n\nfeat(client): カレンダー\n\n本文\nEOF";
    assert.deepEqual(parseCommitSubjects(command), ['feat(client): カレンダー']);
    const sub = 'git commit -m "$(cat <<\'EOF\'\nrefactor: 切り出す\n\nCo-Authored-By: x\nEOF\n)"';
    assert.deepEqual(parseCommitSubjects(sub), ['refactor: 切り出す']);
  });

  it('collects several commits in one command', () => {
    const command = [
      "git add a && git commit -q -F - <<'EOF'",
      'feat: 1 つ目',
      'EOF',
      "git add b && git commit -q -F - <<'EOF'",
      'feat: 2 つ目',
      'EOF',
    ].join('\n');
    assert.deepEqual(parseCommitSubjects(command), ['feat: 1 つ目', 'feat: 2 つ目']);
  });

  it('ignores git commit that only appears in comments, strings or other heredocs', () => {
    assert.deepEqual(parseCommitSubjects('// git commit -m "件名"'), []);
    assert.deepEqual(parseCommitSubjects('echo "run git commit -m \'x\' later"'), []);
    const script = 'python3 - <<\'EOF\'\ngit commit -m "埋め込み"\nEOF';
    assert.deepEqual(parseCommitSubjects(script), []);
    assert.deepEqual(parseCommitSubjects('git log --oneline'), []);
    assert.deepEqual(parseCommitSubjects(undefined), []);
  });

  it('skips --amend', () => {
    assert.deepEqual(parseCommitSubjects('git commit --amend -m "直し"'), []);
  });
});

describe('turnPrompt', () => {
  it('returns the typed prompt', () => {
    assert.equal(turnPrompt(prompt('お願い')), 'お願い');
  });

  it('turns a slash command into "/name args"', () => {
    assert.equal(
      turnPrompt(prompt('<command-message>ship</command-message>\n<command-name>/ship</command-name>')),
      '/ship',
    );
    assert.equal(
      turnPrompt(prompt('<command-name>/code-review</command-name>\n<command-args>high</command-args>')),
      '/code-review high',
    );
  });

  it('ignores the auto-compact summary', () => {
    assert.equal(turnPrompt({ ...prompt('This session is being continued ...'), isCompactSummary: true }), '');
  });

  it('ignores messages from subagents and teammates', () => {
    assert.equal(
      turnPrompt(
        prompt('Another Claude session sent a message:\n<teammate-message teammate_id="a">\n完了\n</teammate-message>'),
      ),
      '',
    );
  });

  it('ignores meta, tool results, interrupts and injected tags', () => {
    assert.equal(turnPrompt({ ...prompt('x'), isMeta: true }), '');
    assert.equal(turnPrompt(result('t1')), '');
    assert.equal(turnPrompt(prompt('[Request interrupted by user]')), '');
    assert.equal(turnPrompt(prompt('<task-notification>done</task-notification>')), '');
    assert.equal(turnPrompt(assistant('m', [])), '');
  });
});

describe('buildTurns', () => {
  it('splits by prompt and counts tokens once per message id', () => {
    const turns = buildTurns([
      { type: 'last-prompt' },
      prompt('1 つ目', '2026-10-04T01:00:00.000Z'),
      // 同じ応答が content ブロックごとに分割され、同じ usage が繰り返し書かれる
      assistant('m1', [{ type: 'text', text: 'a' }], usage(10, 1, 100, 1000)),
      assistant('m1', [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }], usage(10, 1, 100, 1000)),
      { type: 'system', subtype: 'turn_duration', durationMs: 5000 },
      prompt('2 つ目', '2026-10-04T02:00:00.000Z'),
      assistant('m2', [{ type: 'text', text: 'b' }], usage(1, 2, 3, 4)),
      { type: 'system', subtype: 'turn_duration', durationMs: 1000 },
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].prompt, '1 つ目');
    assert.equal(turns[0].startedAt, '2026-10-04T01:00:00.000Z');
    assert.deepEqual(turns[0].tokens, { input: 10, output: 1, cacheCreation: 100, cacheRead: 1000, total: 1111 });
    assert.equal(turns[0].durationMs, 5000);
    assert.equal(turns[0].contextUsage.contextTokens, 1110);
    assert.equal(turns[1].tokens.total, 10);
    assert.equal(turns[1].durationMs, 1000);
  });

  it('records commits only when the Bash succeeded', () => {
    const turns = buildTurns([
      prompt('コミットして'),
      assistant('m1', [bash('ok', 'git commit -m "feat: 成功"')]),
      result('ok'),
      assistant('m2', [bash('ng', 'git commit -m "feat: 失敗"')]),
      result('ng', true),
    ]);
    assert.deepEqual(turns[0].commits, [{ subject: 'feat: 成功', hash: null }]);
  });

  it('dedupes PR links and attributes them to the turn they first appeared in', () => {
    const pr = (n) => ({
      type: 'pr-link',
      prNumber: n,
      prUrl: `https://github.com/o/r/pull/${n}`,
      prRepository: 'o/r',
    });
    const turns = buildTurns([prompt('PR 作って'), pr(1), pr(1), prompt('merge'), pr(1), pr(2)]);
    assert.deepEqual(
      turns.map((t) => t.prs.map((p) => p.number)),
      [[1], [2]],
    );
    assert.equal(turns[0].prs[0].repository, 'o/r');
  });

  it('collects edited files per turn', () => {
    const edit = (path) => ({ type: 'tool_use', id: path, name: 'Edit', input: { file_path: path } });
    const turns = buildTurns([
      prompt('直して'),
      assistant('m1', [edit('/r/b.js'), edit('/r/a.js')]),
      assistant('m2', [edit('/r/a.js'), { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/r/c.js' } }]),
    ]);
    assert.deepEqual(turns[0].editedFiles, ['/r/a.js', '/r/b.js', '/r/c.js']);
  });

  it('does not start a turn on interrupts and ignores records before the first prompt', () => {
    const turns = buildTurns([
      assistant('m0', [], usage(9, 9)),
      prompt('作業して'),
      prompt('[Request interrupted by user]'),
      assistant('m1', [], usage(1, 1)),
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].tokens.total, 2);
  });
});

describe('summarizeTurns / attachCommitHashes', () => {
  it('sums the turns and counts unique files', () => {
    const turn = (tokens, files, commits = 0, prs = 0) => ({
      tokens: { total: tokens },
      durationMs: 1000,
      editedFiles: files,
      commits: Array(commits).fill({}),
      prs: Array(prs).fill({}),
    });
    assert.deepEqual(summarizeTurns([turn(10, ['/a', '/b'], 1, 1), turn(5, ['/a'], 2)]), {
      prompts: 2,
      tokens: 15,
      durationMs: 2000,
      commits: 3,
      prs: 1,
      editedFiles: 2,
    });
  });

  it('fills hashes by subject, preferring the newest', () => {
    const turns = [
      {
        commits: [
          { subject: 'feat: a', hash: null },
          { subject: 'feat: missing', hash: null },
        ],
      },
    ];
    attachCommitHashes(turns, 'new111\tfeat: a\nold222\tfeat: a\nzzz\n');
    assert.deepEqual(turns[0].commits, [
      { subject: 'feat: a', hash: 'new111' },
      { subject: 'feat: missing', hash: null },
    ]);
  });
});

describe('readSessionTurns', () => {
  it('resolves commit hashes from the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cb-turns-repo-'));
    const git = (cmd) => execAsync(`git ${cmd}`, { cwd: repo });
    await git('init -q');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    await git('add .');
    await git('-c user.email=t@example.com -c user.name=t commit -q -m "feat: 実在するコミット"');
    const { stdout } = await git('log -1 --format=%h');

    const dir = await mkdtemp(join(tmpdir(), 'cb-turns-'));
    const file = join(dir, 's.jsonl');
    const records = [
      prompt('コミットして', new Date().toISOString()),
      assistant('m1', [bash('c1', 'git commit -m "feat: 実在するコミット"')]),
      result('c1'),
    ];
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const { turns, totals } = await readSessionTurns(file, { cwd: repo });
    assert.equal(turns[0].commits[0].hash, stdout.trim());
    assert.equal(totals.commits, 1);

    // cwd が無ければ件名だけ
    const noRepo = await readSessionTurns(file, { cwd: join(dir, 'missing') });
    assert.equal(noRepo.turns[0].commits[0].hash, null);
  });
});

// ---- ここから下はミューテーションテストで見つかった穴を埋めるもの ----

describe('parseCommitSubjects (境界)', () => {
  it('&& 以外の区切り（|| ; | ( ）の直後の git commit も数える', () => {
    assert.deepEqual(parseCommitSubjects('false || git commit -m "a"'), ['a']);
    assert.deepEqual(parseCommitSubjects('git add .; git commit -m "b"'), ['b']);
    assert.deepEqual(parseCommitSubjects('true | git commit -m "c"'), ['c']);
    assert.deepEqual(parseCommitSubjects('(git commit -m "d")'), ['d']);
    assert.deepEqual(parseCommitSubjects('   git commit -m "e"'), ['e']);
  });

  it('git のグローバルオプション（-C path / -c key=value）を挟んでも数える', () => {
    assert.deepEqual(parseCommitSubjects('git -C /repo commit -m "f"'), ['f']);
    assert.deepEqual(parseCommitSubjects('git -c user.name=x -c user.email=y commit -m "g"'), ['g']);
    assert.deepEqual(parseCommitSubjects('git --no-pager commit -m "h"'), ['h']);
  });

  it('単語の途中の git は数えない', () => {
    assert.deepEqual(parseCommitSubjects('legit commit -m "x"'), []);
  });

  it('--message の = 区切り・空白区切りを読む', () => {
    assert.deepEqual(parseCommitSubjects('git commit --message="i"'), ['i']);
    assert.deepEqual(parseCommitSubjects("git commit --message 'j'"), ['j']);
    assert.deepEqual(parseCommitSubjects('git commit -m=k'), []);
  });

  it('空の件名・$( で始まる件名は拾わず、前後の空白を落として 120 文字で切る', () => {
    assert.deepEqual(parseCommitSubjects('git commit -m "   "'), []);
    assert.deepEqual(parseCommitSubjects('git commit -m "$(git log -1 --format=%s)"'), []);
    assert.deepEqual(parseCommitSubjects('git commit -m "  前後に空白  "'), ['前後に空白']);
    assert.deepEqual(parseCommitSubjects(`git commit -m "${'あ'.repeat(130)}"`), ['あ'.repeat(120)]);
  });

  it('ヒアドキュメントの件名も前後の空白を落として 120 文字で切る', () => {
    assert.deepEqual(parseCommitSubjects(`git commit -F - <<'EOF'\n   ${'い'.repeat(130)}   \nEOF`), [
      'い'.repeat(120),
    ]);
  });

  it('<<- や二重引用符・引用符なしの終端も、字下げした終端行も読む', () => {
    assert.deepEqual(parseCommitSubjects('git commit -F - <<-"END"\nfeat: x\n\tEND'), ['feat: x']);
    assert.deepEqual(parseCommitSubjects('git commit -F - << MSG\nfeat: y\n  MSG  \ngit commit -m "z"'), [
      'feat: y',
      'z',
    ]);
  });

  it('本文が空のヒアドキュメントは件名なし', () => {
    assert.deepEqual(parseCommitSubjects("git commit -F - <<'EOF'\n\n   \nEOF"), []);
  });

  it('--amend のヒアドキュメントの本文は読み飛ばし、その後の git commit は数える', () => {
    const command = [
      "git commit --amend -F - <<'EOF'",
      'git commit -m "本文の中"',
      'EOF',
      'git commit -m "後のコミット"',
    ].join('\n');
    assert.deepEqual(parseCommitSubjects(command), ['後のコミット']);
  });

  it('git commit 以外のヒアドキュメントの後ろの git commit は数える', () => {
    const command = ["cat > f <<'EOF'", 'git commit -m "中"', 'EOF', 'git commit -m "外"'].join('\n');
    assert.deepEqual(parseCommitSubjects(command), ['外']);
  });

  it('文字列でない入力は空配列', () => {
    assert.deepEqual(parseCommitSubjects(null), []);
    assert.deepEqual(parseCommitSubjects(42), []);
  });
});

describe('turnPrompt (境界)', () => {
  it('引数が空白だけのスラッシュコマンドは名前だけ、名前と引数の前後の空白は落とす', () => {
    assert.equal(turnPrompt(prompt('<command-name> /ship </command-name><command-args>   </command-args>')), '/ship');
    assert.equal(turnPrompt(prompt('<command-name>/x</command-name><command-args>  a b  </command-args>')), '/x a b');
  });

  it('配列の本文に書かれたコマンドタグは区切りにしない', () => {
    const record = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<command-name>/ship</command-name>' }] },
    };
    assert.equal(turnPrompt(record), '');
  });

  it('meta・自動コンパクトのスラッシュコマンドも区切りにしない', () => {
    const cmd = prompt('<command-name>/ship</command-name>');
    assert.equal(turnPrompt({ ...cmd, isMeta: true }), '');
    assert.equal(turnPrompt({ ...cmd, isCompactSummary: true }), '');
    assert.equal(turnPrompt({ ...cmd, type: 'assistant' }), '');
  });

  it('中断で始まらない指示は区切りにする', () => {
    assert.equal(turnPrompt(prompt('前回 [Request interrupted] の続き')), '前回 [Request interrupted] の続き');
  });
});

describe('buildTurns (境界)', () => {
  it('同じ tool_use_id の結果が 2 回来てもコミットは 1 回、関係ない結果や他のブロックは無視', () => {
    const turns = buildTurns([
      prompt('コミットして'),
      assistant('m1', [bash('c1', 'git commit -m "feat: 1 回だけ"')]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'メモ' },
            { type: 'tool_result', tool_use_id: 'other', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
          ],
        },
      },
      result('c1'),
    ]);
    assert.deepEqual(turns[0].commits, [{ subject: 'feat: 1 回だけ', hash: null }]);
  });

  it('コミットの結果が次のターンで返っても、コミットしたターンに付ける', () => {
    const turns = buildTurns([
      prompt('1 つ目'),
      assistant('m1', [bash('c1', 'git commit -m "feat: 前のターン"')]),
      prompt('2 つ目'),
      result('c1'),
    ]);
    assert.equal(turns[0].commits.length, 1);
    assert.equal(turns[1].commits.length, 0);
  });

  it('id の無い Bash のコミットは数えない', () => {
    const turns = buildTurns([
      prompt('コミットして'),
      assistant('m1', [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "x"' } }]),
      result(undefined),
    ]);
    assert.deepEqual(turns[0].commits, []);
  });

  it('指示は 200 文字で切り、timestamp が無ければ開始時刻は空文字', () => {
    const turns = buildTurns([{ type: 'user', message: { role: 'user', content: 'し'.repeat(250) } }]);
    assert.equal(turns[0].prompt, 'し'.repeat(200));
    assert.equal(turns[0].startedAt, '');
    assert.deepEqual(turns[0], {
      startedAt: '',
      prompt: 'し'.repeat(200),
      durationMs: 0,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      contextUsage: null,
      commits: [],
      prs: [],
      editedFiles: [],
    });
  });

  it('turn_duration は数に直して足し、数でなければ 0', () => {
    const turns = buildTurns([
      prompt('作業'),
      { type: 'system', subtype: 'turn_duration', durationMs: '1500' },
      { type: 'system', subtype: 'turn_duration', durationMs: 'abc' },
      { type: 'system', subtype: 'turn_duration', durationMs: 500 },
      { type: 'system', subtype: 'other', durationMs: 9999 },
    ]);
    assert.equal(turns[0].durationMs, 2000);
  });

  it('最初の指示より前の turn_duration・pr-link は捨てる', () => {
    const turns = buildTurns([
      { type: 'system', subtype: 'turn_duration', durationMs: 100 },
      { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 },
      prompt('作業'),
      { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 },
    ]);
    assert.equal(turns[0].durationMs, 0);
    assert.deepEqual(turns[0].prs, [{ url: 'https://github.com/o/r/pull/1', number: 1, repository: '' }]);
  });

  it('prUrl の無い pr-link は無視し、番号が無ければ null にする', () => {
    const turns = buildTurns([
      prompt('PR'),
      { type: 'pr-link', prNumber: 3 },
      { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/4' },
    ]);
    assert.deepEqual(turns[0].prs, [{ url: 'https://github.com/o/r/pull/4', number: null, repository: '' }]);
  });

  it('message.id の無い応答は毎回数え、欠けた usage は 0 として足す', () => {
    const turns = buildTurns([
      prompt('作業'),
      assistant(undefined, [], { output_tokens: 2 }),
      assistant(undefined, [], { input_tokens: 3 }),
    ]);
    assert.deepEqual(turns[0].tokens, { input: 3, output: 2, cacheCreation: 0, cacheRead: 0, total: 5 });
  });

  it('同じ message.id でもターンをまたいで 2 度は数えない', () => {
    const turns = buildTurns([
      prompt('1'),
      assistant('m1', [], usage(1, 1)),
      prompt('2'),
      assistant('m1', [], usage(1, 1)),
      assistant('m2', [], usage(0, 0, 4, 0)),
    ]);
    assert.equal(turns[0].tokens.total, 2);
    assert.deepEqual(turns[1].tokens, { input: 0, output: 0, cacheCreation: 4, cacheRead: 0, total: 4 });
  });

  it('コンテキスト量は usage のある直近の応答のまま、usage の無い応答で消さない', () => {
    const turns = buildTurns([prompt('作業'), assistant('m1', [], usage(10, 0, 0, 5)), assistant('m2', [])]);
    assert.equal(turns[0].contextUsage.contextTokens, 15);
  });

  it('assistant 以外のレコードと配列でない本文は無視する', () => {
    const turns = buildTurns([
      prompt('作業'),
      { type: 'progress', message: { id: 'p', usage: usage(100, 100), content: [] } },
      { type: 'assistant', message: { id: 'm', content: 'text' } },
    ]);
    assert.equal(turns[0].tokens.total, 0);
    assert.deepEqual(turns[0].editedFiles, []);
  });

  it('NotebookEdit・MultiEdit も編集に数え、パスが文字列でなければ無視する', () => {
    const tool = (name, input) => ({ type: 'tool_use', id: name, name, input });
    const turns = buildTurns([
      prompt('直して'),
      assistant('m1', [
        tool('NotebookEdit', { notebook_path: '/r/n.ipynb' }),
        tool('MultiEdit', { file_path: '/r/m.js' }),
        tool('Edit', { file_path: 42 }),
        tool('Read', { file_path: '/r/read.js' }),
        { type: 'text', text: '/r/text.js' },
      ]),
    ]);
    assert.deepEqual(turns[0].editedFiles, ['/r/m.js', '/r/n.ipynb']);
  });
});

describe('attachCommitHashes (境界)', () => {
  it('タブで始まる行・タブの無い行は捨て、件名は 120 文字で切って突き合わせる', () => {
    const long = 'あ'.repeat(130);
    const turns = [
      {
        commits: [
          { subject: 'a', hash: null },
          { subject: long.slice(0, 120), hash: null },
        ],
      },
    ];
    attachCommitHashes(turns, `\ta\nabc123\t${long}\n`);
    assert.deepEqual(turns[0].commits, [
      { subject: 'a', hash: null },
      { subject: long.slice(0, 120), hash: 'abc123' },
    ]);
  });
});

describe('readSessionTurns (git との突き合わせ)', () => {
  const createdDirs = [];
  afterEach(async () => {
    while (createdDirs.length > 0) await rm(createdDirs.pop(), { recursive: true, force: true });
  });

  async function makeRepo() {
    const repo = await mkdtemp(join(tmpdir(), 'cb-turns-repo-'));
    createdDirs.push(repo);
    await execAsync('git init -q -b main', { cwd: repo });
    return repo;
  }

  // 日時を指定してコミットし、短縮ハッシュを返す
  async function commitAt(repo, subject, date) {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    await writeFile(join(repo, 'f.txt'), `${subject}\n`);
    await execAsync('git add .', { cwd: repo, env });
    await execAsync(
      `git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m "${subject}"`,
      { cwd: repo, env },
    );
    const { stdout } = await execAsync('git log -1 --format=%h', { cwd: repo });
    return stdout.trim();
  }

  async function writeSession(records) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-turns-'));
    createdDirs.push(dir);
    const file = join(dir, 's.jsonl');
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  const commitTurn = (startedAt, subjects) => [
    prompt('コミットして', startedAt),
    assistant(
      'm1',
      subjects.map((s, i) => bash(`c${i}`, `git commit -m "${s}"`)),
    ),
    ...subjects.map((_, i) => result(`c${i}`)),
  ];

  it('最初のターンの 1 時間前より古いコミットは引かない', async () => {
    const repo = await makeRepo();
    await commitAt(repo, 'feat: 古すぎる', '2026-10-04T08:30:00Z');
    const recent = await commitAt(repo, 'feat: 範囲内', '2026-10-04T09:30:00Z');
    const file = await writeSession(commitTurn('2026-10-04T10:00:00.000Z', ['feat: 古すぎる', 'feat: 範囲内']));

    const { turns } = await readSessionTurns(file, { cwd: repo });
    assert.deepEqual(turns[0].commits, [
      { subject: 'feat: 古すぎる', hash: null },
      { subject: 'feat: 範囲内', hash: recent },
    ]);
  });

  it('別ブランチのコミットも引く', async () => {
    const repo = await makeRepo();
    await commitAt(repo, 'feat: main', '2026-10-04T09:50:00Z');
    await execAsync('git checkout -q -b topic', { cwd: repo });
    const topic = await commitAt(repo, 'feat: topic', '2026-10-04T10:10:00Z');
    await execAsync('git checkout -q main', { cwd: repo });
    const file = await writeSession(commitTurn('2026-10-04T10:00:00.000Z', ['feat: topic']));

    const { turns } = await readSessionTurns(file, { cwd: repo });
    assert.equal(turns[0].commits[0].hash, topic);
  });

  it('cwd を渡さなければ git を見ずに件名だけ返す', async () => {
    const repo = await makeRepo();
    await commitAt(repo, 'feat: x', new Date().toISOString());
    const file = await writeSession(commitTurn(new Date().toISOString(), ['feat: x']));
    const { turns, totals } = await readSessionTurns(file);
    assert.deepEqual(turns[0].commits, [{ subject: 'feat: x', hash: null }]);
    assert.equal(totals.commits, 1);
  });

  it('JSONL の空行・壊れた行は飛ばす', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-turns-'));
    createdDirs.push(dir);
    const file = join(dir, 's.jsonl');
    await writeFile(file, `\n   \n{ broken\n${JSON.stringify(prompt('指示'))}\n`);
    const { turns, totals } = await readSessionTurns(file);
    assert.deepEqual(
      turns.map((t) => t.prompt),
      ['指示'],
    );
    assert.equal(totals.prompts, 1);
  });
});

describe('parseCommitSubjects (空白と終端)', () => {
  it('git と commit の間・オプションの前後の空白が複数でも数える', () => {
    assert.deepEqual(parseCommitSubjects('git  commit -m "a"'), ['a']);
    assert.deepEqual(parseCommitSubjects('git -C  /repo commit -m "b"'), ['b']);
    assert.deepEqual(parseCommitSubjects('git -C /repo  commit -m "c"'), ['c']);
    assert.deepEqual(parseCommitSubjects('git commit -m  "d"'), ['d']);
  });

  it('終端の無いヒアドキュメントは最後の行まで読む', () => {
    assert.deepEqual(parseCommitSubjects("git commit -F - <<'EOF'\nfeat: 終端なし"), ['feat: 終端なし']);
    assert.deepEqual(parseCommitSubjects('cat <<\'EOF\'\ngit commit -m "中"'), []);
  });
});

describe('turnPrompt・buildTurns (欠けたレコード)', () => {
  it('message の無い user・assistant レコードでも落ちない', () => {
    assert.equal(turnPrompt({ type: 'user' }), '');
    const turns = buildTurns([{ type: 'user' }, prompt('作業'), { type: 'assistant' }, { type: 'user' }]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].tokens.total, 0);
  });

  it('本文の中の null ブロックや input の無いツール呼び出しは飛ばす', () => {
    const turns = buildTurns([
      prompt('作業'),
      assistant('m1', [
        null,
        { type: 'tool_use', id: 'e', name: 'Edit' },
        { type: 'tool_use', id: 'b', name: 'Bash' },
        { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/r/w.js' } },
      ]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
    ]);
    assert.deepEqual(turns[0].editedFiles, ['/r/w.js']);
    assert.deepEqual(turns[0].commits, []);
  });

  it('Bash 以外のツールの command はコミットとして読まない', () => {
    const turns = buildTurns([
      prompt('見張って'),
      assistant('m1', [{ type: 'tool_use', id: 'mon', name: 'Monitor', input: { command: 'git commit -m "x"' } }]),
      result('mon'),
    ]);
    assert.deepEqual(turns[0].commits, []);
  });

  it('tool_use 以外のブロックはツール名を持っていても編集に数えない', () => {
    const turns = buildTurns([
      prompt('作業'),
      assistant('m1', [{ type: 'server_tool_use', id: 's', name: 'Edit', input: { file_path: '/r/x.js' } }]),
    ]);
    assert.deepEqual(turns[0].editedFiles, []);
  });

  it('system 以外の turn_duration・pr-link 以外の prUrl は数えない', () => {
    const turns = buildTurns([
      prompt('作業'),
      { type: 'progress', subtype: 'turn_duration', durationMs: 100 },
      { type: 'progress', prUrl: 'https://github.com/o/r/pull/9', prNumber: 9 },
    ]);
    assert.equal(turns[0].durationMs, 0);
    assert.deepEqual(turns[0].prs, []);
  });
});

describe('attachCommitHashes (タブで始まる行)', () => {
  it('タブで始まる行は後の同じ件名の行を邪魔しない', () => {
    const turns = [{ commits: [{ subject: 'a', hash: null }] }];
    attachCommitHashes(turns, '\ta\nabc123\ta\n');
    assert.deepEqual(turns[0].commits, [{ subject: 'a', hash: 'abc123' }]);
  });
});

describe('readSessionTurns (コミットのあるターンが途中にある場合)', () => {
  const createdDirs = [];
  afterEach(async () => {
    while (createdDirs.length > 0) await rm(createdDirs.pop(), { recursive: true, force: true });
  });

  it('最初のターンにコミットが無くても、後のターンのコミットのハッシュを引く', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cb-turns-repo-'));
    createdDirs.push(repo);
    const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-04T10:30:00Z', GIT_COMMITTER_DATE: '2026-10-04T10:30:00Z' };
    await execAsync('git init -q -b main', { cwd: repo });
    await writeFile(join(repo, 'f.txt'), 'x\n');
    await execAsync('git add .', { cwd: repo, env });
    await execAsync('git -c user.email=t@example.com -c user.name=t commit -q -m "feat: 後のターン"', {
      cwd: repo,
      env,
    });
    const { stdout } = await execAsync('git log -1 --format=%h', { cwd: repo });

    const dir = await mkdtemp(join(tmpdir(), 'cb-turns-'));
    createdDirs.push(dir);
    const file = join(dir, 's.jsonl');
    const records = [
      prompt('相談', '2026-10-04T10:00:00.000Z'),
      prompt('コミットして', '2026-10-04T10:20:00.000Z'),
      assistant('m1', [bash('c1', 'git commit -m "feat: 後のターン"')]),
      result('c1'),
    ];
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { turns } = await readSessionTurns(file, { cwd: repo });
    assert.deepEqual(turns[1].commits, [{ subject: 'feat: 後のターン', hash: stdout.trim() }]);
  });
});

describe('readSessionTurns (git を引かない場合)', () => {
  const createdDirs = [];
  afterEach(async () => {
    while (createdDirs.length > 0) await rm(createdDirs.pop(), { recursive: true, force: true });
  });

  async function writeSession(text) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-turns-'));
    createdDirs.push(dir);
    const file = join(dir, 's.jsonl');
    await writeFile(file, text);
    return { dir, file };
  }

  it('ターンが 1 つも無ければ cwd があっても空で返す', async () => {
    const { dir, file } = await writeSession(JSON.stringify({ type: 'ai-title', aiTitle: 'x' }) + '\n');
    const { turns, totals } = await readSessionTurns(file, { cwd: dir });
    assert.deepEqual(turns, []);
    assert.equal(totals.prompts, 0);
  });

  it('コミットの無いセッションは、開始時刻が無くても cwd があっても git を引かずに返す', async () => {
    const { dir, file } = await writeSession(
      JSON.stringify({ type: 'user', message: { role: 'user', content: '時刻なしの指示' } }) + '\n',
    );
    const { turns } = await readSessionTurns(file, { cwd: dir });
    assert.deepEqual(
      turns.map((t) => [t.prompt, t.startedAt, t.commits]),
      [['時刻なしの指示', '', []]],
    );
  });
});

describe('buildTurns (meta の user レコード)', () => {
  it('meta の user レコードの本文に null ブロックがあっても落ちない', () => {
    const turns = buildTurns([
      prompt('作業'),
      { type: 'user', isMeta: true, message: { role: 'user', content: [null, { type: 'text', text: 'meta' }] } },
    ]);
    assert.equal(turns.length, 1);
  });
});
