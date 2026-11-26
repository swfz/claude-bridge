import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  adjacentRef,
  anchorId,
  diffSourceKey,
  diffSourceLabel,
  diffSourceOptions,
  diffStatusLabel,
  findRowIndex,
  formatDiffComment,
  formatTurnTime,
  isNoChangeStatus,
  isRefScope,
  isSameDiffRequest,
  locateComment,
  normalizeDiffRef,
  normalizeDiffScope,
  parseDiffRows,
  quoteRows,
  rangeFromRows,
  summarizeDiff,
} from '../client/src/utils/diffView.js';
import { commentSource, createDiffCommentStore, diffCommentKey } from '../client/src/utils/diffComments.js';
import { buildNavList, findNavIndex, navCursor, navRange } from '../client/src/utils/diffNav.js';

describe('範囲と ref', () => {
  it('normalizeDiffScope は 4 つを通し、それ以外は全体', () => {
    for (const s of ['all', 'session', 'commit', 'turn']) assert.equal(normalizeDiffScope(s), s);
    assert.equal(normalizeDiffScope('x'), 'all');
    assert.equal(isRefScope('commit'), true);
    assert.equal(isRefScope('turn'), true);
    assert.equal(isRefScope('all'), false);
  });

  it('normalizeDiffRef は select の文字列のターン番号を数値に揃える', () => {
    assert.equal(normalizeDiffRef('turn', '3'), 3);
    assert.equal(normalizeDiffRef('turn', 3), 3);
    assert.equal(normalizeDiffRef('turn', 0), null);
    assert.equal(normalizeDiffRef('turn', '1e3'), null);
    assert.equal(normalizeDiffRef('commit', 'abc1234'), 'abc1234');
    assert.equal(normalizeDiffRef('commit', 'HEAD'), null);
    assert.equal(normalizeDiffRef('commit', 'abc'), null);
    assert.equal(normalizeDiffRef('all', 'abc1234'), null);
  });

  it('isSameDiffRequest は要求した ref（null＝最新）で照合する', () => {
    const open = { sessionId: 's', scope: 'turn', requestedRef: '3' };
    assert.equal(isSameDiffRequest(open, { sessionId: 's', scope: 'turn', ref: 3 }), true);
    assert.equal(isSameDiffRequest(open, { sessionId: 's', scope: 'turn', ref: 2 }), false);
    assert.equal(isSameDiffRequest(open, { sessionId: 's', scope: 'commit', ref: 3 }), false);
    assert.equal(isSameDiffRequest(open, { sessionId: 't', scope: 'turn', ref: 3 }), false);
    const latest = { sessionId: 's', scope: 'commit', requestedRef: null };
    assert.equal(
      isSameDiffRequest(latest, { sessionId: 's', scope: 'commit', ref: null, resolvedRef: 'abc1234' }),
      true,
    );
    // ref を返さない応答（作業ツリー）
    assert.equal(isSameDiffRequest({ sessionId: 's', scope: 'all' }, { sessionId: 's', scope: 'all' }), true);
    assert.equal(isSameDiffRequest(null, { sessionId: 's', scope: 'all' }), false);
  });

  it('diffSourceKey / diffSourceLabel', () => {
    assert.equal(diffSourceKey('all', null), 'wt');
    assert.equal(diffSourceKey('session', 'x'), 'wt');
    assert.equal(diffSourceKey('commit', 'abc1234'), 'commit:abc1234');
    assert.equal(diffSourceKey('turn', '3'), 'turn:3');
    assert.equal(diffSourceKey('turn', null), null);
    assert.equal(diffSourceLabel('commit:abc1234'), 'コミット abc1234');
    assert.equal(diffSourceLabel('turn:3'), 'ターン #3');
    assert.equal(diffSourceLabel('wt'), null);
    assert.equal(diffSourceLabel(undefined), null);
  });
});

