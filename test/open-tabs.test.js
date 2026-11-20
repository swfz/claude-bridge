import { describe, it, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
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
  OPEN_TABS_FILE,
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
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

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

describe('open-tabs: 値の検証の境界', () => {
  const longStr = (n) => 'x'.repeat(n);

  it('タブの id・name・cwd は長さの上限まで受け付ける', () => {
    const ok = sanitizeOpenTabs({
      tabs: [
        { type: 'readonly', id: 'i'.repeat(64), name: longStr(300), cwd: '/' + longStr(999), claudeSessionId: SID_A },
      ],
    }).tabs[0];
    assert.equal(ok.id, 'i'.repeat(64));
    assert.equal(ok.name, longStr(300));
    assert.equal(ok.cwd, '/' + longStr(999));

    const ng = sanitizeOpenTabs({
      tabs: [
        { type: 'readonly', id: 'i'.repeat(65), name: longStr(301), cwd: '/' + longStr(1000), claudeSessionId: SID_A },
      ],
    }).tabs[0];
    assert.equal(ng.id, null);
    assert.equal(ng.name, null);
    assert.equal(ng.cwd, null);
    assert.equal(ng.projectDir, null);
  });

  it('不正な id・文字列でない name / cwd は null にする', () => {
    const t = sanitizeOpenTabs({ tabs: [{ type: 'tmux', id: 'a b', name: 5, cwd: 5, claudeSessionId: SID_A }] })
      .tabs[0];
    assert.deepEqual(t, { type: 'tmux', id: null, name: null, cwd: null, projectDir: null, claudeSessionId: SID_A });
  });

  it('claudeSessionId は 64 文字まで・記号は - と _ だけ', () => {
    const out = sanitizeOpenTabs({
      tabs: [
        { type: 'tmux', claudeSessionId: 'a'.repeat(64) },
        { type: 'tmux', claudeSessionId: 'a'.repeat(65) },
        { type: 'tmux', claudeSessionId: 'a/b' },
        { type: 'tmux', claudeSessionId: 'x\n' },
        { type: 'tmux' },
      ],
    });
    assert.deepEqual(
      out.tabs.map((t) => t.claudeSessionId),
      ['a'.repeat(64)],
    );
  });

  it('正しい projectDir はそのまま使い、cwd からは作り直さない', () => {
    const t = sanitizeOpenTabs({
      tabs: [{ type: 'tmux', claudeSessionId: SID_A, cwd: '/home/u/p', projectDir: '-custom' }],
    }).tabs[0];
    assert.equal(t.projectDir, '-custom');
  });

  it('ペインの置き場所: tmux セッション名・window 名・window 番号・見えなかった回数', () => {
    const out = sanitizeOpenTabs({
      panes: [
        {
          claudeSessionId: SID_A,
          cwd: '/home/u/a',
          tmuxSession: 'work.1-x_',
          windowName: longStr(64),
          windowIndex: 0,
          missing: 1,
        },
        {
          claudeSessionId: SID_B,
          tmuxSession: 's'.repeat(65),
          windowName: longStr(65),
          windowIndex: 1.5,
          missing: -1,
        },
        { claudeSessionId: SID_C, tmuxSession: 's'.repeat(64), windowIndex: '3' },
      ],
    });
    assert.deepEqual(out.panes[0], {
      claudeSessionId: SID_A,
      cwd: '/home/u/a',
      projectDir: '-home-u-a',
      tmuxSession: 'work.1-x_',
      windowName: longStr(64),
      windowIndex: 0,
      missing: 1,
    });
    assert.equal(out.panes[1].tmuxSession, null);
    assert.equal(out.panes[1].windowName, null);
    assert.equal(out.panes[1].windowIndex, null);
    assert.equal(out.panes[1].missing, 0);
    assert.equal(out.panes[2].tmuxSession, 's'.repeat(64));
    assert.equal(out.panes[2].windowIndex, null);
  });

  it('ペイン・再開待ちのうち claudeSessionId の無いもの・オブジェクトでないものは捨てる', () => {
    const out = sanitizeOpenTabs({
      panes: [null, 'x', { claudeSessionId: 'bad id' }, { cwd: '/x' }],
      pending: [null, 'x', { claudeSessionId: 'bad id' }, {}],
    });
    assert.deepEqual(out, { tabs: [], panes: [], pending: [] });
  });

  it('再開待ちの値を検証する（タブ情報はオブジェクトのときだけ）', () => {
    const out = sanitizeOpenTabs({
      pending: [
        {
          claudeSessionId: SID_A,
          name: longStr(300),
          cwd: '/home/u/a',
          tmuxSession: 'w',
          windowName: 'wa',
          windowIndex: 2,
          tab: { id: 'i'.repeat(65), name: longStr(301) },
        },
        { claudeSessionId: SID_B, name: longStr(301), tab: 'tab-b' },
        { claudeSessionId: SID_C, tab: { id: 'ok', name: 'N' } },
      ],
    });
    assert.deepEqual(out.pending[0], {
      claudeSessionId: SID_A,
      name: longStr(300),
      cwd: '/home/u/a',
      projectDir: '-home-u-a',
      tmuxSession: 'w',
      windowName: 'wa',
      windowIndex: 2,
      tab: { id: null, name: null },
    });
    assert.equal(out.pending[1].name, null);
    assert.equal(out.pending[1].tab, null);
    assert.deepEqual(out.pending[2].tab, { id: 'ok', name: 'N' });
  });

  it('各一覧は 100 件までに切る', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ type: 'readonly', claudeSessionId: `s-${i}` }));
    const out = sanitizeOpenTabs({ tabs: many, panes: many, pending: many });
    assert.equal(out.tabs.length, 100);
    assert.equal(out.panes.length, 100);
    assert.equal(out.pending.length, 100);
    assert.equal(out.tabs[99].claudeSessionId, 's-99');
  });

  it('データそのものが無ければ空', () => {
    assert.deepEqual(sanitizeOpenTabs(null), { tabs: [], panes: [], pending: [] });
    assert.deepEqual(sanitizeOpenTabs(undefined), { tabs: [], panes: [], pending: [] });
  });
});

