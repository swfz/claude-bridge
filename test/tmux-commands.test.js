import { describe, it, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';

// child_process.exec をモック（1回だけ設定）
const execCalls = [];
let execError = null;

vi.mock('child_process', () => ({
  exec: (cmd, cb) => {
    execCalls.push(cmd);
    if (execError) {
      cb(execError);
    } else {
      cb(null, { stdout: execCalls._mockStdout || '', stderr: '' });
    }
  },
}));

// vim 設定は本物の ~/.claude を読まないよう差し替える（画面の判定は本物を使う）
let vimEnabled = false;
vi.mock('../server/vim-mode.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isVimEditorEnabled: async () => vimEnabled,
}));

// モック後に import
const {
  listClaudeTmuxPanes,
  isTmuxServerRunning,
  sendKeysToPane,
  sendChoiceKeysToPane,
  sendChoiceTextToPane,
  capturePane,
  escapeTmuxFormat,
  escapeForShell,
  validateSessionName,
  ensureInsertMode,
  TmuxSession,
} = await import('../server/tmux-session.js');

describe('listClaudeTmuxPanes', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('parses tmux output and filters claude panes', async () => {
    execCalls._mockStdout = [
      '%0\t1330\tclaude\t/home/user/project\t0:1.1\tmain\tsess0',
      '%1\t2000\tzsh\t/home/user\t0:1.2\tmain\tsess0',
      '%2\t3000\tclaude\t/home/user/other\t0:2.1\twork\tsess1',
    ].join('\n');

    const panes = await listClaudeTmuxPanes();

    assert.equal(panes.length, 2);
    assert.deepEqual(panes[0], {
      paneId: '%0',
      panePid: '1330',
      command: 'claude',
      cwd: '/home/user/project',
      target: '0:1.1',
      windowName: 'main',
      sessionName: 'sess0',
    });
    assert.equal(panes[1].paneId, '%2');
    assert.equal(panes[1].cwd, '/home/user/other');
  });

  it('detects claude panes by version number (macOS symlink resolution)', async () => {
    execCalls._mockStdout = [
      '%0\t1330\t2.1.100\t/home/user/project\t0:1.1\tmain',
      '%1\t2000\tzsh\t/home/user\t0:1.2\tmain',
      '%2\t3000\t2.1.97\t/home/user/other\t0:2.1\twork',
    ].join('\n');

    const panes = await listClaudeTmuxPanes();

    assert.equal(panes.length, 2);
    assert.equal(panes[0].paneId, '%0');
    assert.equal(panes[0].command, '2.1.100');
    assert.equal(panes[1].paneId, '%2');
    assert.equal(panes[1].command, '2.1.97');
  });

  it('returns empty array when no claude panes', async () => {
    execCalls._mockStdout = '%0\t1000\tzsh\t/home\t0:1.1\tmain\n';

    const panes = await listClaudeTmuxPanes();
    assert.equal(panes.length, 0);
  });

  it('returns empty array on tmux error', async () => {
    execError = new Error('no tmux server');

    const panes = await listClaudeTmuxPanes();
    assert.deepEqual(panes, []);
  });
});

describe('sendKeysToPane', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('sends text first, then Enter as a separate command', async () => {
    await sendKeysToPane('%0', 'hello world');

    assert.equal(execCalls.length, 2);
    assert.ok(execCalls[0].includes('tmux send-keys -t %0 -l'));
    assert.ok(execCalls[0].includes('hello world'));
    assert.ok(!execCalls[0].includes('Enter'));
    assert.equal(execCalls[1], 'tmux send-keys -t %0 Enter');
  });

  it('strips trailing newlines from the body (Enter is sent separately)', async () => {
    await sendKeysToPane('%0', '[レビュー 2件]\n1. foo\n2. bar\r');

    assert.equal(execCalls.length, 2);
    assert.ok(execCalls[0].includes("-l '[レビュー 2件]\n1. foo\n2. bar'"));
    assert.ok(!execCalls[0].includes('\r'));
    assert.equal(execCalls[1], 'tmux send-keys -t %0 Enter');
  });

  it('escapes single quotes in text', async () => {
    await sendKeysToPane('%0', "it's a test");

    assert.equal(execCalls.length, 2);
    assert.ok(execCalls[0].includes("it'\\''s a test"));
  });

  it('handles empty text', async () => {
    await sendKeysToPane('%0', '');

    assert.equal(execCalls.length, 2);
    assert.ok(execCalls[0].includes("tmux send-keys -t %0 -l ''"));
  });

  it('logs error but does not throw on failure', async () => {
    execError = new Error('pane not found');

    // should not throw
    await sendKeysToPane('%99', 'test');
  });
});

