import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  QUOTE_MAX,
  findRowIndex,
  formatDiffComment,
  isContiguousSide,
  isCommentableRow,
  lineLabel,
  locateComment,
  locateRange,
  parseDiffRows,
  parseHunkHeader,
  quoteRows,
  rangeFromRows,
  rowAnchor,
  rowCode,
  truncateQuote,
} from '../client/src/utils/diffView.js';
import { createDiffCommentStore, diffCommentKey, groupByPath, isUnsent } from '../client/src/utils/diffComments.js';
import { BLOCKING_DRAWER_SELECTOR, isBlockingDrawerOpen } from '../client/src/utils/drawers.js';

const PATCH = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -10,4 +10,5 @@ function foo() {',
  ' const a = 1;',
  '-const b = 2;',
  '--- old marker',
  '+const b = 3;',
  '+++ new marker',
  '+const c = 4;',
  ' return a;',
  '@@ -30 +31 @@',
  '-x',
  '+y',
  '\\ No newline at end of file',
  '',
].join('\n');

const lines = (rows) => rows.map((r) => [r.kind, r.oldLine, r.newLine, r.hunk]);

describe('parseHunkHeader', () => {
  it('件数の省略は 1、関数名付きも読む', () => {
    assert.deepEqual(parseHunkHeader('@@ -3 +4 @@'), { oldStart: 3, oldCount: 1, newStart: 4, newCount: 1 });
    assert.deepEqual(parseHunkHeader('@@ -0,0 +1,3 @@ x'), { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 });
    assert.equal(parseHunkHeader('+foo'), null);
    assert.equal(parseHunkHeader(null), null);
  });
});

describe('parseDiffRows', () => {
  it('行ごとに旧・新の行番号と hunk 番号を付ける', () => {
    assert.deepEqual(lines(parseDiffRows(PATCH)), [
      ['hunk', null, null, 0],
      ['ctx', 10, 10, 0],
      ['del', 11, null, 0],
      ['del', 12, null, 0], // 本文が -- で始まる削除行
      ['add', null, 11, 0],
      ['add', null, 12, 0], // 本文が ++ で始まる追加行
      ['add', null, 13, 0],
      ['ctx', 13, 14, 0],
      ['hunk', null, null, 1],
      ['del', 30, null, 1],
      ['add', null, 31, 1],
      ['meta', null, null, 1], // \ No newline は番号を進めない
    ]);
  });

  it('未追跡ファイル（-0,0）は新しい側だけ 1 から', () => {
    const rows = parseDiffRows('diff --git a/n b/n\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    assert.deepEqual(lines(rows), [
      ['hunk', null, null, 0],
      ['add', null, 1, 0],
      ['add', null, 2, 0],
    ]);
  });

  it('削除ファイル（+0,0）は旧い側だけ', () => {
    const rows = parseDiffRows('@@ -1,2 +0,0 @@\n-a\n-b\n');
    assert.deepEqual(lines(rows).slice(1), [
      ['del', 1, null, 0],
      ['del', 2, null, 0],
    ]);
  });

  it('壊れた hunk 見出しでも落ちない', () => {
    const rows = parseDiffRows('@@ broken @@\n+a\n');
    assert.deepEqual(lines(rows), [
      ['hunk', null, null, 0],
      ['add', null, 0, 0],
    ]);
    assert.deepEqual(parseDiffRows(''), []);
  });
});

