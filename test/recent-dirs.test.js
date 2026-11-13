import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRecentDirs, projectRootOf } from '../server/claude-sessions.js';
import {
  buildNewSessionArgs,
  isGitRepo,
  normalizePrompt,
  ptyArgs,
  tmuxCommand,
  waitForSessionCwd,
  waitForSessionCwdById,
  writePromptFile,
} from '../server/new-session.js';
import { readFile, stat } from 'fs/promises';
import { displayDir, expandHome, filterDirSuggestions, defaultSessionName } from '../client/src/utils/recentDirs.js';

const DAY = 24 * 60 * 60 * 1000;

describe('listRecentDirs', () => {
  it('returns unique existing cwds within the period, most recent first, with counts', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'cb-dirs-'));
    const work = await mkdtemp(join(tmpdir(), 'cb-work-'));
    const repoA = join(work, 'my-repo');
    const repoB = join(work, 'other');
    await mkdir(repoA);
    await mkdir(repoB);
    const entries = [
      { projectDir: 'pa', id: 'a1', cwd: repoA, daysAgo: 1 },
      { projectDir: 'pa', id: 'a2', cwd: repoA, daysAgo: 5 },
      { projectDir: 'pb', id: 'b1', cwd: repoB, daysAgo: 0.1 },
      { projectDir: 'pc', id: 'c1', cwd: join(work, 'gone'), daysAgo: 0.2 }, // 消えたディレクトリ
      { projectDir: 'pd', id: 'd1', cwd: repoB + '-old', daysAgo: 100 }, // 期間外
    ];
    for (const e of entries) {
      await mkdir(join(projects, e.projectDir), { recursive: true });
      const file = join(projects, e.projectDir, `${e.id}.jsonl`);
      await writeFile(file, JSON.stringify({ type: 'user', cwd: e.cwd, message: { content: 'x' } }) + '\n');
      const at = new Date(Date.now() - e.daysAgo * DAY);
      await utimes(file, at, at);
    }
    const dirs = await listRecentDirs({ days: 90, dir: projects });
    assert.deepEqual(
      dirs.map((d) => [d.cwd, d.count]),
      [
        [repoB, 1],
        [repoA, 2],
      ],
    );
  });
});

describe('projectRootOf', () => {
  it('folds worktrees into the repo root and drops scratchpads', () => {
    assert.equal(projectRootOf('/home/me/repo'), '/home/me/repo');
    assert.equal(projectRootOf('/home/me/repo/.claude/worktrees/foo'), '/home/me/repo');
    assert.equal(projectRootOf('/home/me/repo/.claude/worktrees/foo/sub'), '/home/me/repo');
    assert.equal(projectRootOf('/tmp/claude-1000/-home-me/abc/scratchpad'), null);
    assert.equal(projectRootOf('relative'), null);
  });
});

describe('buildNewSessionArgs', () => {
  it('builds -w args and rejects unsafe names', () => {
    assert.deepEqual(buildNewSessionArgs({}), []);
    assert.deepEqual(buildNewSessionArgs({ worktree: true }), ['-w']);
    assert.deepEqual(buildNewSessionArgs({ worktree: true, worktreeName: ' feat-x ' }), ['-w', 'feat-x']);
    assert.throws(() => buildNewSessionArgs({ worktree: true, worktreeName: '../x' }));
    assert.throws(() => buildNewSessionArgs({ worktree: true, worktreeName: '-rf' }));
  });
});