const RULE = '─'.repeat(40);
const NORMAL_SCREEN = ['応答', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n');
const INSERT_SCREEN = ['応答', RULE, '❯ ', RULE, '  -- INSERT -- ⏵⏵ auto mode on'].join('\n');

describe('ensureInsertMode', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('sends `i` when the input box is in vim NORMAL mode', async () => {
    execCalls._mockStdout = NORMAL_SCREEN;
    const changed = await ensureInsertMode('%0', { vimEnabled: async () => true });
    assert.equal(changed, true);
    assert.deepEqual([...execCalls], ['tmux capture-pane -t %0 -p', 'tmux send-keys -t %0 -l i']);
  });

  it('does nothing in INSERT mode', async () => {
    execCalls._mockStdout = INSERT_SCREEN;
    assert.equal(await ensureInsertMode('%0', { vimEnabled: async () => true }), false);
    assert.deepEqual([...execCalls], ['tmux capture-pane -t %0 -p']);
  });

  it('does not read the screen when vim mode is not configured', async () => {
    execCalls._mockStdout = NORMAL_SCREEN;
    assert.equal(await ensureInsertMode('%0', { vimEnabled: async () => false }), false);
    assert.equal(execCalls.length, 0);
  });

  it('swallows capture failures', async () => {
    execError = new Error('pane not found');
    assert.equal(await ensureInsertMode('%0', { vimEnabled: async () => true }), false);
  });
});

describe('TmuxSession.write', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('skips the vim check while waiting for a choice prompt', async () => {
    const s = new TmuxSession({ id: 'a', name: 'a', paneId: '%1', target: '0:1.1', waitingFor: 'input needed' });
    await s.write('1\r');
    assert.ok(execCalls.every((c) => !c.includes('capture-pane')));
    assert.equal(execCalls[execCalls.length - 1], 'tmux send-keys -t %1 Enter');
  });
});

describe('validateSessionName', () => {
  it('accepts safe tmux session names', () => {
    validateSessionName('my-sess_1.2:3');
    validateSessionName('bridge-ab12cd34');
  });

  it('rejects injection / whitespace characters', () => {
    assert.throws(() => validateSessionName('a b'));
    assert.throws(() => validateSessionName('$(whoami)'));
    assert.throws(() => validateSessionName('a;ls'));
    assert.throws(() => validateSessionName(''));
    assert.throws(() => validateSessionName(undefined));
  });

  it('不正な名前をエラーに含める', () => {
    assert.throws(() => validateSessionName('a b'), /Invalid tmux session name: a b/);
  });
});

describe('listClaudeTmuxPanes: claude の判定と出力の読み方', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('tmux list-panes を全セッション対象のフォーマット付きで呼ぶ', async () => {
    await listClaudeTmuxPanes();
    assert.equal(execCalls.length, 1);
    assert.ok(execCalls[0].startsWith('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}'));
  });

  it('バージョン番号は各部が複数桁でも claude とみなし、前後に余計な文字があれば claude としない', async () => {
    execCalls._mockStdout = [
      '%0\t1\t12.1.100\t/a\t0:1.1\tw\ts',
      '%1\t2\t2.10.3\t/a\t0:1.2\tw\ts',
      '%2\t3\tv2.1.100\t/a\t0:1.3\tw\ts',
      '%3\t4\t2.1.100-beta\t/a\t0:1.4\tw\ts',
      '%4\t5\tclaude-code\t/a\t0:1.5\tw\ts',
    ].join('\n');

    const panes = await listClaudeTmuxPanes();

    assert.deepEqual(
      panes.map((p) => p.paneId),
      ['%0', '%1'],
    );
  });

  it('出力末尾の空白は最後のペインの値に含めない', async () => {
    execCalls._mockStdout = '%0\t1\tclaude\t/a\t0:1.1\tw\tsess0  \n\n';

    const panes = await listClaudeTmuxPanes();

    assert.equal(panes.length, 1);
    assert.equal(panes[0].sessionName, 'sess0');
  });
});

