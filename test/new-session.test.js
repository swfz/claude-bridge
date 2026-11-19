import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// 本物の git を叩かないよう execFile をモックする（isGitRepo の既定の run が使う）
const execFileCalls = [];
let execFileResult = { err: null, stdout: '' };

vi.mock('child_process', () => ({
  // tmux-session.js などが import 時に参照するだけ。呼ばれたら失敗させる
  exec: (cmd, cb) => cb(new Error(`exec is not allowed in this test: ${cmd}`)),
  execFile: (cmd, args, opts, cb) => {
    execFileCalls.push({ cmd, args, opts });
    cb(execFileResult.err, execFileResult.stdout);
  },
}));

const {
  buildNewSessionArgs,
  normalizePrompt,
  ptyArgs,
  tmuxCommand,
  writePromptFile,
  isGitRepo,
  waitForSessionCwd,
  waitForSessionCwdById,
  WORKTREE_NAME_RE,
  MODEL_RE,
  PROMPT_MAX,
} = await import('../server/new-session.js');

const created = [];
async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  execFileCalls.length = 0;
  execFileResult = { err: null, stdout: '' };
  while (created.length) await rm(created.pop(), { recursive: true, force: true });
});

describe('buildNewSessionArgs', () => {
  it('引数なしでも空の配列を返す', () => {
    assert.deepEqual(buildNewSessionArgs(), []);
  });

  it('モデル名の前後の空白を落として渡し、空白だけなら付けない', () => {
    assert.deepEqual(buildNewSessionArgs({ model: '  sonnet  ' }), ['--model', 'sonnet']);
    assert.deepEqual(buildNewSessionArgs({ model: '   ' }), []);
    assert.deepEqual(buildNewSessionArgs({ model: 123 }), []);
  });

  it('不正なモデル名はモデル名を添えたエラーにする', () => {
    assert.throws(() => buildNewSessionArgs({ model: 'a b' }), /モデル名が不正です: a b/);
  });

  it('worktree が偽なら worktree 名は見ない', () => {
    assert.deepEqual(buildNewSessionArgs({ worktree: false, worktreeName: '../x' }), []);
  });

  it('worktree 名が文字列でなければ名前なしの -w にする', () => {
    assert.deepEqual(buildNewSessionArgs({ worktree: true, worktreeName: 42 }), ['-w']);
    assert.deepEqual(buildNewSessionArgs({ worktree: true, worktreeName: '   ' }), ['-w']);
  });

  it('不正な worktree 名は使える文字を示すエラーにする', () => {
    assert.throws(
      () => buildNewSessionArgs({ worktree: true, worktreeName: 'a/b' }),
      /worktree 名は英数字と \. _ - だけ（64 文字まで）にしてください/,
    );
  });

  it('全部指定すると session-id・model・-w の順に並べる', () => {
    assert.deepEqual(buildNewSessionArgs({ sessionId: 's', model: 'opus', worktree: true, worktreeName: 'w' }), [
      '--session-id',
      's',
      '--model',
      'opus',
      '-w',
      'w',
    ]);
  });
});

describe('WORKTREE_NAME_RE', () => {
  it('英数字で始まる 64 文字までの名前だけ通す', () => {
    assert.equal(WORKTREE_NAME_RE.test('a'), true);
    assert.equal(WORKTREE_NAME_RE.test('A9._-z'), true);
    assert.equal(WORKTREE_NAME_RE.test('a'.repeat(64)), true);
    assert.equal(WORKTREE_NAME_RE.test('a'.repeat(65)), false);
    assert.equal(WORKTREE_NAME_RE.test('.hidden'), false);
    assert.equal(WORKTREE_NAME_RE.test('_x'), false);
    assert.equal(WORKTREE_NAME_RE.test('ok\nbad'), false);
    assert.equal(WORKTREE_NAME_RE.test('bad name'), false);
  });
});

describe('MODEL_RE', () => {
  it('英数字で始まり、英数字と _ . [ ] - だけの 64 文字までを通す', () => {
    assert.equal(MODEL_RE.test('claude-opus-5-5'), true);
    assert.equal(MODEL_RE.test('opus[1m]'), true);
    assert.equal(MODEL_RE.test('a_b.c'), true);
    assert.equal(MODEL_RE.test('a'.repeat(64)), true);
    assert.equal(MODEL_RE.test('a'.repeat(65)), false);
    assert.equal(MODEL_RE.test('[1m]'), false);
    assert.equal(MODEL_RE.test('_opus'), false);
    assert.equal(MODEL_RE.test('opus\nx'), false);
    assert.equal(MODEL_RE.test('opus$'), false);
  });
});

describe('normalizePrompt', () => {
  it('文字列でなければ null', () => {
    assert.equal(normalizePrompt(undefined), null);
    assert.equal(normalizePrompt(42), null);
  });

  it('前後の空白を落として返す', () => {
    assert.equal(normalizePrompt('  やって  '), 'やって');
  });

  it(`${PROMPT_MAX} 文字ちょうどは通し、超えたら上限を添えたエラー`, () => {
    assert.equal(PROMPT_MAX, 20000);
    assert.equal(normalizePrompt('a'.repeat(PROMPT_MAX)).length, PROMPT_MAX);
    assert.throws(() => normalizePrompt('a'.repeat(PROMPT_MAX + 1)), /最初の指示が長すぎます（20000 文字まで）/);
  });
});

