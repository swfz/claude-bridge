import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompletion,
  completionChecks,
  completionTooltip,
  prOutcome,
  countByCompletion,
  filterByCompletion,
} from '../client/src/utils/completionState.js';

const clean = { edited: 2, git: 'clean', uncommitted: [], uncommittedCount: 0, pushed: false, prCount: 0 };
const pushed = { ...clean, pushed: true };
const withPr = { ...clean, pushed: true, prCount: 1 };
const dirty = { edited: 3, git: 'dirty', uncommitted: ['a.js', 'b.js'], uncommittedCount: 2, pushed: false, prCount: 0 };
const none = { edited: 0, git: 'none', uncommitted: [], uncommittedCount: 0, pushed: false, prCount: 0 };
const unknown = { edited: 1, git: 'unknown', uncommitted: [], uncommittedCount: 0, pushed: false, prCount: 0 };

describe('classifyCompletion', () => {
  it("is 'done' only when the edits are committed and pushed (or a PR was created)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: pushed }), 'done');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: withPr }), 'done');
  });

  it("is 'unpushed' when the edits are committed but neither pushed nor turned into a PR", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: clean }), 'unpushed');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: { ...clean, hasRemote: true } }), 'unpushed');
  });

  it("is 'done' once committed in a repository without any remote (nothing to push to)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: { ...clean, hasRemote: false } }), 'done');
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: { ...clean, hasRemote: false } }), [
      { label: 'ターン終了', ok: true },
      { label: 'コミット済み（編集 2 ファイル）', ok: true },
      { label: 'リモート無し（コミット＝反映）', ok: true },
    ]);
  });

  it("is 'consult' when nothing was edited and the last reply is not a question", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: none }), 'consult');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: null }), 'consult');
    assert.equal(
      classifyCompletion({ turnState: 'ended', completion: none, lastAssistantQuestion: false }),
      'consult',
    );
  });

  it("is 'asking' when nothing was edited and the last reply ends with a question", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: none, lastAssistantQuestion: true }), 'asking');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: null, lastAssistantQuestion: true }), 'asking');
  });

  it('ignores the question flag once something was edited', () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: dirty, lastAssistantQuestion: true }), 'unfinished');
    assert.equal(classifyCompletion({ turnState: 'ended', completion: clean, lastAssistantQuestion: true }), 'unpushed');
  });

  it("treats an unreadable cwd as 'done' (a removed worktree cannot hold uncommitted changes)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: unknown }), 'done');
  });

  it("does not let a push hide uncommitted edits ('unfinished' wins)", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: { ...dirty, pushed: true } }), 'unfinished');
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

