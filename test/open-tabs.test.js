import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'open-tabs-'));
process.env.CLAUDE_BRIDGE_DIR = dataDir;

const {
  loadOpenTabs,
  saveOpenTabs,
  sanitizeOpenTabs,
  tabsFromSessions,
  updatePaneSnapshot,
  removePaneSnapshot,
  upsertPaneSnapshot,
  planRestore,
  splitPending,
  MISSING_LIMIT,
} = await import('../server/open-tabs.js');

const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_C = 'cccccccc-1111-2222-3333-444444444444';

// enrichPanesWithSessionMeta() 済みのペイン。sessionName は Claude 側の名前（/rename）で上書きされている
function livePane(
  sid,
  { paneId = '%1', target = 'main:2.0', sessionName = 'renamed-by-claude', windowName = 'w' } = {},
) {
  return {
    paneId,
    target,
    sessionName,
    windowName,
    cwd: '/home/u/proj',
    claudePid: 123,
    claudeSessionId: sid,
    status: 'idle',
    waitingFor: null,
  };
}

describe('open-tabs: 保存と読み込み', () => {
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  it('ファイルが無ければ空', () => {
    assert.deepEqual(loadOpenTabs(join(dataDir, 'none.json')), { tabs: [], panes: [], pending: [] });
  });

  it('壊れた JSON は空', () => {
    const file = join(dataDir, 'broken.json');
    writeFileSync(file, '{not json');
    assert.deepEqual(loadOpenTabs(file), { tabs: [], panes: [], pending: [] });
  });

  it('tmp + rename で書き、0600 で読み戻せる', () => {
    const file = join(dataDir, 'open-tabs.json');
    const state = {
      tabs: [
        { type: 'tmux', id: 'abcd1234', name: 'x', cwd: '/home/u/p', projectDir: '-home-u-p', claudeSessionId: SID_A },
      ],
      panes: [],
      pending: [],
    };
    saveOpenTabs(state, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), state);
    assert.deepEqual(loadOpenTabs(file).tabs, state.tabs);
  });
});

describe('open-tabs: sanitizeOpenTabs', () => {
  it('不正なエントリだけ捨て、値を検証する', () => {
    const out = sanitizeOpenTabs({
      tabs: [
        { type: 'tmux', id: '../x', claudeSessionId: SID_A, cwd: '/home/u/p', projectDir: '../evil' },
        { type: 'pty', claudeSessionId: SID_B },
        { type: 'readonly', claudeSessionId: 'bad id' },
        null,
      ],
      panes: [{ claudeSessionId: SID_B, tmuxSession: 'a:b', windowName: 'w', windowIndex: -1, missing: 'x' }],
      pending: [{ claudeSessionId: SID_C, tab: { id: 'ok-1', name: 'n' } }, { claudeSessionId: '' }],
    });
    assert.equal(out.tabs.length, 1);
    assert.equal(out.tabs[0].id, null);
    // projectDir が不正なら cwd から作り直す
    assert.equal(out.tabs[0].projectDir, '-home-u-p');
    assert.deepEqual(out.panes[0], {
      claudeSessionId: SID_B,
      cwd: null,
      projectDir: null,
      tmuxSession: null,
      windowName: 'w',
      windowIndex: null,
      missing: 0,
    });
    assert.equal(out.pending.length, 1);
    assert.deepEqual(out.pending[0].tab, { id: 'ok-1', name: 'n' });
  });

  it('データが配列でなければ空', () => {
    assert.deepEqual(sanitizeOpenTabs({ tabs: 'x' }), { tabs: [], panes: [], pending: [] });
  });
});

describe('open-tabs: tabsFromSessions', () => {
  it('tmux / readonly の生きているタブだけを、claudeSessionId があるものだけ残す', () => {
    const tabs = tabsFromSessions([
      { id: 'p1', type: undefined, alive: true, claudeSessionId: SID_A },
      { id: 't1', type: 'tmux', alive: true, name: 'T', cwd: '/home/u/p', claudeSessionId: SID_A },
      { id: 't2', type: 'tmux', alive: true, claudeSessionId: null },
      { id: 'r1', type: 'readonly', alive: true, claudeSessionId: SID_B, projectDir: '-home-u-p' },
      { id: 'r2', type: 'readonly', alive: false, claudeSessionId: SID_C },
    ]);
    assert.deepEqual(
      tabs.map((t) => [t.id, t.type]),
      [
        ['t1', 'tmux'],
        ['r1', 'readonly'],
      ],
    );
  });
});

