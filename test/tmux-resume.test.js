import { describe, it, beforeEach, afterEach, vi } from 'vitest';
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

const { pickTargetSession, buildResumeWindowName, resumeInTmuxWindow, launchInTmuxWindow, sendCommandWhenShellReady } =
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

  it('skips names with unsafe characters at either end', () => {
    assert.equal(pickTargetSession(['9999\t$x', '9998\tx$', '1\tok'].join('\n')), 'ok');
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

  it('reports the created window before typing the resume command', async () => {
    responses = {
      'list-sessions': '900\tmain-sess\n',
      'new-window': '%7\tmain-sess:3.0\n',
      'capture-pane': 'claude --resume abc-123\n',
      'display-message': claudeAfterEnter,
    };
    let callsAtCreated = null;

    await resumeInTmuxWindow({
      claudeSessionId: 'abc-123',
      cwd: '/tmp/work',
      onWindowCreated: (pane) => {
        assert.equal(pane.paneId, '%7');
        callsAtCreated = execCalls.length;
      },
    });

    assert.ok(callsAtCreated != null);
    assert.ok(!execCalls.slice(0, callsAtCreated).some((c) => c.includes('send-keys')));
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

  it('puts the window back into the requested tmux session with its old window name', async () => {
    responses = {
      'list-sessions': '1700009999\tnewer\n0\twork\n',
      'new-window': '%7\twork:3.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: 'def-456',
      cwd: '/tmp/work',
      tmuxSession: 'work',
      windowName: 'my window',
    });

    assert.equal(pane.sessionName, 'work');
    assert.equal(pane.windowName, 'my window');
    const created = execCalls.find((c) => c.includes('new-window'));
    assert.ok(created.includes("-t 'work:'"));
    assert.ok(created.includes("-n 'my window'"));
  });

  it('escapes tmux formats in the window name so #(cmd) is not run', async () => {
    responses = {
      'list-sessions': '1\twork\n',
      'new-window': '%7\twork:3.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: 'def-456',
      cwd: '/tmp',
      tmuxSession: 'work',
      windowName: '#(touch /tmp/x) #{pane_id}',
    });

    const created = execCalls.find((c) => c.includes('new-window'));
    assert.ok(created.includes("-n '##(touch /tmp/x) ##{pane_id}'"));
    // タブ名などに使う戻り値は元の字面のまま
    assert.equal(pane.windowName, '#(touch /tmp/x) #{pane_id}');
  });

  it('creates the requested tmux session when it no longer exists', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-session': '%0\twork:0.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({ claudeSessionId: 'def-456', cwd: '/tmp', tmuxSession: 'work' });

    assert.equal(pane.sessionName, 'work');
    assert.ok(execCalls.find((c) => c.includes('new-session')).includes('-d -s work'));
    assert.ok(!execCalls.some((c) => c.includes('new-window')));
  });

  it('ignores a requested session name that is unsafe for tmux targets', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': '%4\tmain:1.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({ claudeSessionId: 'def-456', cwd: '/tmp', tmuxSession: 'a:b;rm' });

    assert.equal(pane.sessionName, 'main');
  });

  it('rejects a session id that could be injected into the shell', async () => {
    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: 'abc; rm -rf /', cwd: '/tmp' }),
      /Invalid claudeSessionId/,
    );
    await assert.rejects(() => resumeInTmuxWindow({ claudeSessionId: 'a;b', cwd: '/tmp' }), /Invalid claudeSessionId/);
    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: undefined, cwd: '/tmp' }),
      /Invalid claudeSessionId/,
    );
    assert.equal(execCalls.length, 0);
  });

  it('drops control characters from the requested window name and caps it at 64 characters', async () => {
    responses = {
      'list-sessions': '1\twork\n',
      'new-window': '%7\twork:3.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: 'def-456',
      cwd: '/tmp',
      windowName: 'a\x01b\x7f' + 'x'.repeat(80),
    });

    assert.equal(pane.windowName, 'ab' + 'x'.repeat(62));
  });

  it('ignores a requested session name that is not a string', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': '%4\tmain:1.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({ claudeSessionId: 'def-456', cwd: '/tmp', tmuxSession: 123 });

    assert.equal(pane.sessionName, 'main');
    assert.ok(!execCalls.some((c) => c.includes('new-session')));
  });

  it('falls back to the default window name when the requested one is blank', async () => {
    responses = {
      'list-sessions': '1\twork\n',
      'new-window': '%7\twork:3.0\n',
      'capture-pane': 'claude --resume def-456\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await resumeInTmuxWindow({ claudeSessionId: 'def-456', cwd: '/tmp', windowName: '  \x02 ' });

    assert.equal(pane.windowName, 'claude-def-456');
  });

  it('rejects a pane id that is not in %<digits> form', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': 'bogus-pane\tmain:1.0\n',
    };

    let created = false;
    await assert.rejects(
      () =>
        resumeInTmuxWindow({
          claudeSessionId: 'abc',
          cwd: '/tmp',
          onWindowCreated: () => {
            created = true;
          },
        }),
      /Invalid paneId/,
    );
    assert.equal(created, false, 'does not report a window it cannot address');
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

describe('launchInTmuxWindow', () => {
  beforeEach(() => {
    execCalls.length = 0;
    responses = {};
  });

  const FORMAT = "-P -F '#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}'";

  it('cwd・window 名が無ければ -c を付けず window 名は claude にする', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': '%5\tmain:1.0\n',
      'capture-pane': 'claude --model opus\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await launchInTmuxWindow({ command: 'claude --model opus' });

    assert.deepEqual(pane, { paneId: '%5', target: 'main:1.0', sessionName: 'main', windowName: 'claude' });
    const created = execCalls.find((c) => c.includes('new-window'));
    assert.equal(created, `tmux new-window -t 'main:' -n 'claude' ${FORMAT}`);
    assert.ok(execCalls.some((c) => c === "tmux send-keys -t %5 -l 'claude --model opus'"));
  });

  it('target が返らなければ paneId を target にする', async () => {
    responses = {
      'list-sessions': '1\tmain\n',
      'new-window': '%5\n',
      'capture-pane': 'claude\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await launchInTmuxWindow({ command: 'claude' });

    assert.equal(pane.target, '%5');
  });

  it('指定セッションは名前が完全に一致するものだけを既存とみなす', async () => {
    responses = {
      'list-sessions': '1\twork2\n2\tmywork\n',
      'new-session': '%0\twork:0.0\n',
      'capture-pane': 'claude\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await launchInTmuxWindow({ command: 'claude', tmuxSession: 'work', cwd: '/w' });

    assert.equal(pane.sessionName, 'work');
    assert.equal(
      execCalls.find((c) => c.includes('new-session')),
      `tmux new-session -d -s work -n 'claude' -c '/w' ${FORMAT}`,
    );
  });

  it('指定セッション名は 64 文字まで', async () => {
    responses = {
      'list-sessions': `2\tmain\n1\t${'s'.repeat(65)}\n`,
      'new-window': '%5\tmain:1.0\n',
      'capture-pane': 'claude\n',
      'display-message': claudeAfterEnter,
    };

    const pane = await launchInTmuxWindow({ command: 'claude', tmuxSession: 's'.repeat(65) });

    assert.equal(pane.sessionName, 'main');
  });

  it('tmux の失敗の理由をエラーに含め、元のエラーを cause に残す', async () => {
    const original = new Error('cannot find session: main');
    responses = { 'list-sessions': '1\tmain\n', 'new-window': original };

    await assert.rejects(
      () => launchInTmuxWindow({ command: 'claude' }),
      (e) => /tmux window の作成に失敗しました: cannot find session: main/.test(e.message) && e.cause === original,
    );
  });

  it('tmux が command not found のときも短い案内にし、元のエラーを cause に残す', async () => {
    const original = new Error('zsh: tmux: command not found');
    responses = { 'list-sessions': new Error('x'), 'new-session': original };

    await assert.rejects(
      () => launchInTmuxWindow({ command: 'claude' }),
      (e) => /^tmux コマンドが見つかりません/.test(e.message) && e.cause === original,
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
    // エコーを確認したらフォアグラウンドを見る前に Enter を押す
    assert.ok(
      !execCalls.slice(literalIdx, enterIdx).some((c) => c.includes('display-message')),
      'presses Enter right after the echo',
    );
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

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
      ...FAST,
      // 打ち切りのテストではないので、ポーリングが遅くても期限に届かないよう遠ざける
      readyTimeoutMs: 5000,
      timeoutMs: 6000,
    });

    const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
    const capturesBeforeTyping = execCalls.slice(0, literalIdx).filter((c) => c.includes('capture-pane')).length;
    assert.ok(capturesBeforeTyping > 10, 'keeps waiting until the prompt shows up');
  });

  it('does not type while the prompt is still being redrawn (screen keeps changing)', async () => {
    let captureCount = 0;
    responses = {
      'capture-pane': () => {
        captureCount += 1;
        if (literalSendsOf().length) return 'user@host:~$ claude --resume abc-123\n';
        // rc の初期化中は画面が書き換わり続け、6 回目以降で落ち着く
        return captureCount <= 6 ? `loading ${captureCount}\n` : 'user@host:~$\n';
      },
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
      ...FAST,
      // 打ち切りのテストではないので、ポーリングが遅くても期限に届かないよう遠ざける
      readyTimeoutMs: 5000,
      timeoutMs: 6000,
    });

    const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
    const capturesBeforeTyping = execCalls.slice(0, literalIdx).filter((c) => c.includes('capture-pane')).length;
    assert.ok(capturesBeforeTyping > 7, `waits until the screen settles (captured ${capturesBeforeTyping} times)`);
  });

  it('waits settleMs after the prompt stops changing before typing', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      'display-message': shellUntilEnter,
    };
    const startedAt = Date.now();
    let typedAt = null;
    responses['send-keys'] = () => {
      if (typedAt == null && literalSendsOf().length) typedAt = Date.now();
      return '';
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
      ...FAST,
      settleMs: 120,
      readyTimeoutMs: 2000,
      timeoutMs: 3000,
    });

    assert.ok(typedAt - startedAt >= 110, `typed after ${typedAt - startedAt}ms`);
  });

  it('keeps waiting while the screen shows only whitespace (prompt not drawn yet)', async () => {
    let captureCount = 0;
    responses = {
      'capture-pane': () => {
        captureCount += 1;
        if (literalSendsOf().length) return 'user@host:~$ claude --resume abc-123\n';
        return captureCount <= 15 ? '\n   \n' : 'user@host:~$\n';
      },
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
      ...FAST,
      // 打ち切りのテストではないので、ポーリングが遅くても期限に届かないよう遠ざける
      readyTimeoutMs: 5000,
      timeoutMs: 6000,
    });

    const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
    const capturesBeforeTyping = execCalls.slice(0, literalIdx).filter((c) => c.includes('capture-pane')).length;
    assert.ok(capturesBeforeTyping > 15, `waits for a visible prompt (captured ${capturesBeforeTyping} times)`);
  });

  it('treats a foreground command with a dash in the middle as started (only a leading dash marks a login shell)', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      'display-message': () => (enterCount() > 0 ? 'ba-sh\n' : 'zsh\n'),
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    assert.equal(enterCount(), 1);
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
    // エコーが見えないまま 8 回見たところで 1 回だけ打ち直す
    assert.equal(literalSendsOf().length, 2);
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
    // 打ち直す前に入力行を C-u で空にする
    const retypeIdx = execCalls.findLastIndex((c) => c.includes('send-keys -t %7 -l'));
    assert.equal(execCalls[retypeIdx - 1], 'tmux send-keys -t %7 C-u');
  });

  it('does not re-press Enter until startCheckMs has passed since Enter', async () => {
    let pollsAfterEnter = 0;
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      // Enter の後、数回はまだシェルが前景（claude の起動待ち）
      'display-message': () => {
        if (!enterCount()) return 'zsh\n';
        pollsAfterEnter += 1;
        return pollsAfterEnter > 4 ? 'claude\n' : 'zsh\n';
      },
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, startCheckMs: 500, timeoutMs: 2000 });

    assert.equal(enterCount(), 1);
  });

  it('treats every known shell name as still waiting at the prompt', async () => {
    for (const shell of ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']) {
      execCalls.length = 0;
      responses = {
        'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
        'display-message': () => (enterCount() >= 2 ? 'claude\n' : `${shell}\n`),
      };

      await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

      assert.equal(enterCount(), 2, `${shell} is a shell`);
    }
  });

  it('presses Enter right after the retyped command echoes', async () => {
    responses = {
      'capture-pane': () => {
        if (!literalSendsOf().length) return 'user@host:~$\n';
        if (enterCount() === 1 && literalSendsOf().length === 1) return 'user@host:~$\n';
        return 'user@host:~$ claude --resume abc-123\n';
      },
      'display-message': () => (enterCount() >= 2 ? 'claude\n' : 'zsh\n'),
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 1000 });

    const retypeIdx = execCalls.findLastIndex((c) => c.includes('send-keys -t %7 -l'));
    const secondEnterIdx = execCalls.findLastIndex((c) => c === 'tmux send-keys -t %7 Enter');
    assert.ok(secondEnterIdx > retypeIdx);
    assert.ok(!execCalls.slice(retypeIdx, secondEnterIdx).some((c) => c.includes('display-message')));
  });

  it('gives up with an error when the retyped command never echoes', async () => {
    responses = {
      // 1 回目の Enter の後は入力ごと消えたまま戻らない
      'capture-pane': () =>
        literalSendsOf().length && !enterCount() ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n',
      'display-message': 'zsh\n',
    };

    await assert.rejects(
      () => sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 300 }),
      /シェルの起動を確認できませんでした/,
    );
  });

  it('gives up with an error when the shell stays in the foreground with the command on the line', async () => {
    responses = {
      'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
      'display-message': 'zsh\n',
    };

    await assert.rejects(
      () => sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 300 }),
      /^Error: コマンドの起動を確認できませんでした（tmux window 内で Enter が受け付けられません）$/,
    );
  });

  it('stops waiting for the prompt after readyTimeoutMs even if the screen keeps changing', async () => {
    let tick = 0;
    responses = {
      'capture-pane': () => {
        tick += 1;
        return `tick ${tick}\n` + (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : '');
      },
      'display-message': shellUntilEnter,
    };

    await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
      ...FAST,
      readyTimeoutMs: 30,
      timeoutMs: 1500,
    });

    assert.equal(enterCount(), 1);
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
      /^Error: シェルの起動を確認できませんでした（tmux window 内でコマンドが受け付けられません）$/,
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

  // 期限・経過時間の比較の境界。Date だけ止めて（setTimeout は本物のまま）「ちょうど」を作る
  describe('at exact time boundaries', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const capturesBeforeTyping = () => {
      const literalIdx = execCalls.findIndex((c) => c.includes('send-keys -t %7 -l'));
      return execCalls.slice(0, literalIdx).filter((c) => c.includes('capture-pane')).length;
    };

    it('types without looking at the pane when readyTimeoutMs is 0', async () => {
      responses = {
        'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
        'display-message': shellUntilEnter,
      };

      await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
        ...FAST,
        settleMs: 0,
        readyTimeoutMs: 0,
        timeoutMs: 1000,
      });

      assert.equal(capturesBeforeTyping(), 0);
      assert.equal(literalSendsOf().length, 1);
      assert.equal(enterCount(), 1);
    });

    it('types as soon as the prompt has stayed unchanged for exactly settleMs', async () => {
      responses = {
        'capture-pane': () => {
          // 画面を 1 回読むごとに 10ms 進める
          vi.setSystemTime(Date.now() + 10);
          return literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n';
        },
        'display-message': shellUntilEnter,
      };

      await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
        ...FAST,
        settleMs: 10,
        readyTimeoutMs: 1000,
        timeoutMs: 2000,
      });

      // 1 回目で画面を覚え、10ms 後の 2 回目で変化なし＝settleMs ちょうどで打つ
      assert.equal(capturesBeforeTyping(), 2);
    });

    it('still accepts the echo and the started claude at the exact deadline (timeoutMs 0)', async () => {
      responses = {
        'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
        'display-message': shellUntilEnter,
      };

      await sendCommandWhenShellReady('%7', 'claude --resume abc-123', { ...FAST, timeoutMs: 0 });

      assert.equal(literalSendsOf().length, 1);
      assert.equal(enterCount(), 1);
    });

    it('re-sends Enter on the first shell-foreground check when startCheckMs is 0', async () => {
      let displayCount = 0;
      responses = {
        'capture-pane': () => (literalSendsOf().length ? 'user@host:~$ claude --resume abc-123\n' : 'user@host:~$\n'),
        // Enter の後の 1 回目はまだシェル、2 回目で claude
        'display-message': () => {
          displayCount += 1;
          return displayCount === 1 ? 'zsh\n' : 'claude\n';
        },
      };

      await sendCommandWhenShellReady('%7', 'claude --resume abc-123', {
        ...FAST,
        // 時刻が止まっているので、settleMs が 0 でないとプロンプト待ちが終わらない
        settleMs: 0,
        startCheckMs: 0,
        timeoutMs: 1000,
      });

      assert.equal(enterCount(), 2, 'the command was left on the input line, so Enter is pressed again');
      assert.ok(!execCalls.some((c) => c.includes('C-u')));
    });
  });
});