describe('ptyArgs / tmuxCommand', () => {
  it('空文字の指示は付けない', () => {
    assert.deepEqual(ptyArgs(['-w'], ''), ['-w']);
  });

  it('引数も指示ファイルも無ければ claude だけ', () => {
    assert.equal(tmuxCommand([], null), 'claude');
  });
});

describe('writePromptFile', () => {
  it('prompts ディレクトリを作り、<id>.txt に書く', async () => {
    const dir = await makeDir('cb-prompt-');
    const file = await writePromptFile(join(dir, 'nested'), 'u-1', 'x');
    assert.equal(file, join(dir, 'nested', 'prompts', 'u-1.txt'));
    assert.equal((await stat(join(dir, 'nested', 'prompts'))).mode & 0o777, 0o700);
  });
});

describe('isGitRepo（既定の run）', () => {
  it('git rev-parse を cwd で 10 秒の timeout 付きで呼び、true なら真', async () => {
    execFileResult = { err: null, stdout: 'true\n' };
    assert.equal(await isGitRepo('/repo'), true);
    assert.deepEqual(execFileCalls, [
      { cmd: 'git', args: ['rev-parse', '--is-inside-work-tree'], opts: { cwd: '/repo', timeout: 10000 } },
    ]);
  });

  it('出力が true 以外なら偽', async () => {
    execFileResult = { err: null, stdout: 'false\n' };
    assert.equal(await isGitRepo('/repo'), false);
  });

  it('git が失敗したら偽', async () => {
    execFileResult = { err: new Error('fatal: not a git repository'), stdout: '' };
    assert.equal(await isGitRepo('/repo'), false);
  });
});

describe('waitForSessionCwd', () => {
  it('cwd が文字列でない・壊れたファイルは待ち続け、worktree の cwd になったら返す', async () => {
    const dir = await makeDir('cb-sess-');
    await writeFile(join(dir, '42.json'), '{broken');
    setTimeout(() => writeFile(join(dir, '42.json'), JSON.stringify({ cwd: ['/.claude/worktrees/'] })), 20);
    setTimeout(() => writeFile(join(dir, '42.json'), JSON.stringify({ cwd: '/r/.claude/worktrees/w' })), 60);
    assert.equal(await waitForSessionCwd(42, { dir, intervalMs: 5, timeoutMs: 2000 }), '/r/.claude/worktrees/w');
  });

  it('他の pid のファイルは見ない', async () => {
    const dir = await makeDir('cb-sess-');
    await writeFile(join(dir, '1.json'), JSON.stringify({ cwd: '/r/.claude/worktrees/x' }));
    assert.equal(await waitForSessionCwd(2, { dir, intervalMs: 5, timeoutMs: 40 }), null);
  });

  it('timeout を待ってから null を返す', async () => {
    const dir = await makeDir('cb-sess-');
    const t0 = Date.now();
    assert.equal(await waitForSessionCwd(1, { dir, intervalMs: 5, timeoutMs: 60 }), null);
    assert.ok(Date.now() - t0 >= 50);
  });
});

describe('waitForSessionCwdById', () => {
  it('ディレクトリがまだ無くても待ち、作られたら拾う', async () => {
    const base = await makeDir('cb-sess-');
    const dir = join(base, 'sessions');
    setTimeout(async () => {
      await mkdir(dir);
      await writeFile(join(dir, '9.json'), JSON.stringify({ sessionId: 'me', cwd: '/r/.claude/worktrees/z' }));
    }, 30);
    assert.equal(await waitForSessionCwdById('me', { dir, intervalMs: 5, timeoutMs: 2000 }), '/r/.claude/worktrees/z');
  });

  it('.json 以外・壊れたファイル・worktree でない cwd・文字列でない cwd は無視して null', async () => {
    const dir = await makeDir('cb-sess-');
    await writeFile(join(dir, '1.txt'), JSON.stringify({ sessionId: 'me', cwd: '/r/.claude/worktrees/a' }));
    await writeFile(join(dir, '2.json'), '{broken');
    await writeFile(join(dir, '3.json'), JSON.stringify({ sessionId: 'me', cwd: '/r' }));
    await writeFile(join(dir, '4.json'), JSON.stringify({ sessionId: 'me', cwd: ['/.claude/worktrees/'] }));
    await writeFile(join(dir, '5.json'), JSON.stringify({ sessionId: 'other', cwd: '/r/.claude/worktrees/c' }));
    const t0 = Date.now();
    assert.equal(await waitForSessionCwdById('me', { dir, intervalMs: 5, timeoutMs: 60 }), null);
    assert.ok(Date.now() - t0 >= 50);
  });

  it('壊れたファイルがあっても後ろのファイルは読む', async () => {
    const dir = await makeDir('cb-sess-');
    await writeFile(join(dir, '1.json'), '{broken');
    await writeFile(join(dir, '2.json'), JSON.stringify({ sessionId: 'me', cwd: '/r/.claude/worktrees/ok' }));
    assert.equal(await waitForSessionCwdById('me', { dir, intervalMs: 5, timeoutMs: 2000 }), '/r/.claude/worktrees/ok');
  });
});
