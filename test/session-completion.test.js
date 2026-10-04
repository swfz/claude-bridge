import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSessionCompletionCache,
  parsePorcelainZ,
  readSessionCompletion,
  readSessionEditedFiles,
  toRepoRelative,
} from '../server/session-completion.js';

const execAsync = promisify(exec);
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const toolUse = (name, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] },
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

describe('readSessionCompletion', () => {
  beforeEach(() => clearSessionCompletionCache());

  it("reports 'none' when the session edited nothing", async () => {
    const filePath = await makeSession([toolUse('Read', { file_path: '/r/a.js' })]);
    const result = await readSessionCompletion({ filePath, cwd: '/r' });
    assert.deepEqual(result, { edited: 0, git: 'none', uncommitted: [], uncommittedCount: 0 });
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
});
