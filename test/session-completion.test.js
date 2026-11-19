import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSessionCompletionCache,
  getGitState,
  hasGitPush,
  parsePorcelainZ,
  readSessionCompletion,
  readSessionEditedFiles,
  readSessionPushes,
  toRepoRelative,
} from '../server/session-completion.js';

// 既定の PR 状態の取得（gh pr view）は本物の gh を呼ばないよう execFile だけ差し替える。
// git を走らせる exec は本物のまま
const gh = vi.hoisted(() => ({ stdout: '{"state":"OPEN"}', calls: 0 }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: (cmd, args, opts, cb) => {
    gh.calls++;
    cb(null, { stdout: gh.stdout, stderr: '' });
  },
}));

// PR の状態は各テストで prState を差し替える。差し替え忘れても gh を走らせない
process.env.CLAUDE_BRIDGE_DISABLE_GH = '1';

const execAsync = promisify(exec);
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const toolUse = (name, input, id = 'x') => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, { isError = false } = {}) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: isError ? 'rejected' : 'ok',
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

// テストが作った一時ディレクトリ（afterEach で消す）
const madeDirs = [];
afterEach(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeSession(records, { subagents = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-completion-'));
  madeDirs.push(dir);
  const filePath = join(dir, 's1.jsonl');
  await writeFile(filePath, jsonl(records));
  for (const [name, recs] of Object.entries(subagents)) {
    await mkdir(join(dir, 's1', 'subagents'), { recursive: true });
    await writeFile(join(dir, 's1', 'subagents', name), jsonl(recs));
  }
  return filePath;
}

// 1 コミット済みのリポジトリを作る
async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'cb-repo-'));
  madeDirs.push(repo);
  const git = (cmd) => execAsync(`git ${cmd}`, { cwd: repo });
  await git('init -q');
  await git('config user.email t@example.com');
  await git('config user.name t');
  await writeFile(join(repo, 'committed.txt'), 'a\n');
  await writeFile(join(repo, 'other.txt'), 'a\n');
  await git('add .');
  await git('commit -q -m init');
  return { repo, git };
}

describe('readSessionEditedFiles', () => {
  beforeEach(() => clearSessionCompletionCache());

  it('collects file paths from Edit / Write / MultiEdit / NotebookEdit only', async () => {
    const filePath = await makeSession([
      toolUse('Edit', { file_path: '/r/a.js', old_string: 'x', new_string: 'y' }),
      toolUse('Write', { file_path: '/r/b.js', content: '' }),
      toolUse('MultiEdit', { file_path: '/r/a.js', edits: [] }),
      toolUse('NotebookEdit', { notebook_path: '/r/n.ipynb' }),
      toolUse('Read', { file_path: '/r/read-only.js' }),
      toolUse('Edit', { file_path: 'relative.js' }),
    ]);
    assert.deepEqual((await readSessionEditedFiles(filePath)).sort(), ['/r/a.js', '/r/b.js', '/r/n.ipynb']);
  });

  it('includes files edited by subagents', async () => {
    const filePath = await makeSession([toolUse('Edit', { file_path: '/r/main.js' })], {
      subagents: { 'agent-1.jsonl': [toolUse('Write', { file_path: '/r/sub.js' })] },
    });
    assert.deepEqual((await readSessionEditedFiles(filePath)).sort(), ['/r/main.js', '/r/sub.js']);
  });

  it('reads appended edits on the next call', async () => {
    const filePath = await makeSession([toolUse('Edit', { file_path: '/r/a.js' })]);
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/a.js']);
    await appendFile(filePath, jsonl([toolUse('Write', { file_path: '/r/b.js' })]));
    assert.deepEqual((await readSessionEditedFiles(filePath)).sort(), ['/r/a.js', '/r/b.js']);
  });

  it('returns an empty list for a missing file', async () => {
    assert.deepEqual(await readSessionEditedFiles('/no/such/session.jsonl'), []);
  });
});

describe('parsePorcelainZ', () => {
  it('collects paths and skips the original path of renames', () => {
    const out = [' M src/a.js', '?? new file.txt', 'R  renamed.js', 'old.js', ' D gone.js', ''].join('\0');
    assert.deepEqual([...parsePorcelainZ(out)].sort(), ['gone.js', 'new file.txt', 'renamed.js', 'src/a.js']);
  });

  it('returns an empty set for a clean tree', () => {
    assert.equal(parsePorcelainZ('').size, 0);
  });
});