describe('候補と送り', () => {
  const now = new Date(2026, 10, 26, 12, 0);
  it('formatTurnTime は今日なら時刻だけ', () => {
    assert.equal(formatTurnTime(new Date(2026, 10, 26, 9, 5).toISOString(), now), '09:05');
    assert.equal(formatTurnTime(new Date(2026, 10, 25, 23, 0).toISOString(), now), '11/25 23:00');
    assert.equal(formatTurnTime('bad', now), '');
  });

  it('diffSourceOptions はコミット「ハッシュ 件名」、ターン「#番号 時刻 指示の先頭」', () => {
    const sources = {
      commits: [{ hash: 'abc1234', subject: 'fix: x' }],
      turns: [{ index: 3, startedAt: new Date(2026, 10, 26, 9, 5).toISOString(), prompt: 'あ'.repeat(50) }],
    };
    assert.deepEqual(diffSourceOptions('commit', sources), [{ value: 'abc1234', label: 'abc1234 fix: x' }]);
    assert.deepEqual(diffSourceOptions('turn', sources, now), [{ value: '3', label: `#3 09:05 ${'あ'.repeat(40)}…` }]);
    assert.deepEqual(diffSourceOptions('all', sources), []);
    assert.deepEqual(diffSourceOptions('commit', null), []);
  });

  it('adjacentRef は新しい順の一覧で older / newer に送る', () => {
    const options = [{ value: 'c' }, { value: 'b' }, { value: 'a' }];
    assert.equal(adjacentRef(options, 'b', 'older'), 'a');
    assert.equal(adjacentRef(options, 'b', 'newer'), 'c');
    assert.equal(adjacentRef(options, 'a', 'older'), null);
    assert.equal(adjacentRef(options, 'c', 'newer'), null);
    assert.equal(adjacentRef(options, 'zz', 'older'), null);
    assert.equal(adjacentRef([{ value: '3' }, { value: '1' }], 3, 'older'), '1');
  });

  it('元に戻したファイルは差分なし', () => {
    assert.equal(diffStatusLabel('unchanged'), '差分なし（元に戻した）');
    assert.equal(isNoChangeStatus('unchanged'), true);
    assert.equal(isNoChangeStatus('modified'), false);
    assert.equal(summarizeDiff([{ status: 'unchanged' }, { status: 'modified', additions: 1 }]).changed, 1);
  });
});

describe('送信本文の時点', () => {
  const base = { path: 'src/app.js', side: 'new', start: 11, end: 11, quote: 'x', text: '直して' };
  it('作業ツリーは従来どおり', () => {
    assert.equal(formatDiffComment(base), 'src/app.js:L11 「x」について:\n直して');
    assert.equal(formatDiffComment({ ...base, source: 'wt' }), 'src/app.js:L11 「x」について:\n直して');
  });
  it('コミット', () => {
    assert.equal(
      formatDiffComment({ ...base, source: 'commit:abc1234' }),
      'src/app.js:L11（コミット abc1234 の時点） 「x」について:\n直して',
    );
    assert.equal(
      formatDiffComment({ ...base, source: 'commit:abc1234', side: 'old', oldPath: 'src/old.js' }),
      'src/old.js（コミット abc1234 で削除された行 旧L11） 「x」について:\n直して',
    );
  });
  it('ターン（終了時点・編集ごとの差分）', () => {
    assert.equal(
      formatDiffComment({ ...base, source: 'turn:3' }),
      'src/app.js:L11（ターン #3 の終了時点） 「x」について:\n直して',
    );
    assert.equal(
      formatDiffComment({ ...base, source: 'turn:3', side: 'old' }),
      'src/app.js（ターン #3 で削除された行 旧L11。ターン開始時点の行番号） 「x」について:\n直して',
    );
    assert.equal(
      formatDiffComment({ ...base, source: 'turn:3', perEdit: true }),
      'src/app.js:L11（ターン #3 の途中の編集の直後の行番号） 「x」について:\n直して',
    );
    assert.equal(
      formatDiffComment({ ...base, source: 'turn:3', perEdit: true, side: 'old', stale: true }),
      'src/app.js（ターン #3 の途中の編集で削除された行 旧L11。その編集の直前の行番号）（差分を取り直す前の行番号） 「x」について:\n直して',
    );
  });
});