describe('open-tabs: 保存ファイル', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-tabs-file-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('既定の保存先は <dataDir>/open-tabs.json', () => {
    assert.equal(OPEN_TABS_FILE, join(dataDir, 'open-tabs.json'));
  });

  it('読み込み時に不正なエントリを捨てる', () => {
    const file = join(dir, 'dirty.json');
    writeFileSync(file, JSON.stringify({ tabs: [{ type: 'pty', claudeSessionId: SID_A }], panes: 'x' }));
    assert.deepEqual(loadOpenTabs(file), { tabs: [], panes: [], pending: [] });
  });

  it('人が読める形（2 スペース字下げ）で書き、一時ファイルを残さない', () => {
    const file = join(dir, 'pretty.json');
    const state = { tabs: [], panes: [], pending: [] };
    saveOpenTabs(state, file);
    assert.equal(readFileSync(file, 'utf-8'), JSON.stringify(state, null, 2));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.startsWith('pretty.json')),
      ['pretty.json'],
    );
  });
});

describe('open-tabs: tabsFromSessions の詳細', () => {
  it('alive を持たないタブも生きているものとして残し、保存する項目だけに絞る', () => {
    const tabs = tabsFromSessions([
      {
        id: 't1',
        type: 'tmux',
        name: 'T',
        cwd: '/home/u/p',
        projectDir: '-p',
        claudeSessionId: SID_A,
        paneId: '%1',
        status: 'idle',
      },
    ]);
    assert.deepEqual(tabs, [
      { type: 'tmux', id: 't1', name: 'T', cwd: '/home/u/p', projectDir: '-p', claudeSessionId: SID_A },
    ]);
  });
});