describe('toRepoRelative', () => {
  it('maps paths under the repo root', () => {
    assert.equal(toRepoRelative('/repo/src/a.js', { cwd: '/repo', realCwd: '/repo', root: '/repo' }), 'src/a.js');
  });

  it('rewrites the cwd prefix to the real path before comparing', () => {
    const ctx = { cwd: '/tmp/repo', realCwd: '/private/tmp/repo', root: '/private/tmp/repo' };
    assert.equal(toRepoRelative('/tmp/repo/a.js', ctx), 'a.js');
  });

  it('ignores paths outside the repository', () => {
    assert.equal(toRepoRelative('/elsewhere/a.js', { cwd: '/repo', realCwd: '/repo', root: '/repo' }), null);
    assert.equal(toRepoRelative('/repo-other/a.js', { cwd: '/repo', realCwd: '/repo', root: '/repo' }), null);
  });
});

describe('hasGitPush', () => {
  it('detects a plain git push and one chained after other commands', () => {
    assert.equal(hasGitPush('git push'), true);
    assert.equal(hasGitPush('git push -u origin HEAD'), true);
    assert.equal(hasGitPush('git add . && git commit -m "fix" && git push origin main'), true);
    assert.equal(hasGitPush('npm test; git push'), true);
    assert.equal(hasGitPush('(cd sub && git push)'), true);
  });

  it('accepts global options before push', () => {
    assert.equal(hasGitPush('git -C /repo push'), true);
    assert.equal(hasGitPush('git --no-pager push origin HEAD'), true);
  });

  it('detects a push chained after a heredoc commit message', () => {
    const command = ["git commit -m \"$(cat <<'EOF'", 'fix: x', '', 'Co-Authored-By: a', 'EOF', ')" && git push'].join(
      '\n',
    );
    assert.equal(hasGitPush(command), true);
  });

  it('ignores git push inside a heredoc body', () => {
    const command = ['cat > deploy.sh <<EOF', 'git push origin main', 'EOF'].join('\n');
    assert.equal(hasGitPush(command), false);
  });

  it('ignores git push in comments and strings', () => {
    assert.equal(hasGitPush('# git push はあとで'), false);
    assert.equal(hasGitPush('echo "run git push later"'), false);
    assert.equal(hasGitPush("git commit -m 'prepare git push'"), false);
  });

  it('ignores dry runs', () => {
    assert.equal(hasGitPush('git push --dry-run'), false);
    assert.equal(hasGitPush('git push -n origin main'), false);
    // 同じコマンド内の別の push は dry-run ではない
    assert.equal(hasGitPush('git push --dry-run && git push'), true);
  });

  it('does not match other subcommands or non-strings', () => {
    assert.equal(hasGitPush('git pushx'), false);
    assert.equal(hasGitPush('git stash push'), false);
    // 引用符で囲んだサブコマンドも push の前のオプションとはみなさない
    assert.equal(hasGitPush('git "stash" push'), false);
    assert.equal(hasGitPush('git status'), false);
    assert.equal(hasGitPush(undefined), false);
  });
});