describe('指摘のキーと出どころ', () => {
  it('作業ツリーのキーは従来の形、コミット・ターンは出どころを入れる', () => {
    const c = { sessionKey: 'k', path: 'a|b.js', side: 'new', start: 1, end: 2 };
    assert.equal(diffCommentKey(c), 'k|new|1-2|a|b.js');
    assert.equal(diffCommentKey({ ...c, source: 'wt' }), 'k|new|1-2|a|b.js');
    assert.equal(diffCommentKey({ ...c, source: 'commit:abc1234' }), 'k|commit:abc1234|new|1-2|a|b.js');
    assert.equal(diffCommentKey({ ...c, source: 'turn:3', hunk: 1 }), 'k|turn:3|new|1-2@1|a|b.js');
    assert.equal(commentSource({}), 'wt');
    assert.equal(commentSource({ source: 'turn:3' }), 'turn:3');
  });

  it('migrateSession は出どころを保ったままキーを作り直す（作業ツリーの同じ行と衝突しない）', () => {
    const store = createDiffCommentStore({ statusMs: 0 });
    const wt = { sessionKey: 'bridge', path: 'a.js', side: 'new', start: 1, end: 1 };
    const commit = { ...wt, source: 'commit:abc1234' };
    store.upsert('bridge', { ...wt, key: diffCommentKey(wt), text: 'wt' });
    store.upsert('bridge', { ...commit, key: diffCommentKey(commit), text: 'commit' });
    store.migrateSession('bridge', 'claude');
    assert.deepEqual(
      store.snapshot('claude').list.map((c) => [c.key, c.text]),
      [
        ['claude|new|1-1|a.js', 'wt'],
        ['claude|commit:abc1234|new|1-1|a.js', 'commit'],
      ],
    );
  });
});

describe('編集ごとの差分（同じ行番号の hunk）', () => {
  const patch = [
    'diff --git a/a.js b/a.js',
    '@@ -10,1 +10,1 @@ 編集 1/2',
    '-a',
    '+b',
    '@@ -10,1 +10,1 @@ 編集 2/2',
    '-b',
    '+c',
    '',
  ].join('\n');
  const rows = parseDiffRows(patch);
  const second = rows.findIndex((r) => r.kind === 'add' && r.hunk === 1);

  it('hunk を指定すると 2 つ目の hunk の行を引ける', () => {
    assert.equal(findRowIndex(rows, 'new', 10), 2);
    assert.equal(findRowIndex(rows, 'new', 10, 1), second);
    assert.equal(anchorId('new', 10), 'new:10');
    assert.equal(anchorId('new', 10, 1), 'new:10:1');
  });

  it('範囲・引用・位置づけが hunk の中に閉じる', () => {
    const range = rangeFromRows(rows, null, second, true);
    assert.deepEqual(range, { side: 'new', start: 10, end: 10, hunk: 1 });
    assert.equal(quoteRows(rows, range), 'c');
    assert.deepEqual(locateComment(rows, { ...range, quote: 'c' }), { startIdx: second, endIdx: second });
    // hunk を持たない（作業ツリーの）範囲は従来どおり
    assert.deepEqual(rangeFromRows(rows, null, second), { side: 'new', start: 10, end: 10 });
    assert.equal(rangeFromRows(rows, null, 0, true), null);
  });

  it('行カーソルも hunk で見分ける', () => {
    const nav = buildNavList([{ path: 'a.js', rows, byHunk: true }]);
    const i = nav.findIndex((n) => n.idx === second);
    assert.equal(nav[i].hunk, 1);
    const cursor = navCursor(nav[i]);
    assert.deepEqual(cursor, { path: 'a.js', side: 'new', line: 10, hunk: 1 });
    assert.equal(findNavIndex(nav, cursor), i);
    assert.deepEqual(navRange(nav, null, i), { side: 'new', start: 10, end: 10, hunk: 1 });
    // 別の hunk の行とは範囲にしない
    const first = nav.findIndex((n) => n.idx === 2);
    assert.deepEqual(navRange(nav, first, i), { side: 'new', start: 10, end: 10, hunk: 1 });
    assert.equal(navCursor(null), null);
    // byHunk でないファイルは hunk を持たない
    const plain = buildNavList([{ path: 'a.js', rows }]);
    assert.equal(plain[0].hunk, undefined);
    assert.deepEqual(navCursor(plain[0]), { path: 'a.js', side: 'old', line: 10 });
  });
});
