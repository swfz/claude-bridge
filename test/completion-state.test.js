import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompletion,
  completionChecks,
  completionTooltip,
  countByCompletion,
  filterByCompletion,
} from '../client/src/utils/completionState.js';

const clean = { edited: 2, git: 'clean', uncommitted: [], uncommittedCount: 0 };
const dirty = { edited: 3, git: 'dirty', uncommitted: ['a.js', 'b.js'], uncommittedCount: 2 };
const none = { edited: 0, git: 'none', uncommitted: [], uncommittedCount: 0 };
const unknown = { edited: 1, git: 'unknown', uncommitted: [], uncommittedCount: 0 };

describe('classifyCompletion', () => {
  it("is 'done' when the turn ended and edited files are committed (or nothing was edited)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: clean }), 'done');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: none }), 'done');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: null }), 'done');
  });

  it("treats an unreadable cwd as 'done' (a removed worktree cannot hold uncommitted changes)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: unknown }), 'done');
  });

  it("is 'unfinished' when edited files are still uncommitted", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: dirty }), 'unfinished');
  });

  it("is 'interrupted' whenever the last turn did not end normally", () => {
    for (const turnState of ['midway', 'prompt', 'interrupted', 'error']) {
      assert.equal(classifyCompletion({ turnState, completion: clean }), 'interrupted', turnState);
    }
    // 未コミットが残っていても、途中で止まっていることを優先して見せる
    assert.equal(classifyCompletion({ turnState: 'midway', completion: dirty }), 'interrupted');
  });

  it('uses status and waitingFor only for running sessions', () => {
    const busy = { status: 'busy', turnState: 'midway', completion: dirty };
    assert.equal(classifyCompletion(busy, { running: true }), 'working');
    assert.equal(classifyCompletion(busy), 'interrupted');

    const waiting = { status: 'idle', waitingFor: 'permission prompt', turnState: 'midway' };
    assert.equal(classifyCompletion(waiting, { running: true }), 'waiting');
    assert.equal(classifyCompletion({ ...waiting, status: 'busy' }, { running: true }), 'waiting');

    const idle = { status: 'idle', turnState: 'ended', completion: dirty };
    assert.equal(classifyCompletion(idle, { running: true }), 'unfinished');
  });

  it('returns null without a session', () => {
    assert.equal(classifyCompletion(null), null);
  });
});

describe('completionChecks / completionTooltip', () => {
  it('lists the checks with their outcome', () => {
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: dirty }), [
      { label: 'ターン終了', ok: true },
      { label: '未コミット 2 ファイル', ok: false },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'error', completion: clean }, { running: true }), [
      { label: 'API エラーで終了', ok: false },
      { label: '返事待ちなし', ok: true },
      { label: 'コミット済み（編集 2 ファイル）', ok: true },
    ]);
    assert.deepEqual(completionChecks({ turnState: null, completion: unknown }), [
      { label: 'ターン終了', ok: null },
      { label: 'コミット状況を確認できず（cwd が無い / git 管理外）', ok: null },
    ]);
  });

  it('builds a tooltip with the uncommitted files and the away summary', () => {
    const tip = completionTooltip({
      turnState: 'ended',
      completion: { ...dirty, uncommittedCount: 5 },
      awaySummary: { text: '次は方針を決めてください', timestamp: '' },
    });
    assert.equal(
      tip,
      [
        'やり残し: ターンは終わったが、編集したファイルに未コミットの変更がある',
        '✓ ターン終了',
        '✗ 未コミット 5 ファイル',
        '',
        '  a.js',
        '  b.js',
        '  …ほか 3 ファイル',
        '',
        '現状: 次は方針を決めてください',
      ].join('\n'),
    );
  });

  it('marks undecidable checks with ?', () => {
    assert.match(completionTooltip({ completion: unknown }), /\? コミット状況を確認できず/);
  });
});

describe('countByCompletion / filterByCompletion', () => {
  const sessions = [
    { sessionId: 'a', turnState: 'ended', completion: dirty },
    { sessionId: 'b', turnState: 'midway', completion: clean },
    { sessionId: 'c', turnState: 'ended', completion: clean },
    { sessionId: 'd', turnState: 'ended', completion: none },
  ];

  it('counts sessions per state', () => {
    assert.deepEqual(countByCompletion(sessions), { unfinished: 1, interrupted: 1, done: 2 });
    assert.deepEqual(countByCompletion([]), {});
  });

  it('filters by state, or returns the list as is without a filter', () => {
    assert.deepEqual(
      filterByCompletion(sessions, 'done').map((s) => s.sessionId),
      ['c', 'd'],
    );
    assert.equal(filterByCompletion(sessions, ''), sessions);
  });
});