describe('open-tabs: updatePaneSnapshot', () => {
  it('生きているペインを記録し、window 番号を target から取る', () => {
    const next = updatePaneSnapshot(
      [],
      [livePane(SID_A), livePane(SID_A, { paneId: '%2' }), { claudeSessionId: null }],
      {
        tmuxAlive: true,
      },
    );
    assert.equal(next.length, 1);
    assert.equal(next[0].tmuxSession, 'main');
    assert.equal(next[0].windowIndex, 2);
  });

  it('tmux が応答しないときは前回のまま（終了処理中に消さない）', () => {
    const prev = [{ claudeSessionId: SID_A, missing: 0 }];
    assert.equal(updatePaneSnapshot(prev, [], { tmuxAlive: false }), prev);
  });

  it(`見えなくなったものは ${MISSING_LIMIT} 回続けて見えなかったら消す`, () => {
    let snap = updatePaneSnapshot([], [livePane(SID_A)], { tmuxAlive: true });
    snap = updatePaneSnapshot(snap, [], { tmuxAlive: true });
    assert.equal(snap.length, 1);
    assert.equal(snap[0].missing, 1);
    // また見えたら数え直し
    assert.equal(updatePaneSnapshot(snap, [livePane(SID_A)], { tmuxAlive: true })[0].missing, 0);
    snap = updatePaneSnapshot(snap, [], { tmuxAlive: true });
    assert.equal(snap.length, 0);
  });
});

describe('open-tabs: planRestore', () => {
  const tmuxTab = {
    type: 'tmux',
    id: 'tab-a',
    name: 'A',
    cwd: '/home/u/a',
    projectDir: '-home-u-a',
    claudeSessionId: SID_A,
  };
  const roTab = {
    type: 'readonly',
    id: 'tab-b',
    name: 'B',
    cwd: '/home/u/b',
    projectDir: '-home-u-b',
    claudeSessionId: SID_B,
  };

  it('ペインが生きていれば paneId が変わっていても claudeSessionId で繋ぎ直す', () => {
    const pane = livePane(SID_A, { paneId: '%9' });
    const plan = planRestore({ tabs: [tmuxTab, roTab] }, [pane], []);
    assert.deepEqual(plan.attach, [{ tab: tmuxTab, pane }]);
    assert.deepEqual(plan.readonly, [roTab]);
    assert.deepEqual(plan.pending, []);
  });

  it('tmux 外で動いていれば閲覧で開き、resume 候補にしない', () => {
    const plan = planRestore({ tabs: [tmuxTab] }, [], [{ sessionId: SID_A }]);
    assert.deepEqual(plan.readonly, [tmuxTab]);
    assert.deepEqual(plan.pending, []);
  });

  it('PC 再起動後（何も動いていない）はタブとスナップショットを再開待ちにまとめ、tmux の置き場所順に並べる', () => {
    const plan = planRestore(
      {
        tabs: [tmuxTab, roTab],
        panes: [
          {
            claudeSessionId: SID_A,
            cwd: '/home/u/a',
            tmuxSession: 'work',
            windowName: 'wa',
            windowIndex: 3,
            missing: 0,
          },
          {
            claudeSessionId: SID_C,
            cwd: '/home/u/c',
            tmuxSession: 'work',
            windowName: 'wc',
            windowIndex: 1,
            missing: 0,
          },
        ],
      },
      [],
      [],
    );
    assert.deepEqual(plan.attach, []);
    // 閲覧タブは動いていなくても閲覧のまま開き直す
    assert.deepEqual(plan.readonly, [roTab]);
    assert.deepEqual(
      plan.pending.map((p) => [p.claudeSessionId, p.windowName, p.tab]),
      [
        [SID_C, 'wc', null],
        [SID_A, 'wa', { id: 'tab-a', name: 'A' }],
      ],
    );
  });

  it('前回の再開待ちは毎回見直す（手で再開済みならタブだけ繋ぐ／タブでなければ消す）', () => {
    const pending = [
      {
        claudeSessionId: SID_A,
        cwd: '/home/u/a',
        tmuxSession: 'w',
        windowName: 'wa',
        windowIndex: 0,
        tab: { id: 'tab-a', name: 'A' },
      },
      { claudeSessionId: SID_C, cwd: '/home/u/c', tmuxSession: 'w', windowName: 'wc', windowIndex: 1, tab: null },
    ];
    const pane = livePane(SID_A);
    const plan = planRestore({ pending }, [pane, livePane(SID_C, { paneId: '%3' })], []);
    assert.equal(plan.attach.length, 1);
    assert.equal(plan.attach[0].tab.id, 'tab-a');
    assert.deepEqual(plan.pending, []);

    const still = planRestore({ pending }, [], []);
    assert.deepEqual(
      still.pending.map((p) => [p.claudeSessionId, p.tmuxSession, p.tab?.id ?? null]),
      [
        [SID_A, 'w', 'tab-a'],
        [SID_C, 'w', null],
      ],
    );
  });

  it('同じセッションが重複していても 1 件にまとめる', () => {
    const plan = planRestore(
      { tabs: [tmuxTab, { ...tmuxTab, id: 'tab-a2' }, roTab, roTab], panes: [{ claudeSessionId: SID_A, missing: 0 }] },
      [],
      [],
    );
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.pending[0].tab.id, 'tab-a');
    assert.equal(plan.readonly.length, 1);
  });
});

