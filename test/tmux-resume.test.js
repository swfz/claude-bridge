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

  it('keeps a never-attached session listed first (empty last_attached)', () => {
    // ブリッジが作った受け皿セッションはアタッチされないので行頭がタブになる
    assert.equal(pickTargetSession('\tbridge\n'), 'bridge');
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

// Enter を送った後はペインのフォアグラウンドが claude になる
const claudeAfterEnter = () => (execCalls.some((c) => / send-keys -t %\d+ Enter$/.test(c)) ? 'claude\n' : 'zsh\n');

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
      'display-message': claudeAfterEnter,
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
      'display-message': claudeAfterEnter,
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
      'display-message': claudeAfterEnter,
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

  const FAST = { pollMs: 5, settleMs: 15, readyTimeoutMs: 200, startCheckMs: 20 };
  const literalSendsOf = () =>
    execCalls.filter((c) => c.includes('send-keys -t %7 -l') && c.includes('claude --resume abc-123'));
  const enterCount = () => execCalls.filter((c) => c === 'tmux send-keys -t %7 Enter').length;

  // Enter を押すまではシェル、押した後は claude がフォアグラウンドになる
  const shellUntilEnter = () => (enterCount() > 0 ? 'claude\n' : 'zsh\n');

  it('waits for the prompt, types, presses Enter and returns once claude is in the foreground', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
    const firstCaptureIdx = execCalls.findIndex((c) => c.includes('capture-pane -t %7'));
    const enterIdx = execCalls.findIndex((c) => c === 'tmux send-keys -t %7 Enter');
    assert.ok(firstCaptureIdx < literalIdx, 'looks at the pane before typing');
    assert.ok(enterIdx > literalIdx, 'sends Enter after typing');
    assert.equal(literalSendsOf().length, 1);
    assert.equal(enterCount(), 1);
    assert.ok(!execCalls.some((c) => c.includes('C-u')));
  });

  it('does not type while the screen is still blank (rc still loading)', async () => {
    let captureCount = 0;
    responses = {
      'capture-pane': () => {
        captureCount += 1;
        if (literalSendsOf().length) return 'user@host:~$ claude --resume abc-123\n';
        return captureCount <= 10 ? '' : 'user@host:~$\n';
      },
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
    const capturesBeforeTyping = execCalls.slice(0, literalIdx).filter((c) => c.includes('capture-pane')).length;
    assert.ok(capturesBeforeTyping > 10, 'keeps waiting until the prompt shows up');
  });

  it('clears the input and resends when the echo does not show up for a while', async () => {
    let echoCaptures = 0;
    responses = {
      'capture-pane': () => {
        if (!literalSendsOf().length) return 'user@host:~$\n';
        echoCaptures += 1;
        return echoCaptures <= 8 ? 'user@host:~$\n' : 'user@host:~$ claude --resume abc-123\n';
      },
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 2000 });

    const clearIdx = execCalls.findIndex((c) => c.includes('C-u'));
    const enterIdx = execCalls.findIndex((c) => c === 'tmux send-keys -t %7 Enter');
    assert.ok(literalSendsOf().length >= 2);
    assert.ok(clearIdx > -1, 'clears the input line with C-u before resending');
    assert.ok(enterIdx > clearIdx, 'presses Enter only after the retried echo is confirmed');
  });

  it('presses Enter again when the command stays on the input line', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      // 1 回目の Enter は取りこぼされ、2 回目で起動する
      'display-message': () => (enterCount() >= 2 ? 'claude\n' : 'zsh\n'),
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(enterCount(), 2);
    assert.equal(literalSendsOf().length, 1, 'does not retype the command');
  });

  it('retypes the command when the typeahead was discarded', async () => {
    let dropped = false;
    responses = {
      'capture-pane': () => {
        if (!literalSendsOf().length) return 'user@host:~$\n';
        // 1 回目の Enter の後、入力ごと消えた画面になる
        if (enterCount() === 1 && literalSendsOf().length === 1) {
          dropped = true;
          return 'user@host:~$\n';
        }
        return 'user@host:~$ claude --resume abc-123\n';
      },
      'display-message': () => (enterCount() >= 2 ? 'claude\n' : 'zsh\n'),
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.ok(dropped);
    assert.equal(literalSendsOf().length, 2);
    assert.equal(enterCount(), 2);
  });

  it('returns when output follows the command even if the shell stays in the foreground', async () => {
    responses = {
      'capture-pane': () => {
        if (!literalSendsOf().length) return 'user@host:~$\n';
        return enterCount()
          ? 'user@host:~$ claude --resume abc-123\nerror: not found\nuser@host:~$\n'
          : 'user@host:~$ claude --resume abc-123\n';
      },
      'display-message': 'zsh\n',
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(enterCount(), 1, 'does not run the command twice');
  });

  it('does not retype when the foreground command cannot be read', async () => {
    responses = {
      // claude が alt-screen で描いてコマンド行が見えなくなった想定
      'capture-pane': () =>
        literalSendsOf().length && !enterCount() ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n',
      'display-message': '',
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(literalSendsOf().length, 1);
    assert.equal(enterCount(), 1);
  });

  it('treats a non-shell foreground as started and a login shell as still waiting', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      // 打鍵前は rc の子プロセス（git）が見えていても、判定はシェル名かどうかで行う
      'display-message': () => (enterCount() >= 2 ? 'claude\n' : literalSendsOf().length ? '-zsh\n' : 'git\n'),
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(enterCount(), 2, 're-presses Enter while the login shell is still in the foreground');
  });

  it('throws when the echo never appears within timeoutMs', async () => {
    responses = { 'capture-pane': '', 'display-message': 'zsh\n' };

    await assert.rejects(
      () => sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, readyTimeoutMs: 20, timeoutMs: 60 }),
      /シェルの起動を確認できませんでした/,
    );
  });

  it('detects the echo even when the pane wraps the command across lines', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume\nabc-123\n' : 'user@host:~$\n'),
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(enterCount(), 1);
  });
});