describe('readSessionCompletion', () => {
  beforeEach(() => clearSessionCompletionCache());

  it("reports 'none' when the session edited nothing", async () => {
    const filePath = await makeSession([toolUse('Read', { file_path: '/r/a.js' })]);
    const result = await readSessionCompletion({ filePath, cwd: '/r' });
    assert.deepEqual(result, {
      edited: 0,
      git: 'none',
      uncommitted: [],
      uncommittedCount: 0,
      pushed: false,
      prCount: 0,
      hasRemote: null,
      prs: [],
    });
  });

  it("reports 'dirty' only for files this session edited", async () => {
    const { repo } = await makeRepo();
    await writeFile(join(repo, 'committed.txt'), 'changed\n');
    await writeFile(join(repo, 'created.txt'), 'new\n');
    // 別セッションの変更（このセッションは触っていない）
    await writeFile(join(repo, 'other.txt'), 'changed by someone else\n');
    const filePath = await makeSession([
      toolUse('Edit', { file_path: join(repo, 'committed.txt') }),
      toolUse('Write', { file_path: join(repo, 'created.txt') }),
    ]);

    const result = await readSessionCompletion({ filePath, cwd: repo });
    assert.equal(result.git, 'dirty');
    assert.equal(result.edited, 2);
    assert.deepEqual(result.uncommitted, ['committed.txt', 'created.txt']);
    assert.equal(result.uncommittedCount, 2);
  });

  it("reports 'clean' once the edited files are committed", async () => {
    const { repo, git } = await makeRepo();
    await writeFile(join(repo, 'committed.txt'), 'changed\n');
    await git('commit -q -am change');
    await writeFile(join(repo, 'other.txt'), 'dirty but not ours\n');
    const filePath = await makeSession([toolUse('Edit', { file_path: join(repo, 'committed.txt') })]);

    const result = await readSessionCompletion({ filePath, cwd: repo });
    assert.equal(result.git, 'clean');
    assert.equal(result.uncommittedCount, 0);
  });

  it("reports 'unknown' when the cwd no longer exists (e.g. a removed worktree)", async () => {
    const { repo } = await makeRepo();
    const filePath = await makeSession([toolUse('Edit', { file_path: join(repo, 'committed.txt') })]);
    await rm(repo, { recursive: true, force: true });

    const result = await readSessionCompletion({ filePath, cwd: repo });
    assert.equal(result.git, 'unknown');
    assert.equal(result.edited, 1);
  });

  it('reports pushed when a git push tool_use succeeded', async () => {
    const filePath = await makeSession([
      toolUse('Bash', { command: 'git push -u origin HEAD' }, 'push-1'),
      toolResult('push-1'),
    ]);
    const result = await readSessionCompletion({ filePath, cwd: '/r' });
    assert.equal(result.pushed, true);
    assert.equal(result.prCount, 0);
  });

  it('does not count a push whose result was an error', async () => {
    const filePath = await makeSession([
      toolUse('Bash', { command: 'git push' }, 'push-1'),
      toolResult('push-1', { isError: true }),
      toolUse('Bash', { command: 'git push --dry-run' }, 'push-2'),
      toolResult('push-2'),
    ]);
    const result = await readSessionCompletion({ filePath, cwd: '/r' });
    assert.equal(result.pushed, false);
  });

  it('counts created PRs from pr-link records', async () => {
    const prLink = (n) => ({
      type: 'pr-link',
      sessionId: 's1',
      prNumber: n,
      prUrl: `https://github.com/o/r/pull/${n}`,
    });
    const filePath = await makeSession([prLink(1), prLink(2), prLink(1)]);
    const prState = async (url) => (url.endsWith('/1') ? 'merged' : 'open');
    const result = await readSessionCompletion({ filePath, cwd: '/r', prState });
    assert.equal(result.pushed, true);
    assert.equal(result.prCount, 2);
    // 新しい順。編集が無くても PR の状態は見る
    assert.equal(result.git, 'none');
    assert.deepEqual(result.prs, [
      { url: 'https://github.com/o/r/pull/2', state: 'open' },
      { url: 'https://github.com/o/r/pull/1', state: 'merged' },
    ]);
  });

  it('looks up at most the 5 newest PRs', async () => {
    const prLink = (n) => ({ type: 'pr-link', prNumber: n, prUrl: `https://github.com/o/r/pull/${n}` });
    const filePath = await makeSession([1, 2, 3, 4, 5, 6, 7].map(prLink));
    const asked = [];
    const prState = async (url) => (asked.push(url), 'merged');
    const result = await readSessionCompletion({ filePath, cwd: '/r', prState });
    assert.equal(result.prCount, 7);
    assert.deepEqual(
      result.prs.map((p) => p.url.split('/').pop()),
      ['7', '6', '5', '4', '3'],
    );
    assert.equal(asked.length, 5);
  });

  it('collects PR URLs from subagents too, without duplicates', async () => {
    const prLink = (n) => ({ type: 'pr-link', prNumber: n, prUrl: `https://github.com/o/r/pull/${n}` });
    const filePath = await makeSession([prLink(1)], { subagents: { 'agent-1.jsonl': [prLink(2), prLink(1)] } });
    const pushes = await readSessionPushes(filePath);
    assert.deepEqual(pushes.prUrls, ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  });

  it('picks up pushes made by subagents and appended later', async () => {
    const filePath = await makeSession([toolUse('Read', { file_path: '/r/a.js' })], {
      subagents: { 'agent-1.jsonl': [toolUse('Bash', { command: 'git push' }, 'sub-push'), toolResult('sub-push')] },
    });
    assert.equal((await readSessionCompletion({ filePath, cwd: '/r' })).pushed, true);

    clearSessionCompletionCache();
    const plain = await makeSession([toolUse('Bash', { command: 'npm test' }, 'b1')]);
    assert.equal((await readSessionCompletion({ filePath: plain, cwd: '/r' })).pushed, false);
    await appendFile(plain, jsonl([toolUse('Bash', { command: 'git push' }, 'b2'), toolResult('b2')]));
    assert.equal((await readSessionCompletion({ filePath: plain, cwd: '/r' })).pushed, true);
  });

  it('returns pushed / prCount together with the git state', async () => {
    const { repo, git } = await makeRepo();
    await writeFile(join(repo, 'committed.txt'), 'changed\n');
    await git('commit -q -am change');
    const filePath = await makeSession([
      toolUse('Edit', { file_path: join(repo, 'committed.txt') }),
      toolUse('Bash', { command: 'git push' }, 'push-1'),
      toolResult('push-1'),
    ]);
    const result = await readSessionCompletion({ filePath, cwd: repo });
    assert.equal(result.git, 'clean');
    assert.equal(result.pushed, true);
  });

  it('reports hasRemote: false for a local-only repository, and true once a remote is added', async () => {
    const { repo, git } = await makeRepo();
    await writeFile(join(repo, 'committed.txt'), 'changed\n');
    await git('commit -q -am change');
    const filePath = await makeSession([toolUse('Edit', { file_path: join(repo, 'committed.txt') })]);
    assert.equal((await readSessionCompletion({ filePath, cwd: repo })).hasRemote, false);

    await git('remote add origin https://example.com/dummy.git');
    clearSessionCompletionCache();
    assert.equal((await readSessionCompletion({ filePath, cwd: repo })).hasRemote, true);
  });

  it('reports hasRemote: null when it cannot be decided', async () => {
    const { repo } = await makeRepo();
    const filePath = await makeSession([toolUse('Edit', { file_path: join(repo, 'committed.txt') })]);
    await rm(repo, { recursive: true, force: true });
    assert.equal((await readSessionCompletion({ filePath, cwd: repo })).hasRemote, null);
  });

  it("returns the whole 'unknown' result when the cwd is not given", async () => {
    const filePath = await makeSession([toolUse('Edit', { file_path: '/r/a.js' })]);
    const result = await readSessionCompletion({ filePath, cwd: undefined });
    assert.deepEqual(result, {
      edited: 1,
      git: 'unknown',
      uncommitted: [],
      uncommittedCount: 0,
      pushed: false,
      prCount: 0,
      hasRemote: null,
      prs: [],
    });
  });

  it('lists uncommitted files in path order, at most 20, with the full count', async () => {
    const { repo } = await makeRepo();
    const names = Array.from({ length: 21 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    for (const name of names) await writeFile(join(repo, name), 'x\n');
    // 編集した順（逆順）ではなくパス順に並べる
    const filePath = await makeSession(
      [...names].reverse().map((name) => toolUse('Write', { file_path: join(repo, name) })),
    );
    const result = await readSessionCompletion({ filePath, cwd: repo });
    assert.equal(result.git, 'dirty');
    assert.equal(result.uncommittedCount, 21);
    assert.deepEqual(result.uncommitted, names.slice(0, 20));
  });

  it('uses gh for PR states by default and forgets them on clearSessionCompletionCache()', async () => {
    const saved = process.env.CLAUDE_BRIDGE_DISABLE_GH;
    delete process.env.CLAUDE_BRIDGE_DISABLE_GH;
    try {
      const url = 'https://github.com/o/r/pull/42';
      const filePath = await makeSession([{ type: 'pr-link', prNumber: 42, prUrl: url }]);
      gh.stdout = '{"state":"OPEN"}';
      assert.deepEqual((await readSessionCompletion({ filePath, cwd: '/r' })).prs, [{ url, state: 'open' }]);
      gh.stdout = '{"state":"MERGED"}';
      assert.deepEqual((await readSessionCompletion({ filePath, cwd: '/r' })).prs, [{ url, state: 'open' }]);
      clearSessionCompletionCache();
      assert.deepEqual((await readSessionCompletion({ filePath, cwd: '/r' })).prs, [{ url, state: 'merged' }]);
    } finally {
      process.env.CLAUDE_BRIDGE_DISABLE_GH = saved;
    }
  });
});

describe('readSessionEditedFiles の細部', () => {
  beforeEach(() => clearSessionCompletionCache());

  it('counts MultiEdit on its own', async () => {
    const filePath = await makeSession([toolUse('MultiEdit', { file_path: '/r/multi.js', edits: [] })]);
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/multi.js']);
  });

  it('ignores edit-shaped blocks outside assistant tool_use, and survives odd records', async () => {
    const editBlock = { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/r/user.js' } };
    const filePath = await makeSession([
      // user レコードの中の tool_use は数えない
      { type: 'user', message: { content: [editBlock] } },
      // tool_use 以外のブロック（"tool_use" の文字列は行に含む）
      {
        type: 'assistant',
        message: { content: [{ ...editBlock, type: 'text', tool_use: true, input: { file_path: '/r/text.js' } }] },
      },
      // message が無い・content が配列でない・null ブロック・input が無い・パスが文字列でない
      { type: 'assistant', tool_use: true, file_path: '/r/no-message.js' },
      { type: 'assistant', message: { content: { type: 'tool_use', name: 'Edit', file_path: '/r/obj.js' } } },
      {
        type: 'assistant',
        message: { content: [null, { type: 'tool_use', name: 'Edit', file_path: '/r/no-input.js' }] },
      },
      toolUse('Edit', { file_path: ['/r/array.js'] }),
      toolUse('Edit', { file_path: '/r/ok.js' }),
    ]);
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/ok.js']);
  });

  it('reads only *.jsonl files in the subagents directory', async () => {
    const filePath = await makeSession([toolUse('Edit', { file_path: '/r/main.js' })], {
      subagents: {
        'agent-1.meta.json': [toolUse('Edit', { file_path: '/r/meta.js' })],
        'agent-1.jsonl': [toolUse('Edit', { file_path: '/r/sub.js' })],
      },
    });
    assert.deepEqual((await readSessionEditedFiles(filePath)).sort(), ['/r/main.js', '/r/sub.js']);
  });

  it('re-reads a rewritten file with the same size and mtime only after clearSessionCompletionCache()', async () => {
    const filePath = await makeSession([toolUse('Edit', { file_path: '/r/aa.js' })]);
    await utimes(filePath, 1000, 1000);
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/aa.js']);
    await writeFile(filePath, jsonl([toolUse('Edit', { file_path: '/r/bb.js' })]));
    await utimes(filePath, 1000, 1000);
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/aa.js']);
    clearSessionCompletionCache();
    assert.deepEqual(await readSessionEditedFiles(filePath), ['/r/bb.js']);
  });
});

describe('readSessionPushes の細部', () => {
  beforeEach(() => clearSessionCompletionCache());

  it('ignores pr-link records without a usable URL', async () => {
    const filePath = await makeSession([
      { type: 'pr-link', prNumber: 1, prUrl: '' },
      { type: 'pr-link', prNumber: 2, prUrl: 123 },
      { type: 'pr-link', prNumber: 3 },
    ]);
    assert.deepEqual(await readSessionPushes(filePath), { pushed: false, prCount: 0, prUrls: [] });
  });

  it('counts only Bash tool_use blocks with an id in assistant records', async () => {
    const push = { type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'git push' } };
    const filePath = await makeSession([
      { type: 'user', message: { content: [push] } },
      { type: 'assistant', message: { content: [{ ...push, type: 'text' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'b0', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'p2', name: 'Task', input: { command: 'git push' } },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }] } },
    ]);
    assert.equal((await readSessionPushes(filePath)).pushed, false);
  });

  it('survives records without message, with non-array content, null blocks or no input', async () => {
    const filePath = await makeSession([
      { type: 'system', is_error: true },
      { type: 'user', message: { content: { is_error: true } } },
      { type: 'user', message: { content: [null, { type: 'tool_result', tool_use_id: 'z', is_error: true }] } },
      { type: 'assistant', message: { content: [null, { type: 'tool_use', id: 'n', name: 'Bash', note: 'push' }] } },
      toolUse('Bash', { command: 'git push' }, 'ok'),
    ]);
    assert.equal((await readSessionPushes(filePath)).pushed, true);
  });

  it('treats only error tool_result blocks in user records as failed pushes', async () => {
    const filePath = await makeSession([
      toolUse('Bash', { command: 'git push' }, 'p1'),
      // assistant レコードの tool_result、tool_result 以外のブロックはエラー扱いしない
      { type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', is_error: true }] } },
      { type: 'user', message: { content: [{ type: 'text', tool_use_id: 'p1', is_error: true }] } },
      // 同じ行に別のエラーがあっても、成功した結果はエラーにしない
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'other', is_error: true, content: 'x' },
            { type: 'tool_result', tool_use_id: 'p1', content: 'ok' },
          ],
        },
      },
    ]);
    assert.equal((await readSessionPushes(filePath)).pushed, true);
  });

  it('re-reads a rewritten file with the same size and mtime only after clearSessionCompletionCache()', async () => {
    const records = (errorId) => [
      toolUse('Bash', { command: 'git push' }, 'aa'),
      toolResult(errorId, { isError: true }),
    ];
    const filePath = await makeSession(records('ab'));
    await utimes(filePath, 1000, 1000);
    assert.equal((await readSessionPushes(filePath)).pushed, true);
    await writeFile(filePath, jsonl(records('aa')));
    await utimes(filePath, 1000, 1000);
    assert.equal((await readSessionPushes(filePath)).pushed, true);
    clearSessionCompletionCache();
    assert.equal((await readSessionPushes(filePath)).pushed, false);
  });
});