describe('new session options', () => {
  it('adds --session-id and --model, rejects odd model names', () => {
    assert.deepEqual(buildNewSessionArgs({ model: 'opus[1m]', sessionId: 'u-1' }), [
      '--session-id',
      'u-1',
      '--model',
      'opus[1m]',
    ]);
    assert.throws(() => buildNewSessionArgs({ model: 'opus; rm -rf /' }));
    assert.throws(() => buildNewSessionArgs({ model: '--dangerously-skip-permissions' }));
  });

  it('puts the prompt after -- so -w does not swallow it', () => {
    assert.deepEqual(ptyArgs(['-w'], '-x やって'), ['-w', '--', '-x やって']);
    assert.deepEqual(ptyArgs(['-w'], null), ['-w']);
    assert.equal(normalizePrompt('  '), null);
    assert.throws(() => normalizePrompt('a'.repeat(20001)));
  });

  it('builds a shell-safe tmux command reading the prompt from a file', () => {
    assert.equal(tmuxCommand(['--model', "it's"], null), "claude '--model' 'it'\\''s'");
    assert.equal(
      tmuxCommand(['-w'], '/d/prompts/u.txt'),
      `claude '-w' -- "$(cat '/d/prompts/u.txt'; rm -f '/d/prompts/u.txt')"`,
    );
  });

  it('writes the prompt file with 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-prompt-'));
    const file = await writePromptFile(dir, 'abc', '1行目\n2行目');
    assert.equal(await readFile(file, 'utf8'), '1行目\n2行目');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('finds the worktree cwd by session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sess-'));
    await writeFile(join(dir, '1.json'), JSON.stringify({ sessionId: 'other', cwd: '/r/.claude/worktrees/x' }));
    await writeFile(join(dir, '2.json'), JSON.stringify({ sessionId: 'me', cwd: '/r' }));
    setTimeout(
      () => writeFile(join(dir, '2.json'), JSON.stringify({ sessionId: 'me', cwd: '/r/.claude/worktrees/y' })),
      30,
    );
    assert.equal(await waitForSessionCwdById('me', { dir, intervalMs: 10, timeoutMs: 2000 }), '/r/.claude/worktrees/y');
  });
});

describe('isGitRepo', () => {
  it('treats command failure as not a repo', async () => {
    assert.equal(await isGitRepo('/x', { run: async () => 'true\n' }), true);
    assert.equal(
      await isGitRepo('/x', {
        run: async () => {
          throw new Error('fatal');
        },
      }),
      false,
    );
  });
});

describe('waitForSessionCwd', () => {
  it('waits until the status file cwd is a worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sess-'));
    await writeFile(join(dir, '42.json'), JSON.stringify({ pid: 42, cwd: '/repo' }));
    setTimeout(
      () => writeFile(join(dir, '42.json'), JSON.stringify({ pid: 42, cwd: '/repo/.claude/worktrees/w' })),
      30,
    );
    const cwd = await waitForSessionCwd(42, { dir, intervalMs: 10, timeoutMs: 2000 });
    assert.equal(cwd, '/repo/.claude/worktrees/w');
  });

  it('returns null on timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sess-'));
    assert.equal(await waitForSessionCwd(1, { dir, intervalMs: 5, timeoutMs: 30 }), null);
  });
});

describe('recentDirs utils', () => {
  const home = '/home/me';
  const dirs = [
    { cwd: '/home/me/gh/claude-bridge' },
    { cwd: '/home/me/work/bridge-app' },
    { cwd: '/home/me/gh/dotfiles' },
    { cwd: '/tmp/scratch' },
  ];

  it('folds and expands home', () => {
    assert.equal(displayDir('/home/me/gh/x', home), '~/gh/x');
    assert.equal(displayDir('/home/me', home), '~');
    assert.equal(displayDir('/home/meow', home), '/home/meow');
    assert.equal(expandHome('~/gh/x', home), '/home/me/gh/x');
    assert.equal(expandHome('~', home), home);
    assert.equal(expandHome('/abs', home), '/abs');
  });

  it('returns all (in server order) for empty query', () => {
    assert.equal(filterDirSuggestions(dirs, '', { home }).length, 4);
  });

  it('ranks basename prefix matches first and supports multiple terms and ~', () => {
    assert.deepEqual(
      filterDirSuggestions(dirs, 'bridge', { home }).map((d) => d.cwd),
      ['/home/me/work/bridge-app', '/home/me/gh/claude-bridge'],
    );
    assert.deepEqual(
      filterDirSuggestions(dirs, 'gh bri', { home }).map((d) => d.cwd),
      ['/home/me/gh/claude-bridge'],
    );
    assert.deepEqual(
      filterDirSuggestions(dirs, '~/gh/d', { home }).map((d) => d.cwd),
      ['/home/me/gh/dotfiles'],
    );
  });

  it('derives a default session name from the directory', () => {
    assert.equal(defaultSessionName(''), 'New Session');
    assert.equal(defaultSessionName('~'), 'New Session');
    assert.equal(defaultSessionName('~/gh/claude-bridge/'), 'claude-bridge');
  });
});