describe('行の扱い', () => {
  const rows = parseDiffRows(PATCH);

  it('rowAnchor は削除行を old、それ以外を new にする', () => {
    assert.deepEqual(rowAnchor(rows[1]), { side: 'new', line: 10 });
    assert.deepEqual(rowAnchor(rows[2]), { side: 'old', line: 11 });
    assert.deepEqual(rowAnchor(rows[4]), { side: 'new', line: 11 });
    assert.equal(rowAnchor(rows[0]), null);
    assert.equal(rowAnchor(rows[11]), null);
    assert.equal(isCommentableRow(null), false);
  });

  it('rowCode は先頭の記号を外す', () => {
    assert.equal(rowCode(rows[3]), '-- old marker');
    assert.equal(rowCode(null), '');
  });

  it('findRowIndex は側と行番号で引く（旧 L11 と新 L11 を取り違えない）', () => {
    assert.equal(findRowIndex(rows, 'old', 11), 2);
    assert.equal(findRowIndex(rows, 'new', 11), 4);
    assert.equal(findRowIndex(rows, 'new', 99), -1);
    assert.equal(findRowIndex(null, 'new', 1), -1);
  });

  it('rangeFromRows は同じ hunk・同じ側だけ範囲にする', () => {
    assert.deepEqual(rangeFromRows(rows, null, 4), { side: 'new', start: 11, end: 11 });
    assert.deepEqual(rangeFromRows(rows, 6, 4), { side: 'new', start: 11, end: 13 });
    // 文脈行（new）から追加行（new）へは、間に削除行を挟まなければ範囲になる
    assert.deepEqual(rangeFromRows(rows, 4, 7), { side: 'new', start: 11, end: 14 });
    // 間に削除行を挟む new どうしは範囲にしない（押した 1 行）
    assert.deepEqual(rangeFromRows(rows, 1, 7), { side: 'new', start: 14, end: 14 });
    // 削除行どうし
    assert.deepEqual(rangeFromRows(rows, 2, 3), { side: 'old', start: 11, end: 12 });
    // 側が違えば押した行だけ
    assert.deepEqual(rangeFromRows(rows, 2, 5), { side: 'new', start: 12, end: 12 });
    // hunk が違えば押した行だけ
    assert.deepEqual(rangeFromRows(rows, 4, 10), { side: 'new', start: 31, end: 31 });
    // 起点が hunk 見出し
    assert.deepEqual(rangeFromRows(rows, 0, 4), { side: 'new', start: 11, end: 11 });
    // 付けられない行
    assert.equal(rangeFromRows(rows, null, 0), null);
    assert.equal(rangeFromRows(undefined, null, 0), null);
  });

  it('削除行の範囲は間の文脈行をまたがない（-a 旧30 / 文脈 旧31・新40 / -b 旧32 / +c）', () => {
    const r = parseDiffRows('@@ -30,3 +40,2 @@\n-a\n ctx\n-b\n+c\n');
    assert.deepEqual(lines(r).slice(1), [
      ['del', 30, null, 0],
      ['ctx', 31, 40, 0],
      ['del', 32, null, 0],
      ['add', null, 41, 0],
    ]);
    // -a をクリックして -b を Shift+クリック → -b の 1 行（旧L30-L32 にしない）
    assert.deepEqual(rangeFromRows(r, 1, 3), { side: 'old', start: 32, end: 32 });
    assert.equal(isContiguousSide(r, 1, 3, 'old'), false);
    // 文脈行（新40）から +c（新41）は間に -b を挟むので範囲にしない
    assert.deepEqual(rangeFromRows(r, 2, 4), { side: 'new', start: 41, end: 41 });
    // 既に「旧L30-L32」を持っていても、今の行では途切れているので当てない
    assert.equal(locateRange(r, { side: 'old', start: 30, end: 32 }), null);
    // 続いている削除行どうしは範囲になる
    const r2 = parseDiffRows('@@ -30,3 +30,0 @@\n-a\n-b\n-c\n');
    assert.deepEqual(rangeFromRows(r2, 3, 1), { side: 'old', start: 30, end: 32 });
    assert.equal(isContiguousSide(r2, 1, 3, 'old'), true);
    assert.equal(isContiguousSide(r2, 0, 1, 'old'), false);
  });

  it('locateRange は両端が同じ hunk にあるときだけ当たる', () => {
    assert.deepEqual(locateRange(rows, { side: 'new', start: 11, end: 13 }), { startIdx: 4, endIdx: 6 });
    assert.deepEqual(locateRange(rows, { side: 'old', start: 30, end: 30 }), { startIdx: 9, endIdx: 9 });
    assert.equal(locateRange(rows, { side: 'new', start: 50, end: 50 }), null);
    assert.equal(locateRange(rows, { side: 'new', start: 11, end: 99 }), null);
    assert.equal(locateRange(rows, { side: 'new', start: 14, end: 31 }), null);
  });

  it('locateComment は本文がずれた指摘を当てない', () => {
    const c = { side: 'new', start: 11, end: 11, quote: 'const b = 3;' };
    assert.deepEqual(locateComment(rows, c), { startIdx: 4, endIdx: 4 });
    assert.equal(locateComment(rows, { ...c, quote: 'const b = 2;' }), null);
    assert.equal(locateComment(rows, { ...c, start: 99, end: 99 }), null);
    // 引用を持たないものは行番号だけで当てる
    assert.deepEqual(locateComment(rows, { side: 'new', start: 11, end: 11 }), { startIdx: 4, endIdx: 4 });
  });

  it('quoteRows は範囲の行を trim して ⏎ でつなぐ', () => {
    assert.equal(quoteRows(rows, { side: 'new', start: 11, end: 12 }), 'const b = 3; ⏎ ++ new marker');
    assert.equal(quoteRows(rows, { side: 'old', start: 11, end: 11 }), 'const b = 2;');
    assert.equal(quoteRows(null, { side: 'old', start: 1, end: 1 }), '');
  });

  it('truncateQuote は 120 文字で切る', () => {
    assert.equal(truncateQuote('a'.repeat(QUOTE_MAX)), 'a'.repeat(QUOTE_MAX));
    assert.equal(truncateQuote(`  ${'b'.repeat(QUOTE_MAX + 5)}`), `${'b'.repeat(QUOTE_MAX)}…`);
    assert.equal(truncateQuote(null), '');
  });
});

