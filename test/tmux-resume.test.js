import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// child_process.exec をモック。コマンドごとに stdout を出し分ける
const execCalls = [];
let responses = {};

// パターンの値は文字列/Error に加え、呼ばれるたびに再評価したい場合は関数も許可する
// （sendCommandWhenShellReady のポーリングで capture-pane の返り値を変化させるテスト用）
function stdoutFor(cmd) {
  for (const [pattern, value] of Object.entries(responses)) {
    if (cmd.includes(pattern)) return typeof value === 'function' ? value(cmd) : value;
  }
  return '';
}

mock.module('child_process', {
  namedExports: {
    exec: (cmd, cb) => {
      execCalls.push(cmd);
      const value = stdoutFor(cmd);
      if (value instanceof Error) {
        cb(value);
      } else {
        cb(null, { stdout: value, stderr: '' });
      }
    },
  },
});

const { pickTargetSession, buildResumeWindowName, resumeInTmuxWindow, sendCommandWhenShellReady } =
  await import('../server/tmux-session.js');

describe('pickTargetSession', () => {
  it('picks the most recently attached session', () => {
    const stdout = ['1700000000\tolder', '1700009999\tnewer', '0\tnever'].join('\n');

    assert.equal(pickTargetSession(stdout), 'newer');
  });

  it('falls back to a never-attached session when it is the only one', () => {
    assert.equal(pickTargetSession('0\tdetached-only'), 'detached-only');
  });

  it('returns null for empty output (no tmux server)', () => {
    assert.equal(pickTargetSession(''), null);
    assert.equal(pickTargetSession(undefined), null);
  });

  it('skips session names that would be unsafe in a shell command', () => {
    const stdout = ['9999\t$(whoami)', '1\tsafe-name'].join('\n');

    assert.equal(pickTargetSession(stdout), 'safe-name');
  });
});

describe('buildResumeWindowName', () => {
  it('uses the first 8 chars of the session id', () => {
    assert.equal(buildResumeWindowName('3c8041cb-8c4f-44fe-9749-80548eb022be'), 'claude-3c8041cb');
  });

  it('strips characters outside [\\w-]', () => {
    // `;` `空白` `/` は落ち、`-` は tmux の window 名として安全なので残る
    assert.equal(buildResumeWindowName('ab;rm -rf/cd'), 'claude-abrm-rfc');
  });
});

describe('resumeInTmuxWindow', () => {
  beforeEach(() => {
    execCalls.length = 0;
    responses = {};
  });

  it('adds a window to the most recently attached session and sends the resume command', async () => {
    responses = {
      'list-sessions': '100\told-sess\n900\tmain-sess\n',
      'new-window': '%7\tmain-sess:3.0\n',
      'capture-pane': 'claude --resume abc-123\n',
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: 'abc-123',
      cwd: '/home/user/my project',
    });

    assert.deepEqual(pane, {
      paneId: '%7',
      target: 'main-sess:3.0',
      sessionName: 'main-sess',
      windowName: 'claude-abc-123',
    });

    const newWindow = execCalls.find((c) => c.includes('new-window'));
    // 末尾 `:` でセッション指定に固定する（数字だけの名前が window index と解釈されないように）
    assert.ok(newWindow.includes("-t 'main-sess:'"));
    assert.ok(newWindow.includes("-n 'claude-abc-123'"));
    // cwd はシングルクォートでエスケープされる（空白を含んでも壊れない）
    assert.ok(newWindow.includes("-c '/home/user/my project'"));

    const sendKeys = execCalls.find((c) => c.includes('send-keys -t %7 -l'));
    assert.ok(sendKeys.includes('claude --resume abc-123'));
    assert.ok(execCalls.some((c) => c === 'tmux send-keys -t %7 Enter'));
  });

  it('targets a purely numeric session name as a session, not a window index', async () => {
    // セッション名が「0」のような数字だけの場合、`-t 0` は window index 0 と
    // 解釈され "index 0 in use" で失敗する（実際に起きた回帰）
    responses = {
      'list-sessions': '900\t0\n',
      'new-window': '%3\t0:2.0\n',
      'capture-pane': 'claude --resume abc-123\n',
    };

    const pane = await resumeInTmuxWindow({ claudeSessionId: 'abc-123', cwd: '/tmp/work' });

    const newWindow = execCalls.find((c) => c.includes('new-window'));
    assert.ok(newWindow.includes("-t '0:'"));
    assert.equal(pane.sessionName, '0');
  });

  it('creates a fallback session when no tmux server is running', async () => {
    responses = {
      'list-sessions': new Error('no server running on /tmp/tmux-1000/default'),
      'new-session': '%0\tbridge:0.0\n',
      'capture-pane': 'claude --resume def-456\n',
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: 'def-456',
      cwd: '/tmp/work',
    });

    assert.equal(pane.sessionName, 'bridge');
    assert.equal(pane.paneId, '%0');
    const created = execCalls.find((c) => c.includes('new-session'));
    assert.ok(created.includes('-d -s bridge'));
    // 初期 window をそのまま使うので new-window は呼ばない（空 window を残さない）
    assert.ok(!execCalls.some((c) => c.includes('new-window')));
  });

  it('rejects a session id that could be injected into the shell', async () => {
    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: 'abc; rm -rf /', cwd: '/tmp' }),
      /Invalid claudeSessionId/,
    );
    assert.equal(execCalls.length, 0);
  });

  it('rejects a pane id that is not in %<digits> form', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': 'bogus-pane\tmain:1.0\n',
    };

    await assert.rejects(() => resumeInTmuxWindow({ claudeSessionId: 'abc', cwd: '/tmp' }), /Invalid paneId/);
  });

  it('reports a missing tmux binary without the raw command', async () => {
    responses = {
      'list-sessions': new Error('/bin/sh: 1: tmux: not found'),
      'new-session': new Error('/bin/sh: 1: tmux: not found'),
    };

    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: 'abc', cwd: '/tmp' }),
      /tmux コマンドが見つかりません/,
    );
  });

  it('surfaces a tmux failure as an error', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': new Error("can't find session"),
    };

    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: 'abc', cwd: '/tmp' }),
      /tmux window の作成に失敗しました/,
    );
  });
});