describe('parsePorcelainZ の細部', () => {
  it('accepts the shortest entry and skips the source path of copies', () => {
    assert.deepEqual([...parsePorcelainZ(' M a')], ['a']);
    assert.deepEqual([...parsePorcelainZ(['C  copy.js', 'orig.js', ' M b.js', ''].join('\0'))].sort(), [
      'b.js',
      'copy.js',
    ]);
  });
});

describe('toRepoRelative の細部', () => {
  it('maps the root itself to an empty path', () => {
    assert.equal(toRepoRelative('/repo', { cwd: '/repo', realCwd: '/repo', root: '/repo' }), '');
    const ctx = { cwd: '/tmp/repo', realCwd: '/private/tmp/repo', root: '/private/tmp/repo' };
    assert.equal(toRepoRelative('/tmp/repo', ctx), '');
  });

  it('rewrites only paths under the cwd', () => {
    // cwd がリポジトリのサブディレクトリで、cwd の外（リポジトリ内）の実体パス
    const ctx = { cwd: '/tmp/repo/sub', realCwd: '/private/tmp/repo/sub', root: '/private/tmp/repo' };
    assert.equal(toRepoRelative('/private/tmp/repo/other.js', ctx), 'other.js');
    assert.equal(toRepoRelative('/tmp/repo/sub/a.js', ctx), 'sub/a.js');
  });

  it('leaves paths as they are when the real cwd is unknown', () => {
    assert.equal(toRepoRelative('/repo/a.js', { cwd: '/repo', root: '/repo' }), 'a.js');
  });
});