describe('送信本文', () => {
  it('lineLabel', () => {
    assert.equal(lineLabel({ side: 'new', start: 12, end: 12 }), 'L12');
    assert.equal(lineLabel({ side: 'new', start: 12, end: 15 }), 'L12-L15');
    assert.equal(lineLabel({ side: 'old', start: 30, end: 30 }), '旧L30');
    assert.equal(lineLabel({ side: 'old', start: 30, end: 31 }), '旧L30-L31');
  });

  it('追加・文脈行は path:L12、削除行は「削除された行 旧L30」（rename は旧パス）', () => {
    assert.equal(
      formatDiffComment({ path: 'src/a.js', side: 'new', start: 12, end: 12, quote: 'x = 1', text: ' 名前 ' }),
      'src/a.js:L12 「x = 1」について:\n名前',
    );
    assert.equal(
      formatDiffComment({
        path: 'src/b.js',
        oldPath: 'src/a.js',
        side: 'old',
        start: 30,
        end: 31,
        quote: 'y',
        text: '戻して',
      }),
      'src/a.js（削除された行 旧L30-L31） 「y」について:\n戻して',
    );
    assert.equal(
      formatDiffComment({ path: 'a', side: 'old', start: 3, end: 3, quote: '', text: 't' }),
      'a（削除された行 旧L3） について:\nt',
    );
  });

  it('対象行が見つからないものは「取り直す前の行番号」と添える', () => {
    assert.equal(
      formatDiffComment({ path: 'a', side: 'new', start: 1, end: 2, quote: 'q', text: 't', stale: true }),
      'a:L1-L2（差分を取り直す前の行番号） 「q」について:\nt',
    );
  });
});

