import { describe, it, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';

// child_process.exec をモック。コマンドごとに stdout を出し分ける
// （実際の tmux には一切触れない。kill-pane が呼ばれたかは execCalls で見る）
const execCalls = [];
let responses = {};

function stdoutFor(cmd) {
  for (const [pattern, value] of Object.entries(responses)) {
    if (cmd.includes(pattern)) return value;
  }
  return '';
}

vi.mock('child_process', () => ({
  exec: (cmd, cb) => {
    execCalls.push(cmd);
    const value = stdoutFor(cmd);
    if (value instanceof Error) {
      cb(value);
    } else {
      cb(null, { stdout: value, stderr: '' });
    }
  },
}));

const { killClaudePane } = await import('../server/tmux-session.js');

const killCalls = () => execCalls.filter((c) => c.includes('kill-pane'));

// findSessions / readPids の差し替え。paneId -> meta の Map を返す
function deps({ metas = {}, livePids = new Set([100]) } = {}) {
  const calls = [];
  return {
    calls,
    findSessions: async (paneIds, opts) => {
      calls.push({ paneIds, opts });
      return new Map(Object.entries(metas).filter(([paneId]) => paneIds.includes(paneId)));
    },
    readPids: async () => livePids,
  };
}

describe('killClaudePane', () => {
  beforeEach(() => {
    execCalls.length = 0;
    responses = {};
  });

  it('kills the pane when the claude session matches the status file', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'abc-123', paneId: '%7' } } });

    await killClaudePane({ paneId: '%7', claudeSessionId: 'abc-123' }, d);

    assert.deepEqual(killCalls(), ['tmux kill-pane -t %7']);
    // 照合（display-message）の後に kill している
    const lastCall = execCalls[execCalls.length - 1];
    assert.equal(lastCall, 'tmux kill-pane -t %7');
    assert.ok(execCalls.findIndex((c) => c.includes('display-message')) < execCalls.length - 1);
    assert.deepEqual(d.calls[0].paneIds, ['%7']);
    assert.deepEqual(d.calls[0].opts.livePids, new Set([100]));
  });

  it('accepts the macOS version-number command name', async () => {
    responses = { 'display-message': '2.1.100\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'abc', paneId: '%7' } } });

    await killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, d);

    assert.equal(killCalls().length, 1);
  });

  it('kills by claude pid when claudeSessionId is unresolved', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%3': { pid: 100, sessionId: 'abc', paneId: '%3' } } });

    const killed = await killClaudePane({ paneId: '%3', expectedPid: 100 }, d);

    assert.deepEqual(killCalls(), ['tmux kill-pane -t %3']);
    assert.equal(killed.sessionId, 'abc');
  });

  it('does not kill when the claude pid in the pane differs (paneId reassigned)', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%3': { pid: 200, sessionId: 'unrelated', paneId: '%3' } } });

    await assert.rejects(killClaudePane({ paneId: '%3', expectedPid: 100 }, d), /別のセッション/);
    assert.equal(killCalls().length, 0);
  });

  it('refuses without either claudeSessionId or expectedPid', async () => {
    responses = { 'display-message': 'claude\n' };

    await assert.rejects(killClaudePane({ paneId: '%3' }, deps()), /セッション ID も pid も分からない/);
    await assert.rejects(
      killClaudePane({ paneId: '%3', claudeSessionId: null, expectedPid: null }, deps()),
      /pid も分からない/,
    );
    assert.equal(execCalls.length, 0);
  });

  it('rejects a non-integer expectedPid without running tmux', async () => {
    await assert.rejects(killClaudePane({ paneId: '%3', expectedPid: '100; id' }, deps()), /Invalid expectedPid/);
    assert.equal(execCalls.length, 0);
  });

  it('rejects an invalid paneId without running tmux', async () => {
    for (const paneId of ['7', '%7; tmux kill-server', 'x%7', '', undefined, '$(whoami)']) {
      await assert.rejects(killClaudePane({ paneId, claudeSessionId: 'abc' }, deps()), /Invalid paneId/);
    }
    assert.equal(execCalls.length, 0);
  });

  it('rejects an invalid claudeSessionId without running tmux', async () => {
    for (const claudeSessionId of ['../x', 'a b', '$(id)', 123]) {
      await assert.rejects(killClaudePane({ paneId: '%7', claudeSessionId }, deps()), /Invalid claudeSessionId/);
    }
    assert.equal(execCalls.length, 0);
  });

  it('does not kill when another session runs in the pane', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'other', paneId: '%7' } } });

    await assert.rejects(killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, d), /別のセッション/);
    assert.equal(killCalls().length, 0);
  });

  it('does not kill when no live status file points at the pane', async () => {
    responses = { 'display-message': 'claude\n' };

    await assert.rejects(killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, deps()), /別のセッション/);
    assert.equal(killCalls().length, 0);
  });

  it('does not kill when the pane is not running claude', async () => {
    responses = { 'display-message': 'zsh\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'abc', paneId: '%7' } } });

    await assert.rejects(killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, d), /claude が動いていない/);
    await assert.rejects(killClaudePane({ paneId: '%7', expectedPid: 100 }, d), /claude が動いていない/);
    assert.equal(killCalls().length, 0);
  });

  it('does not kill when the pane command cannot be read', async () => {
    responses = { 'display-message': new Error("can't find pane: %7") };

    await assert.rejects(killClaudePane({ paneId: '%7', expectedPid: 100 }, deps()), /取得できず/);
    assert.equal(killCalls().length, 0);
  });

  it('does not kill when liveness cannot be checked (ps unavailable)', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'abc', paneId: '%7' } }, livePids: null });

    await assert.rejects(killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, d), /生存確認/);
    assert.equal(killCalls().length, 0);
  });

  it('propagates a kill-pane failure', async () => {
    responses = { 'display-message': 'claude\n', 'kill-pane': new Error('pane gone') };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'abc', paneId: '%7' } } });

    await assert.rejects(killClaudePane({ paneId: '%7', expectedPid: 100 }, d), /pane gone/);
  });

  it('claudeSessionId があれば pid が一致しても sessionId で照合する', async () => {
    responses = { 'display-message': 'claude\n' };
    const d = deps({ metas: { '%7': { pid: 100, sessionId: 'other', paneId: '%7' } } });

    await assert.rejects(
      killClaudePane({ paneId: '%7', claudeSessionId: 'abc', expectedPid: 100 }, d),
      /ペイン %7 で動いているのは別のセッションのため終了しませんでした/,
    );
    assert.equal(killCalls().length, 0);
  });

  it('照合に通ったセッションメタを返す', async () => {
    responses = { 'display-message': 'claude\n' };
    const meta = { pid: 100, sessionId: 'abc', paneId: '%7' };

    assert.equal(await killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, deps({ metas: { '%7': meta } })), meta);
  });

  it('claude でない前景コマンドの名前をエラーに含める', async () => {
    responses = { 'display-message': 'vim\n' };

    await assert.rejects(
      killClaudePane({ paneId: '%7', claudeSessionId: 'abc' }, deps()),
      /ペイン %7 で claude が動いていないため終了しませんでした（vim）/,
    );
  });

  it('前景コマンドはそのペインの pane_current_command を読む', async () => {
    responses = { 'display-message': 'claude\n' };
    await killClaudePane({ paneId: '%7', expectedPid: 100 }, deps({ metas: { '%7': { pid: 100, sessionId: 'x' } } }));
    assert.equal(execCalls[0], "tmux display-message -p -t %7 '#{pane_current_command}'");
  });

  it('空文字の claudeSessionId は不正として扱う', async () => {
    await assert.rejects(
      killClaudePane({ paneId: '%7', claudeSessionId: '', expectedPid: 100 }, deps()),
      /Invalid claudeSessionId/,
    );
    assert.equal(execCalls.length, 0);
  });

  it('不正な値をエラーに含める', async () => {
    await assert.rejects(killClaudePane({ paneId: '%7', expectedPid: 1.5 }, deps()), /Invalid expectedPid: 1\.5/);
    await assert.rejects(
      killClaudePane({ paneId: '%7', claudeSessionId: 'a b' }, deps()),
      /Invalid claudeSessionId: a b/,
    );
  });

  it('依存を省くと本物の生存確認を使う（ここでは前景コマンドの確認で止まる）', async () => {
    responses = { 'display-message': 'zsh\n' };
    await assert.rejects(killClaudePane({ paneId: '%7', expectedPid: 100 }), /claude が動いていない/);
    await assert.rejects(killClaudePane(), /Invalid paneId/);
  });
});