describe('open-tabs: upsertPaneSnapshot', () => {
  it('再開したペインを先頭に入れ、同じセッションの古い記録は置き換える', () => {
    const prev = [
      { claudeSessionId: SID_A, tmuxSession: 'old', windowName: 'x', windowIndex: 9, missing: 1 },
      { claudeSessionId: SID_B, tmuxSession: 'w', windowName: 'b', windowIndex: 1, missing: 0 },
    ];
    const next = upsertPaneSnapshot(prev, {
      claudeSessionId: SID_A,
      cwd: '/home/u/a',
      target: 'work:3.0',
      windowName: 'alpha',
    });
    assert.deepEqual(
      next.map((p) => [p.claudeSessionId, p.tmuxSession, p.windowIndex, p.missing]),
      [
        [SID_A, 'work', 3, 0],
        [SID_B, 'w', 1, 0],
      ],
    );
    assert.equal(upsertPaneSnapshot(prev, { claudeSessionId: null }), prev);
  });
});

describe('open-tabs: splitPending', () => {
  const withTab = {
    claudeSessionId: SID_A,
    cwd: '/home/u/a',
    projectDir: '-home-u-a',
    tab: { id: 'tab-a', name: 'A' },
  };
  const noTab = { claudeSessionId: SID_B, cwd: '/home/u/b', projectDir: '-home-u-b', tab: null };

  it('まだ動いていないものだけ resume に回す', () => {
    const out = splitPending([withTab, noTab], [], []);
    assert.deepEqual(out.resume, [withTab, noTab]);
  });

  it('tmux で動き出していれば、タブだったものは attach、そうでなければ skip', () => {
    const out = splitPending([withTab, noTab], [livePane(SID_A), livePane(SID_B, { paneId: '%2' })], []);
    assert.equal(out.attach.length, 1);
    assert.equal(out.attach[0].tab.id, 'tab-a');
    assert.deepEqual(out.skip, [noTab]);
    assert.deepEqual(out.resume, []);
  });

  it('tmux 外で動いていれば、タブだったものは閲覧で開く', () => {
    const out = splitPending([withTab, noTab], [], [{ sessionId: SID_A }, { sessionId: SID_B }]);
    assert.equal(out.readonly.length, 1);
    assert.equal(out.readonly[0].type, 'readonly');
    assert.equal(out.readonly[0].id, 'tab-a');
    assert.deepEqual(out.skip, [noTab]);
  });
});

describe('removePaneSnapshot', () => {
  const snap = [
    { claudeSessionId: 'a', cwd: '/x', tmuxSession: 's', windowIndex: 1, windowName: 'w', missing: 0 },
    { claudeSessionId: 'b', cwd: '/y', tmuxSession: 's', windowIndex: 2, windowName: 'w', missing: 0 },
  ];

  it('drops the terminated session', () => {
    assert.deepEqual(
      removePaneSnapshot(snap, 'a').map((p) => p.claudeSessionId),
      ['b'],
    );
  });

  it('keeps the list as-is without a claudeSessionId', () => {
    assert.equal(removePaneSnapshot(snap, null), snap);
  });
});