describe('ペイン ID の検証', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('sendKeysToPane は不正な paneId を tmux に渡さず投げる', async () => {
    await assert.rejects(
      () => sendKeysToPane('%0; tmux kill-server', 'x'),
      /Invalid paneId format: %0; tmux kill-server/,
    );
    assert.equal(execCalls.length, 0);
  });

  it('ensureInsertMode は不正な paneId を tmux に渡さず投げる', async () => {
    await assert.rejects(() => ensureInsertMode('0', { vimEnabled: async () => true }), /Invalid paneId/);
    assert.equal(execCalls.length, 0);
  });
});

describe('sendKeysToPane: 末尾の改行', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('末尾に続く改行（\\r\\n など）は全部落としてから送る', async () => {
    await sendKeysToPane('%0', 'hello\r\n\n');
    assert.equal(execCalls[0], "tmux send-keys -t %0 -l 'hello'");
  });
});

describe('isTmuxServerRunning', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('list-sessions が通れば真', async () => {
    assert.equal(await isTmuxServerRunning(), true);
    assert.deepEqual([...execCalls], ['tmux list-sessions -F "#{session_name}"']);
  });

  it('失敗したら偽', async () => {
    execError = new Error('no server running');
    assert.equal(await isTmuxServerRunning(), false);
  });
});

describe('sendChoiceKeysToPane', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('数字は -l でリテラル送信し、それ以外はキー名のまま 1 キーずつ送る', async () => {
    await sendChoiceKeysToPane('%3', ['2', 'Enter', 'BTab']);
    assert.deepEqual(
      [...execCalls],
      ["tmux send-keys -t %3 -l '2'", 'tmux send-keys -t %3 Enter', 'tmux send-keys -t %3 BTab'],
    );
  });

  it('キーの間に少し待つ（TUI の取りこぼし対策）', async () => {
    const t0 = Date.now();
    await sendChoiceKeysToPane('%3', ['1', '2', '3']);
    assert.ok(Date.now() - t0 >= 170, `elapsed ${Date.now() - t0}ms`);
  });

  it('1 キーだけなら待たない', async () => {
    const t0 = Date.now();
    await sendChoiceKeysToPane('%3', 'Escape');
    assert.ok(Date.now() - t0 < 80);
    assert.deepEqual([...execCalls], ['tmux send-keys -t %3 Escape']);
  });

  it('ホワイトリスト外のキー・不正な paneId は tmux に渡さず投げる', async () => {
    await assert.rejects(() => sendChoiceKeysToPane('%3', ['1', 'C-c']), /Invalid choice key/);
    await assert.rejects(() => sendChoiceKeysToPane('3', ['1']), /Invalid paneId/);
    assert.equal(execCalls.length, 0);
  });
});

describe('sendChoiceTextToPane', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  it('改行を空白に潰し、エスケープしてリテラル送信する（Enter は付けない）', async () => {
    await sendChoiceTextToPane('%3', "it's\nok");
    assert.deepEqual([...execCalls], ["tmux send-keys -t %3 -l 'it'\\''s ok'"]);
  });

  it('空なら何も送らない', async () => {
    await sendChoiceTextToPane('%3', '');
    await sendChoiceTextToPane('%3', undefined);
    assert.equal(execCalls.length, 0);
  });

  it('不正な paneId は投げる', async () => {
    await assert.rejects(() => sendChoiceTextToPane('%3 x', 'a'), /Invalid paneId/);
    assert.equal(execCalls.length, 0);
  });
});