describe('open-tabs: スナップショットの更新の詳細', () => {
  it('target から tmux セッション名と window 番号を取り、合わなければ null', () => {
    const snap = updatePaneSnapshot(
      [],
      [
        livePane(SID_A, { target: 'my.sess:12.34' }),
        livePane(SID_B, { target: 'nopane:2' }),
        livePane('sid-tail', { target: 'x:1.2x' }),
        livePane(SID_C, { target: '' }),
      ],
      { tmuxAlive: true },
    );
    assert.deepEqual(
      snap.map((p) => [p.claudeSessionId, p.tmuxSession, p.windowIndex, p.windowName, p.cwd, p.missing]),
      [
        [SID_A, 'my.sess', 12, 'w', '/home/u/proj', 0],
        [SID_B, null, null, 'w', '/home/u/proj', 0],
        ['sid-tail', null, null, 'w', '/home/u/proj', 0],
        [SID_C, null, null, 'w', '/home/u/proj', 0],
      ],
    );
  });

  it('見えている間は前回の記録を引き継がず、今の置き場所で書き直す', () => {
    const prev = [{ claudeSessionId: SID_A, tmuxSession: 'old', windowName: 'x', windowIndex: 9, missing: 0 }];
    const next = updatePaneSnapshot(prev, [livePane(SID_A, { target: 'new:1.0' })], { tmuxAlive: true });
    assert.equal(next.length, 1);
    assert.equal(next[0].tmuxSession, 'new');
    assert.equal(next[0].missing, 0);
  });

  it('見えなかったものは記録を保ったまま回数だけ増やし、見えているものの後ろに置く', () => {
    const prev = [{ claudeSessionId: SID_A, cwd: '/a', tmuxSession: 'w', windowName: 'x', windowIndex: 1, missing: 0 }];
    const next = updatePaneSnapshot(prev, [livePane(SID_B)], { tmuxAlive: true });
    assert.deepEqual(
      next.map((p) => p.claudeSessionId),
      [SID_B, SID_A],
    );
    assert.deepEqual(next[1], { ...prev[0], missing: 1 });
    assert.equal(MISSING_LIMIT, 2);
  });

  it('100 件までに切る', () => {
    const live = Array.from({ length: 101 }, (_, i) => livePane(`s-${i}`));
    assert.equal(updatePaneSnapshot([], live, { tmuxAlive: true }).length, 100);
    const prev = Array.from({ length: 100 }, (_, i) => ({ claudeSessionId: `p-${i}`, missing: 0 }));
    const next = upsertPaneSnapshot(prev, livePane(SID_A));
    assert.equal(next.length, 100);
    assert.equal(next[0].claudeSessionId, SID_A);
  });
});

