import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveResumeCwd, isValidProjectDir } from '../server/resume-cwd.js';

const dirs =
  (...existing) =>
  async (p) =>
    existing.includes(p);

describe('resolveResumeCwd', () => {
  it('returns the cwd as is when it exists', async () => {
    let read = false;
    const result = await resolveResumeCwd(
      { cwd: '/repo', claudeSessionId: 'abc', projectDir: '-repo' },
      {
        isDir: dirs('/repo'),
        readSummary: async () => {
          read = true;
          return {};
        },
      },
    );
    assert.deepEqual(result, { cwd: '/repo', relocated: false });
    assert.equal(read, false);
  });

  it('falls back to relocatedCwd from the JSONL when the worktree is gone', async () => {
    let readPath = null;
    const result = await resolveResumeCwd(
      { cwd: '/repo/.claude/worktrees/x', claudeSessionId: 'abc-1', projectDir: '-repo' },
      {
        isDir: dirs('/repo'),
        projectsDir: '/projects',
        readSummary: async (p) => {
          readPath = p;
          return { relocatedCwd: '/repo' };
        },
      },
    );
    assert.deepEqual(result, { cwd: '/repo', relocated: true, originalCwd: '/repo/.claude/worktrees/x' });
    assert.equal(readPath, join('/projects', '-repo', 'abc-1.jsonl'));
  });

  it('throws when the JSONL has no relocated cwd', async () => {
    await assert.rejects(
      resolveResumeCwd(
        { cwd: '/gone', claudeSessionId: 'abc', projectDir: '-repo' },
        { isDir: dirs(), readSummary: async () => ({ relocatedCwd: '' }) },
      ),
      /作業ディレクトリが見つかりません: \/gone/,
    );
  });

  it('throws when the relocated cwd is also gone', async () => {
    await assert.rejects(
      resolveResumeCwd(
        { cwd: '/gone', claudeSessionId: 'abc', projectDir: '-repo' },
        { isDir: dirs(), readSummary: async () => ({ relocatedCwd: '/also-gone' }) },
      ),
      /作業ディレクトリが見つかりません/,
    );
  });

  it('throws without reading the JSONL when projectDir is invalid', async () => {
    for (const projectDir of ['../etc', '..', 'a/b', '', undefined]) {
      let read = false;
      await assert.rejects(
        resolveResumeCwd(
          { cwd: '/gone', claudeSessionId: 'abc', projectDir },
          {
            isDir: dirs('/repo'),
            readSummary: async () => {
              read = true;
              return { relocatedCwd: '/repo' };
            },
          },
        ),
        /作業ディレクトリが見つかりません/,
      );
      assert.equal(read, false, `projectDir=${projectDir}`);
    }
  });

  it('throws when claudeSessionId is invalid', async () => {
    await assert.rejects(
      resolveResumeCwd(
        { cwd: '/gone', claudeSessionId: '../x', projectDir: '-repo' },
        { isDir: dirs('/repo'), readSummary: async () => ({ relocatedCwd: '/repo' }) },
      ),
      /作業ディレクトリが見つかりません/,
    );
  });

  it('checks real directories with the default isDir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-resume-cwd-'));
    assert.deepEqual(await resolveResumeCwd({ cwd: dir }), { cwd: dir, relocated: false });
    await assert.rejects(
      resolveResumeCwd(
        { cwd: join(dir, 'missing'), claudeSessionId: 'nope', projectDir: '-nope' },
        { projectsDir: dir },
      ),
      /作業ディレクトリが見つかりません/,
    );
  });
});

describe('isValidProjectDir', () => {
  it('accepts a single path segment only', () => {
    assert.equal(isValidProjectDir('-home-user-repo'), true);
    assert.equal(isValidProjectDir('..foo'), false);
    assert.equal(isValidProjectDir('a/b'), false);
    assert.equal(isValidProjectDir(null), false);
  });
});