describe('capturePane', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = 'screen text';
    execError = null;
  });

  it('既定は今の画面だけを読む', async () => {
    assert.equal(await capturePane('%2'), 'screen text');
    assert.deepEqual([...execCalls], ['tmux capture-pane -t %2 -p']);
  });

  it('scrollback を指定すると遡る（2000 行まで）', async () => {
    await capturePane('%2', { scrollback: 300 });
    await capturePane('%2', { scrollback: 5000 });
    await capturePane('%2', { scrollback: 2000 });
    assert.deepEqual(
      [...execCalls],
      [
        'tmux capture-pane -t %2 -p -S -300',
        'tmux capture-pane -t %2 -p -S -2000',
        'tmux capture-pane -t %2 -p -S -2000',
      ],
    );
  });

  it('不正な paneId は投げる', async () => {
    await assert.rejects(() => capturePane('pane'), /Invalid paneId/);
    assert.equal(execCalls.length, 0);
  });
});

describe('escapeTmuxFormat / escapeForShell', () => {
  it('# を ## にする（全部）', () => {
    assert.equal(escapeTmuxFormat('#(a) #{b}'), '##(a) ##{b}');
    assert.equal(escapeTmuxFormat(12), '12');
  });

  it('シングルクォートを全部閉じ直す', () => {
    assert.equal(escapeForShell("a'b'c"), "'a'\\''b'\\''c'");
  });
});

describe('ensureInsertMode: 既定の vim 判定', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = NORMAL_SCREEN;
    execError = null;
  });

  it('vimEnabled が失敗しても投げずに偽を返す', async () => {
    const changed = await ensureInsertMode('%0', {
      vimEnabled: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(changed, false);
    assert.equal(execCalls.length, 0);
  });

  it('INSERT に戻した後、少し待ってから返す', async () => {
    const t0 = Date.now();
    await ensureInsertMode('%0', { vimEnabled: async () => true });
    assert.ok(Date.now() - t0 >= 70, `elapsed ${Date.now() - t0}ms`);
  });
});

describe('TmuxSession: tmux に流す操作', () => {
  beforeEach(() => {
    vimEnabled = false;
    execCalls.length = 0;
    execCalls._mockStdout = '';
    execError = null;
  });

  const make = (extra = {}) => new TmuxSession({ id: 'a', name: 'a', paneId: '%4', target: '0:1.1', ...extra });

  it('write は選択肢待ちでなければ vim の NORMAL を INSERT に戻してから本文と Enter を送る', async () => {
    vimEnabled = true;
    execCalls._mockStdout = NORMAL_SCREEN;
    await make().write('hi\r');
    assert.deepEqual(
      [...execCalls],
      [
        'tmux capture-pane -t %4 -p',
        'tmux send-keys -t %4 -l i',
        "tmux send-keys -t %4 -l 'hi'",
        'tmux send-keys -t %4 Enter',
      ],
    );
  });

  it('続けて呼んだ write は順番どおりに送る', async () => {
    const s = make({ waitingFor: 'input needed' });
    s.write('first\r');
    await s.write('second\r');
    const bodies = execCalls.filter((c) => c.includes(' -l '));
    assert.deepEqual(bodies, ["tmux send-keys -t %4 -l 'first'", "tmux send-keys -t %4 -l 'second'"]);
  });

  it('getScreenText は今の画面を返す', async () => {
    execCalls._mockStdout = 'current';
    assert.equal(await make().getScreenText(), 'current');
    assert.deepEqual([...execCalls], ['tmux capture-pane -t %4 -p']);
  });

  it('sendChoiceKeys / sendChoiceText はそのペインに送る', async () => {
    const s = make();
    await s.sendChoiceKeys(['Escape']);
    await s.sendChoiceText('abc');
    assert.deepEqual([...execCalls], ['tmux send-keys -t %4 Escape', "tmux send-keys -t %4 -l 'abc'"]);
  });

  it('getOutputBuffer は 500 行遡った画面を返し、失敗したら空文字', async () => {
    execCalls._mockStdout = 'history';
    assert.equal(await make().getOutputBuffer(), 'history');
    assert.deepEqual([...execCalls], ['tmux capture-pane -t %4 -p -S -500']);
    execError = new Error('pane gone');
    assert.equal(await make().getOutputBuffer(), '');
  });

  it('不正な paneId では作れない', () => {
    assert.throws(() => make({ paneId: 'bad' }), /Invalid paneId/);
  });
});