describe('open-tabs: planRestore の詳細', () => {
  const tmuxTab = (sid, extra = {}) => ({
    type: 'tmux',
    id: `tab-${sid.slice(0, 4)}`,
    name: 'T',
    cwd: '/home/u/t',
    projectDir: '-home-u-t',
    claudeSessionId: sid,
    ...extra,
  });

  it('引数を省いても空の計画を返す', () => {
    assert.deepEqual(planRestore({}), { attach: [], readonly: [], pending: [] });
  });

  it('再開待ちの値はタブを優先し、足りない置き場所をスナップショットで補う', () => {
    const plan = planRestore(
      {
        tabs: [tmuxTab(SID_A, { cwd: '/from-tab', projectDir: null })],
        panes: [
          {
            claudeSessionId: SID_A,
            cwd: '/from-pane',
            projectDir: '-from-pane',
            tmuxSession: 'work',
            windowName: 'wa',
            windowIndex: 0,
            missing: 0,
          },
        ],
      },
      [],
      [],
    );
    assert.deepEqual(plan.pending, [
      {
        claudeSessionId: SID_A,
        tab: { id: 'tab-aaaa', name: 'T' },
        name: 'T',
        cwd: '/from-tab',
        projectDir: '-from-pane',
        tmuxSession: 'work',
        windowName: 'wa',
        windowIndex: 0,
      },
    ]);
  });

  it('どこにも無い置き場所は再開待ちの項目にしない', () => {
    const plan = planRestore({ tabs: [tmuxTab(SID_A)] }, [], []);
    assert.deepStrictEqual(plan.pending, [
      {
        claudeSessionId: SID_A,
        tab: { id: 'tab-aaaa', name: 'T' },
        name: 'T',
        cwd: '/home/u/t',
        projectDir: '-home-u-t',
      },
    ]);
  });

  it('タブだった再開待ちは、前回の置き場所を引き継ぐ', () => {
    const plan = planRestore(
      {
        pending: [
          {
            claudeSessionId: SID_A,
            name: 'old-name',
            cwd: '/a',
            projectDir: '-a',
            tmuxSession: 'w',
            windowName: 'wa',
            windowIndex: 4,
            tab: { id: 'tab-a', name: 'A' },
          },
        ],
      },
      [],
      [],
    );
    assert.deepEqual(plan.pending, [
      {
        claudeSessionId: SID_A,
        tab: { id: 'tab-a', name: 'A' },
        name: 'A',
        cwd: '/a',
        projectDir: '-a',
        tmuxSession: 'w',
        windowName: 'wa',
        windowIndex: 4,
      },
    ]);
  });

  it('タブだった再開待ちが tmux 外で動いていれば閲覧で開く', () => {
    const plan = planRestore(
      { pending: [{ claudeSessionId: SID_A, cwd: '/a', projectDir: '-a', tab: { id: 'tab-a', name: 'A' } }] },
      [],
      [{ sessionId: SID_A }],
    );
    assert.deepEqual(plan.readonly, [
      { type: 'tmux', id: 'tab-a', name: 'A', claudeSessionId: SID_A, cwd: '/a', projectDir: '-a' },
    ]);
    assert.deepEqual(plan.pending, []);
  });

  it('タブでもあり再開待ちでもあるものは 1 件にまとめ、タブの値を優先する', () => {
    const plan = planRestore(
      {
        tabs: [tmuxTab(SID_A)],
        pending: [
          {
            claudeSessionId: SID_A,
            cwd: '/old',
            tmuxSession: 'w',
            windowName: 'wa',
            windowIndex: 1,
            tab: { id: 'tab-old', name: 'Old' },
          },
        ],
      },
      [],
      [],
    );
    assert.equal(plan.pending.length, 1);
    assert.deepEqual(plan.pending[0].tab, { id: 'tab-aaaa', name: 'T' });
    assert.equal(plan.pending[0].cwd, '/home/u/t');
    assert.equal(plan.pending[0].tmuxSession, 'w');
  });

  it('タブでなかった再開待ちとスナップショットが同じセッションなら 1 件にまとめる', () => {
    const plan = planRestore(
      {
        pending: [{ claudeSessionId: SID_C, cwd: '/c', tab: null }],
        panes: [{ claudeSessionId: SID_C, tmuxSession: 'w', windowName: 'wc', windowIndex: 2, missing: 1 }],
      },
      [],
      [],
    );
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.pending[0].cwd, '/c');
    assert.equal(plan.pending[0].windowName, 'wc');
    assert.equal(plan.pending[0].tab, null);
  });

  it('動いているスナップショット・tmux 外で動いている再開待ちは再開待ちにしない', () => {
    const plan = planRestore(
      {
        pending: [{ claudeSessionId: SID_B, tab: null }],
        panes: [{ claudeSessionId: SID_C, missing: 0 }],
      },
      [livePane(SID_C)],
      [{ sessionId: SID_B }],
    );
    assert.deepEqual(plan, { attach: [], readonly: [], pending: [] });
  });

  it('claudeSessionId の無いペイン・起動中セッションは突き合わせに使わない', () => {
    const plan = planRestore(
      { tabs: [tmuxTab(SID_A)] },
      [{ ...livePane(SID_A), claudeSessionId: null }],
      [{ sessionId: null }, {}],
    );
    assert.equal(plan.attach.length, 0);
    assert.equal(plan.readonly.length, 0);
    assert.equal(plan.pending.length, 1);
  });

  it('同じセッションの tmux タブが重複していても繋ぎ直すのは 1 回', () => {
    const pane = livePane(SID_A);
    const plan = planRestore({ tabs: [tmuxTab(SID_A), tmuxTab(SID_A, { id: 'tab-dup' })] }, [pane], []);
    assert.deepEqual(plan.attach, [{ tab: tmuxTab(SID_A), pane }]);
  });

  it('同じセッションのペインが複数あれば最初のものに繋ぐ', () => {
    const first = livePane(SID_A, { paneId: '%1' });
    const plan = planRestore({ tabs: [tmuxTab(SID_A)] }, [first, livePane(SID_A, { paneId: '%2' })], []);
    assert.equal(plan.attach[0].pane, first);
  });

  it('再開待ちは tmux セッション名順、同じセッションは window 番号順、どちらも無いものは後ろ', () => {
    const p = (sid, tmuxSession, windowIndex) => ({ claudeSessionId: sid, tmuxSession, windowIndex, missing: 0 });
    const plan = planRestore(
      {
        panes: [
          p('s-none', null, null),
          p('s-b1', 'b', 1),
          p('s-a-null', 'a', null),
          p('s-a2', 'a', 2),
          p('s-a10', 'a', 10),
          p('s-none-idx', null, 0),
        ],
      },
      [],
      [],
    );
    assert.deepEqual(
      plan.pending.map((x) => x.claudeSessionId),
      ['s-a2', 's-a10', 's-a-null', 's-b1', 's-none-idx', 's-none'],
    );
  });
});