describe('PR のマージ状態', () => {
  const pr = (n, state) => ({ url: `https://github.com/o/r/pull/${n}`, state });
  const withPrs = (base, prs) => ({ ...base, pushed: true, prCount: prs.length, prs });

  it('prOutcome summarizes the PRs', () => {
    assert.equal(prOutcome(null), null);
    assert.equal(prOutcome({ ...clean, prs: [] }), null);
    assert.equal(prOutcome(withPrs(clean, [pr(1, 'merged'), pr(2, 'open')])), 'open');
    assert.equal(prOutcome(withPrs(clean, [pr(1, 'merged'), pr(2, 'unknown')])), 'unknown');
    assert.equal(prOutcome(withPrs(clean, [pr(1, 'merged'), pr(2, 'closed')])), 'resolved');
  });

  it("is 'merging' while a PR is still open, and 'done' once all are merged or closed", () => {
    const ended = (completion) => classifyCompletion({ turnState: 'ended', completion });
    assert.equal(ended(withPrs(clean, [pr(1, 'open')])), 'merging');
    assert.equal(ended(withPrs(clean, [pr(2, 'merged'), pr(1, 'open')])), 'merging');
    assert.equal(ended(withPrs(clean, [pr(1, 'merged')])), 'done');
    assert.equal(ended(withPrs(clean, [pr(1, 'closed')])), 'done');
    // gh で読めない PR は完了に倒す
    assert.equal(ended(withPrs(clean, [pr(1, 'unknown')])), 'done');
    // git が読めなくても PR が開いていればマージ待ち
    assert.equal(ended(withPrs(unknown, [pr(1, 'open')])), 'merging');
  });

  it('judges a session that only shipped (no edits) by its PRs, not as a consultation', () => {
    const ended = (completion, extra = {}) => classifyCompletion({ turnState: 'ended', completion, ...extra });
    assert.equal(ended(withPrs(none, [pr(1, 'open')]), { lastAssistantQuestion: true }), 'merging');
    assert.equal(ended(withPrs(none, [pr(1, 'merged')])), 'done');
  });

  it("keeps 'unfinished' and 'interrupted' ahead of the PR state", () => {
    assert.equal(classifyCompletion({ turnState: 'ended', completion: withPrs(dirty, [pr(1, 'open')]) }), 'unfinished');
    assert.equal(classifyCompletion({ turnState: 'midway', completion: withPrs(clean, [pr(1, 'open')]) }), 'interrupted');
  });

  it('lists one check per PR instead of the push line', () => {
    const completion = withPrs(clean, [pr(4, 'open'), pr(3, 'merged'), pr(2, 'closed'), pr(1, 'unknown')]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion }), [
      { label: 'ターン終了', ok: true },
      { label: 'コミット済み（編集 2 ファイル）', ok: true },
      { label: 'PR #4 未マージ', ok: false },
      { label: 'PR #3 マージ済み', ok: true },
      { label: 'PR #2 マージせずクローズ', ok: true },
      { label: 'PR #1 状態を確認できず', ok: null },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: withPrs(none, [pr(9, 'merged')]) }), [
      { label: 'ターン終了', ok: true },
      { label: '編集なし', ok: true },
      { label: 'PR #9 マージ済み', ok: true },
    ]);
    assert.match(completionTooltip({ turnState: 'ended', completion: withPrs(clean, [pr(1, 'open')]) }), /^マージ待ち: /);
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
      { label: 'push / PR の記録なし（このセッション内）', ok: false },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: pushed }), [
      { label: 'ターン終了', ok: true },
      { label: 'コミット済み（編集 2 ファイル）', ok: true },
      { label: 'push 済み', ok: true },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: withPr }), [
      { label: 'ターン終了', ok: true },
      { label: 'コミット済み（編集 2 ファイル）', ok: true },
      { label: 'PR 作成済み', ok: true },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: none, lastAssistantQuestion: true }), [
      { label: 'ターン終了', ok: true },
      { label: '編集なし', ok: true },
      { label: '最後の応答が質問で終わっている', ok: false },
    ]);
    assert.deepEqual(completionChecks({ turnState: 'ended', completion: null }), [
      { label: 'ターン終了', ok: true },
      { label: '編集なし', ok: true },
      { label: '最後の応答は質問ではない', ok: true },
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

  it('describes the new states in the tooltip', () => {
    assert.match(completionTooltip({ turnState: 'ended', completion: clean }), /^反映前: /);
    assert.match(completionTooltip({ turnState: 'ended', completion: none }), /^相談のみ: /);
    assert.match(completionTooltip({ turnState: 'ended', completion: none, lastAssistantQuestion: true }), /^回答待ち: /);
  });

  it('marks undecidable checks with ?', () => {
    assert.match(completionTooltip({ completion: unknown }), /\? コミット状況を確認できず/);
  });
});

describe('countByCompletion / filterByCompletion', () => {
  const sessions = [
    { sessionId: 'a', turnState: 'ended', completion: dirty },
    { sessionId: 'b', turnState: 'midway', completion: clean },
    { sessionId: 'c', turnState: 'ended', completion: pushed },
    { sessionId: 'd', turnState: 'ended', completion: unknown },
    { sessionId: 'e', turnState: 'ended', completion: clean },
    { sessionId: 'f', turnState: 'ended', completion: none },
    { sessionId: 'g', turnState: 'ended', completion: none, lastAssistantQuestion: true },
  ];

  it('counts sessions per state', () => {
    assert.deepEqual(countByCompletion(sessions), {
      unfinished: 1,
      interrupted: 1,
      done: 2,
      unpushed: 1,
      consult: 1,
      asking: 1,
    });
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