describe('sendCommandWhenShellReady', () => {
  beforeEach(() => {
    execCalls.length = 0;
    responses = {};
  });

  it('presses Enter once the echoed command is visible on the first capture', async () => {
    responses = {
      'capture-pane': 'user@host:~$ claude --resume abc-123\n',
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { pollMs: 5, timeoutMs: 200 });

    const literalIdx = execCalls.findIndex(
      (c) => c.includes('send-keys -t %7 -l') && c.includes('claude --resume abc-123'),
    );
    const captureIdx = execCalls.findIndex((c) => c.includes('capture-pane -t %7'));
    const enterIdx = execCalls.findIndex((c) => c === 'tmux send-keys -t %7 Enter');

    assert.ok(literalIdx > -1, 'sends the command literally');
    assert.ok(captureIdx > literalIdx, 'polls the pane after sending');
    assert.ok(enterIdx > captureIdx, 'sends Enter after the echo is confirmed');
    // C-u によるクリア＋再送は起きていない
    assert.ok(!execCalls.some((c) => c.includes('C-u')));
  });

  it('clears the input and resends when the echo does not show up for a while', async () => {
    let captureCount = 0;
    responses = {
      // 最初の8回は空（シェルの rc がまだ準備中）、以降はエコーが見える
      'capture-pane': () => {
        captureCount += 1;
        return captureCount <= 8 ? '' : 'claude --resume abc-123\n';
      },
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { pollMs: 5, timeoutMs: 2000 });

    const literalSends = execCalls.filter(
      (c) => c.includes('send-keys -t %7 -l') && c.includes('claude --resume abc-123'),
    );
    const clearIdx = execCalls.findIndex((c) => c.includes('C-u'));
    const enterIdx = execCalls.findIndex((c) => c === 'tmux send-keys -t %7 Enter');

    // 初回送信 + リトライ後の再送で最低2回本文を送る
    assert.ok(literalSends.length >= 2);
    assert.ok(clearIdx > -1, 'clears the input line with C-u before resending');
    assert.ok(enterIdx > clearIdx, 'presses Enter only after the retried echo is confirmed');
  });

  it('throws when the echo never appears within timeoutMs', async () => {
    responses = {
      'capture-pane': '',
    };

    await assert.rejects(
      () => sendCommandWhenShellReady('%7', 'claude --resume abc-123', { pollMs: 5, timeoutMs: 50 }),
      /シェルの起動を確認できませんでした/,
    );
  });

  it('detects the echo even when the pane wraps the command across lines', async () => {
    responses = {
      // 狭いペイン幅で折り返された想定。空白（改行含む）を除去して比較するので検知できる
      'capture-pane': 'user@host:~$ claude --resume\nabc-123\n',
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { pollMs: 5, timeoutMs: 200 });

    assert.ok(execCalls.some((c) => c === 'tmux send-keys -t %7 Enter'));
  });
});