describe('open-tabs: splitPending の詳細', () => {
  it('引数を省いたら全部 resume', () => {
    const p = { claudeSessionId: SID_A, tab: null };
    assert.deepEqual(splitPending([p]), { attach: [], readonly: [], skip: [], resume: [p] });
  });

  it('タブだったものは保存した cwd・projectDir でタブを作り直す', () => {
    const p = {
      claudeSessionId: SID_A,
      cwd: '/a',
      projectDir: '-a',
      tmuxSession: 'w',
      tab: { id: 'tab-a', name: 'A' },
    };
    const pane = livePane(SID_A);
    const out = splitPending([p], [pane], []);
    assert.deepEqual(out.attach, [
      { tab: { type: 'tmux', id: 'tab-a', name: 'A', claudeSessionId: SID_A, cwd: '/a', projectDir: '-a' }, pane },
    ]);
    const ro = splitPending([p], [], [{ sessionId: SID_A }]);
    assert.deepEqual(ro.readonly, [
      { type: 'readonly', id: 'tab-a', name: 'A', claudeSessionId: SID_A, cwd: '/a', projectDir: '-a' },
    ]);
  });

  it('claudeSessionId の無いペイン・起動中セッションは突き合わせに使わない', () => {
    const p = { claudeSessionId: SID_A, tab: null };
    const out = splitPending([p], [{ ...livePane(SID_A), claudeSessionId: undefined }], [{ sessionId: undefined }]);
    assert.deepEqual(out.resume, [p]);
  });
});

describe('removePaneSnapshot: 一致しないもの', () => {
  it('同じ claudeSessionId のものだけ外し、空文字では何もしない', () => {
    const snap = [{ claudeSessionId: 'a' }, { claudeSessionId: 'b' }];
    assert.deepEqual(removePaneSnapshot(snap, 'c'), snap);
    assert.equal(removePaneSnapshot(snap, ''), snap);
  });
});