describe('getGitState', () => {
  beforeEach(() => clearSessionCompletionCache());

  it('returns null outside git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-nogit-'));
    madeDirs.push(dir);
    assert.equal(await getGitState(dir), null);
  });

  it('reuses the result for 15 seconds per cwd', async () => {
    const { repo } = await makeRepo();
    const base = 1_000_000;
    const first = await getGitState(repo, base);
    assert.equal(first.dirty.size, 0);
    await writeFile(join(repo, 'committed.txt'), 'changed\n');
    assert.equal((await getGitState(repo, base + 14_999)).dirty.size, 0);
    assert.deepEqual([...(await getGitState(repo, base + 15_000)).dirty], ['committed.txt']);
  });

  it('keeps entries for other cwds, and drops all of them once 200 are cached', { timeout: 30_000 }, async () => {
    const { repo } = await makeRepo();
    const scratch = await mkdtemp(join(tmpdir(), 'cb-gitcache-'));
    madeDirs.push(scratch);
    const first = getGitState(repo, 0);
    await getGitState(join(scratch, 'none-0'), 0);
    assert.equal(getGitState(repo, 1), first);
    // repo と合わせて 200 件になるまで埋める（存在しないディレクトリなので git は即失敗する）
    await Promise.all(Array.from({ length: 198 }, (_, i) => getGitState(join(scratch, `none-${i + 1}`), 0)));
    assert.equal(getGitState(repo, 2), first);
    await getGitState(join(scratch, 'none-overflow'), 0);
    assert.notEqual(getGitState(repo, 3), first);
  });
});

