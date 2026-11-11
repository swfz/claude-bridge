import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// child_process.exec をモック（1回だけ設定）
const execCalls = [];
let execError = null;

mock.module('child_process', {
  namedExports: {
    exec: (cmd, cb) => {
      execCalls.push(cmd);
      if (execError) {
        cb(execError);
      } else {
        cb(null, { stdout: execCalls._mockStdout || '', stderr: '' });
      }
    },
  },
});

// モック後に import
const { listClaudeTmuxPanes, sendKeysToPane, validateSessionName, ensureInsertMode, TmuxSession } =
  await import('../server/tmux-session.js');

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
});
