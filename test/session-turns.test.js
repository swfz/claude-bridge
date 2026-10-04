import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile } from 'fs/promises';
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