describe('diffComments store', () => {
  const c = (path, start, text = '', extra = {}) => ({
    key: diffCommentKey({ sessionKey: 's', path, side: 'new', start, end: start }),
    path,
    side: 'new',
    start,
    end: start,
    quote: '',
    text,
    sendingId: null,
    ...extra,
  });

  it('diffCommentKey は側と範囲で区別する', () => {
    const base = { sessionKey: 's', path: 'a', start: 1, end: 1 };
    assert.notEqual(diffCommentKey({ ...base, side: 'new' }), diffCommentKey({ ...base, side: 'old' }));
    assert.notEqual(diffCommentKey({ ...base, side: 'new' }), diffCommentKey({ ...base, side: 'new', end: 2 }));
    assert.notEqual(
      diffCommentKey({ ...base, side: 'new' }),
      diffCommentKey({ ...base, side: 'new', sessionKey: 't' }),
    );
  });

  it('isUnsent は本文があり送信中でないもの', () => {
    assert.equal(isUnsent(c('a', 1, 'x')), true);
    assert.equal(isUnsent(c('a', 1, '  ')), false);
    assert.equal(isUnsent(c('a', 1, 'x', { sendingId: 'r' })), false);
    assert.equal(isUnsent(null), false);
  });

  it('groupByPath は中身の変わらない path の配列を使い回す', () => {
    const a1 = c('a', 1);
    const b1 = c('b', 1);
    const g1 = groupByPath([a1, b1]);
    const g2 = groupByPath([a1, { ...b1, text: 'x' }], g1);
    assert.equal(g2.a, g1.a);
    assert.notEqual(g2.b, g1.b);
    assert.equal(groupByPath([a1], { a: [a1, b1] }).a.length, 1);
  });

  it('upsert / update / remove と購読', () => {
    const store = createDiffCommentStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const empty = store.snapshot('s');
    assert.equal(store.snapshot('s'), empty);
    assert.deepEqual(empty.list, []);

    store.upsert('s', c('a', 1));
    store.upsert('s', c('a', 2));
    store.upsert('s', c('a', 1, 'x'));
    assert.deepEqual(
      store.snapshot('s').list.map((x) => [x.start, x.text]),
      [
        [1, 'x'],
        [2, ''],
      ],
    );
    const snap = store.snapshot('s');
    assert.equal(store.snapshot('s'), snap);

    store.update('s', c('a', 2).key, { text: 'y' });
    assert.equal(store.snapshot('s').list[1].text, 'y');
    store.update('s', 'nope', { text: 'z' });
    store.remove('s', 'nope');
    const before = calls;
    store.remove('s', c('a', 1).key);
    assert.equal(calls, before + 1);
    store.remove('s', c('a', 2).key);
    assert.equal(store.snapshot('s'), empty);
    assert.equal(store.snapshot('other').list.length, 0);
    off();
    store.upsert('s', c('a', 3));
    assert.equal(calls, before + 2);
  });

  it('replace は位置を保って差し替え、重なるキーは捨てる', () => {
    const store = createDiffCommentStore();
    store.upsert('s', c('a', 1, 'one'));
    store.upsert('s', c('a', 5, 'five'));
    store.upsert('s', c('a', 9, 'nine'));
    store.replace('s', c('a', 1).key, c('a', 5, 'one'));
    assert.deepEqual(
      store.snapshot('s').list.map((x) => [x.start, x.text]),
      [
        [5, 'one'],
        [9, 'nine'],
      ],
    );
    store.replace('s', 'missing', c('a', 7, 'new'));
    assert.equal(store.snapshot('s').list.at(-1).start, 7);
  });

  it('送信中にして、成功なら消し、失敗なら残す', () => {
    const store = createDiffCommentStore();
    store.upsert('s', c('a', 1, 'x'));
    store.upsert('s', c('a', 2, 'y'));
    store.markSending('s', [c('a', 1).key], 'r1');
    assert.equal(store.snapshot('s').list[0].sendingId, 'r1');
    assert.equal(store.resolveSending('nope', true), false);

    assert.equal(store.resolveSending('r1', false), true);
    assert.equal(store.snapshot('s').list[0].sendingId, null);
    assert.deepEqual(store.snapshot('s').status, { ok: false, count: 1 });

    store.markSending('s', [c('a', 1).key, c('a', 2).key], 'r2');
    assert.equal(store.snapshot('s').status, null);
    assert.equal(store.resolveSending('r2', true), true);
    assert.deepEqual(store.snapshot('s').list, []);
    assert.deepEqual(store.snapshot('s').status, { ok: true, count: 2 });
    // 結果の表示を消すと空のエントリは消える
    store.clearStatus('s');
    assert.equal(store.snapshot('s').status, null);
    store.clearStatus('s');
  });

  it('送信結果の表示はドロワーが閉じていても時間が来たら消える', () => {
    vi.useFakeTimers();
    try {
      const store = createDiffCommentStore({ statusMs: 100 });
      store.upsert('s', c('a', 1, 'x'));
      store.upsert('s', c('a', 2, 'y'));
      store.markSending('s', [c('a', 1).key], 'r1');
      store.resolveSending('r1', true);
      assert.deepEqual(store.snapshot('s').status, { ok: true, count: 1 });
      vi.advanceTimersByTime(100);
      assert.equal(store.snapshot('s').status, null);
      // 後から別の結果が出ていれば、前の結果のタイマーでは消さない
      store.markSending('s', [c('a', 2).key], 'r2');
      store.resolveSending('r2', false);
      store.markSending('s', [c('a', 2).key], 'r3');
      vi.advanceTimersByTime(50);
      store.resolveSending('r3', false);
      vi.advanceTimersByTime(60);
      assert.deepEqual(store.snapshot('s').status, { ok: false, count: 1 });
      vi.advanceTimersByTime(50);
      assert.equal(store.snapshot('s').status, null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrateSession はブリッジ ID のキーの指摘を claudeSessionId のキーへ移す', () => {
    const store = createDiffCommentStore();
    const at = (sessionKey, start, text) => ({
      ...c('a', start, text),
      key: diffCommentKey({ sessionKey, path: 'a', side: 'new', start, end: start }),
    });
    store.upsert('bridge-1', at('bridge-1', 1, 'one'));
    store.upsert('bridge-1', at('bridge-1', 2, 'dup'));
    store.upsert('claude-1', at('claude-1', 2, 'kept'));
    assert.equal(store.migrateSession('bridge-1', 'claude-1'), true);
    assert.deepEqual(store.snapshot('bridge-1').list, []);
    assert.deepEqual(
      store.snapshot('claude-1').list.map((x) => [x.key, x.text]),
      [
        [at('claude-1', 2).key, 'kept'],
        [at('claude-1', 1).key, 'one'],
      ],
    );
    assert.equal(store.migrateSession('bridge-1', 'claude-1'), false);
    assert.equal(store.migrateSession('x', 'x'), false);
    assert.equal(store.migrateSession(null, 'x'), false);
  });
});

describe('drawers', () => {
  it('前面のドロワーの目印', () => {
    const doc = { querySelector: (sel) => (sel === BLOCKING_DRAWER_SELECTOR ? {} : null) };
    assert.equal(isBlockingDrawerOpen(doc), true);
    assert.equal(isBlockingDrawerOpen({ querySelector: () => null }), false);
    assert.equal(isBlockingDrawerOpen(null), false);
    assert.match(BLOCKING_DRAWER_SELECTOR, /\.diff-drawer-overlay/);
    assert.match(BLOCKING_DRAWER_SELECTOR, /\.drawer-overlay/);
  });
});
