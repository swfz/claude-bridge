import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSessionCompletionCache,
  hasGitPush,
  parsePorcelainZ,
  readSessionCompletion,
  readSessionEditedFiles,
  readSessionPushes,
  toRepoRelative,
} from '../server/session-completion.js';

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

async function makeSession(records, { subagents = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-completion-'));
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
});
