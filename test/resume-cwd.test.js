import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
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

describe('resolveResumeCwd: 入力の検証', () => {
  const opts = (onRead) => ({
    isDir: dirs('/repo'),
    readSummary: async () => {
      onRead?.();
      return { relocatedCwd: '/repo' };
    },
  });

  it('claudeSessionId は文字列で、末尾まで英数字・_・- だけのものに限る', async () => {
    for (const claudeSessionId of ['abc/..', 'abc\n', 123, undefined, '']) {
      let read = false;
      await assert.rejects(
        resolveResumeCwd(
          { cwd: '/gone', claudeSessionId, projectDir: '-repo' },
          opts(() => (read = true)),
        ),
        /作業ディレクトリが見つかりません/,
      );
      assert.equal(read, false, `claudeSessionId=${String(claudeSessionId)}`);
    }
  });

  it('サマリが読めなければ（null）見つからないエラー', async () => {
    await assert.rejects(
      resolveResumeCwd(
        { cwd: '/gone', claudeSessionId: 'abc', projectDir: '-repo' },
        { isDir: dirs('/repo'), readSummary: async () => null },
      ),
      /worktree が削除済みかもしれません/,
    );
  });

  it('relocatedCwd が空なら、それを確かめずに見つからないエラー', async () => {
    const checked = [];
    await assert.rejects(
      resolveResumeCwd(
        { cwd: '/gone', claudeSessionId: 'abc', projectDir: '-repo' },
        {
          // cwd 以外はどれも在ることにする
          isDir: async (p) => {
            checked.push(p);
            return p !== '/gone';
          },
          readSummary: async () => ({ relocatedCwd: '' }),
        },
      ),
      /作業ディレクトリが見つかりません/,
    );
    assert.deepEqual(checked, ['/gone']);
  });

  it('既定の isDir はファイルをディレクトリとみなさない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-resume-cwd-'));
    try {
      const file = join(dir, 'file.txt');
      await writeFile(file, 'x');
      await assert.rejects(
        resolveResumeCwd({ cwd: file, claudeSessionId: 'nope', projectDir: '-nope' }, { projectsDir: dir }),
        /作業ディレクトリが見つかりません/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isValidProjectDir', () => {
  it('rejects values with anything outside [\\w.-] at either end', () => {
    assert.equal(isValidProjectDir('a/'), false);
    assert.equal(isValidProjectDir('/a'), false);
    assert.equal(isValidProjectDir('a b'), false);
    assert.equal(isValidProjectDir('.x'), true);
    assert.equal(isValidProjectDir(123), false);
  });

  it('accepts a single path segment only', () => {
    assert.equal(isValidProjectDir('-home-user-repo'), true);
    assert.equal(isValidProjectDir('..foo'), false);
    assert.equal(isValidProjectDir('a/b'), false);
    assert.equal(isValidProjectDir(null), false);
  });
});