describe('hasGitPush の細部', () => {
  it('区切りの直後・空白なしでも git push を拾う', () => {
    assert.equal(hasGitPush('make||git push'), true);
    assert.equal(hasGitPush('make&&git push'), true);
    assert.equal(hasGitPush('make;git push'), true);
    assert.equal(hasGitPush('echo x | git push'), true);
    assert.equal(hasGitPush('  git push'), true);
    assert.equal(hasGitPush('git   push'), true);
  });

  it('値を取るグローバルオプションを挟んでも拾う', () => {
    assert.equal(hasGitPush('git -c push.default=current push'), true);
    assert.equal(hasGitPush('git -C  /repo  push'), true);
    assert.equal(hasGitPush('git -C /repo -c a=b push'), true);
  });

  it('コマンドの位置にない git push は拾わない', () => {
    assert.equal(hasGitPush('echo git push'), false);
    assert.equal(hasGitPush('xgit push'), false);
    assert.equal(hasGitPush('git push-hooks'), false);
    assert.equal(hasGitPush('git push_x'), false);
  });

  it('dry-run の判定は同じ git push の引数だけを見る', () => {
    assert.equal(hasGitPush('git push origin && ls -n'), true);
    assert.equal(hasGitPush('git push origin || echo -n'), true);
    assert.equal(hasGitPush('git push origin; ls -n'), true);
    assert.equal(hasGitPush('git push origin | tee -n'), true);
    assert.equal(hasGitPush('(git push origin) -n'), true);
    assert.equal(hasGitPush('git push origin -n'), false);
    assert.equal(hasGitPush('git push --dry-runx'), true);
    assert.equal(hasGitPush('git push -nx'), true);
    assert.equal(hasGitPush('git push x-n'), true);
  });

  it('コメント行（字下げ・# の直後に区切りがあるものを含む）と引用符の中の区切りを無視する', () => {
    assert.equal(hasGitPush('#; git push'), false);
    assert.equal(hasGitPush('# 後で; git push'), false);
    assert.equal(hasGitPush('   # ; git push'), false);
    assert.equal(hasGitPush('echo "a; git push"'), false);
    assert.equal(hasGitPush('echo "esc \\" ; git push"'), false);
    assert.equal(hasGitPush("echo 'a && git push'"), false);
    // コメント行の後ろの行は普通に見る
    assert.equal(hasGitPush('# あとで\ngit push'), true);
  });

  it('語の途中の # はコメントとみなさない', () => {
    assert.equal(hasGitPush('ls a#b; git push'), true);
    assert.equal(hasGitPush('a#b; git push'), true);
  });

  it('<<- や引用符つきの終端のヒアドキュメントも本文を読み飛ばし、終端の後ろは見る', () => {
    assert.equal(hasGitPush(['cat <<-EOF', 'git push', '\tEOF'].join('\n')), false);
    // 字下げした終端で本文が終わり、その後ろの行は見る
    assert.equal(hasGitPush(['cat <<-EOF', 'echo', '\tEOF  ', 'git push'].join('\n')), true);
    assert.equal(hasGitPush(['cat << "END"', 'git push', 'END'].join('\n')), false);
    assert.equal(hasGitPush(['cat <<EOF', 'git push', 'EOF', 'git push'].join('\n')), true);
    assert.equal(hasGitPush(['cat <<EOF', 'EOFX', 'git push', 'EOF'].join('\n')), false);
    // 終端の無いヒアドキュメントは最後まで本文
    assert.equal(hasGitPush(['cat <<EOF', 'echo', 'git push'].join('\n')), false);
  });
});
