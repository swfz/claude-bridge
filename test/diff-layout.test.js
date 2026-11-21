import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseDiffRows } from '../client/src/utils/diffView.js';
import {
  DIFF_VIEW_MODES,
  DIFF_VIEW_STORAGE_KEY,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_ROWS,
  SPLIT_MIN_WIDTH,
  effectiveViewMode,
  extOf,
  highlightDiffRows,
  normalizeViewMode,
  pairSplitRows,
  splitLineIndex,
} from '../client/src/utils/diffLayout.js';
import {
  buildNavList,
  extendNav,
  findNavIndex,
  jumpNav,
  navCursor,
  navRange,
  stepNav,
} from '../client/src/utils/diffNav.js';
import {
  REVIEWED_MAX,
  REVIEWED_STORAGE_KEY,
  canMarkReviewed,
  hashText,
  loadReviewed,
  migrateReviewed,
  parseReviewed,
  reviewedKey,
  saveReviewed,
  subscribeReviewed,
  toggleReviewed,
} from '../client/src/utils/diffReviewed.js';

const rowsOf = (body) => parseDiffRows(body);

describe('表示モード', () => {
  it('normalizeViewMode / effectiveViewMode', () => {
    assert.equal(DIFF_VIEW_STORAGE_KEY, 'diffDrawerView');
    assert.deepEqual(
      DIFF_VIEW_MODES.map((m) => m.value),
      ['unified', 'split'],
    );
    assert.equal(normalizeViewMode('split'), 'split');
    assert.equal(normalizeViewMode('x'), 'unified');
    assert.equal(effectiveViewMode('split', SPLIT_MIN_WIDTH), 'split');
    assert.equal(effectiveViewMode('split', SPLIT_MIN_WIDTH - 1), 'unified');
    assert.equal(effectiveViewMode('unified', 5000), 'unified');
  });

  it('extOf', () => {
    assert.equal(extOf('src/App.JSX'), 'jsx');
    assert.equal(extOf('Makefile'), '');
    assert.equal(extOf('.gitignore'), '');
    assert.equal(extOf(null), '');
  });
});

describe('pairSplitRows', () => {
  const pairs = (lines) => lines.map((l) => (l.type === 'hunk' ? ['hunk', l.idx] : [l.left, l.right]));

  it('削除と追加を上から横に並べ、余った方は反対を空ける', () => {
    const rows = rowsOf('@@ -1,4 +1,3 @@\n ctx\n-a\n-b\n-c\n+A\n+B\n ctx2\n+only\n');
    assert.deepEqual(pairs(pairSplitRows(rows)), [
      ['hunk', 0],
      [1, 1],
      [2, 5],
      [3, 6],
      [4, null],
      [7, 7],
      [null, 8],
    ]);
  });

  it('追加の後の削除は別の塊にする', () => {
    const rows = rowsOf('@@ -1,2 +1,2 @@\n-a\n+A\n-b\n+B\n');
    assert.deepEqual(pairs(pairSplitRows(rows)), [
      ['hunk', 0],
      [1, 2],
      [3, 4],
    ]);
  });

  it('No newline（meta）は直前の行の側に付き、削除と追加の間でも区切らない', () => {
    const rows = rowsOf('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
    assert.deepEqual(pairs(pairSplitRows(rows)), [
      ['hunk', 0],
      [1, 3],
      [2, 4],
    ]);
    // 文脈行の後ろの meta は左右をまたぐ 1 行
    const ctx = rowsOf('@@ -1 +1 @@\n x\n\\ No newline at end of file\n');
    assert.deepEqual(pairs(pairSplitRows(ctx)), [
      ['hunk', 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('splitLineIndex は行の添字から表示行を引く', () => {
    const lines = pairSplitRows(rowsOf('@@ -1 +1 @@\n x\n-a\n+b\n'));
    const map = splitLineIndex(lines);
    assert.deepEqual(
      [...map.entries()],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 2],
      ],
    );
    assert.deepEqual(pairSplitRows(null), []);
  });
});

describe('highlightDiffRows', () => {
  // 1 行目と最終行に印を付けるだけのダミー。複数行の連結を確かめるため、/* … */ を 1 つの span で包む
  const fake = (text) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="c">${m}</span>`);

  it('新側・旧側をそれぞれ連結して色付けし、行に戻す（複数行のコメントも崩れない）', () => {
    const rows = rowsOf('@@ -1,3 +1,3 @@\n /* a\n-b */\n+c\n+d */\n x<y\n');
    const out = highlightDiffRows(rows, fake);
    assert.equal(out[0], null); // hunk
    assert.equal(out[1], '<span class="c">/* a</span>'); // 文脈は新側（/* a ⏎ c ⏎ d */）
    assert.equal(out[2], '<span class="c">b */</span>'); // 削除は旧側（/* a ⏎ b */）
    assert.equal(out[3], '<span class="c">c</span>');
    assert.equal(out[4], '<span class="c">d */</span>');
    assert.equal(out[5], 'x&lt;y');
  });

  it('色付けできない・行数が合わない・例外は null（素のテキストに戻す）', () => {
    const rows = rowsOf('@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(highlightDiffRows(rows, null), null);
    assert.equal(
      highlightDiffRows([], (t) => t),
      null,
    );
    assert.deepEqual(
      highlightDiffRows(rows, () => null),
      [null, null, null],
    );
    assert.deepEqual(
      highlightDiffRows(rows, () => 'x\ny'),
      [null, null, null],
    );
    assert.deepEqual(
      highlightDiffRows(rows, () => {
        throw new Error('x');
      }),
      [null, null, null],
    );
    // 片側だけの差分
    assert.deepEqual(
      highlightDiffRows(rowsOf('@@ -0,0 +1 @@\n+a\n'), (t) => t),
      [null, 'a'],
    );
  });

  it('大きいものは色付けしない', () => {
    const many = rowsOf(`@@ -0,0 +1,${HIGHLIGHT_MAX_ROWS} @@\n${'+a\n'.repeat(HIGHLIGHT_MAX_ROWS)}`);
    assert.equal(
      highlightDiffRows(many, (t) => t),
      null,
    );
    const long = rowsOf(`@@ -0,0 +1 @@\n+${'x'.repeat(HIGHLIGHT_MAX_LINE + 1)}\n`);
    assert.equal(
      highlightDiffRows(long, (t) => t),
      null,
    );
    const wide = rowsOf(`@@ -0,0 +1,200 @@\n${`+${'y'.repeat(HIGHLIGHT_MAX_CHARS / 199)}\n`.repeat(200)}`);
    assert.equal(
      highlightDiffRows(wide, (t) => t),
      null,
    );
  });
});

describe('diffNav', () => {
  const a = rowsOf('@@ -1,3 +1,3 @@\n x\n-a\n+A\n@@ -10 +10 @@\n-b\n+B\n');
  const b = rowsOf('@@ -0,0 +1,2 @@\n+n1\n+n2\n');
  const nav = buildNavList([
    { path: 'a', rows: a },
    { path: 'b', rows: b },
  ]);

  it('buildNavList は指摘を付けられる行を並べ、hunk とファイルの先頭に印を付ける', () => {
    assert.deepEqual(
      nav.map((n) => [n.path, n.idx, n.side, n.line, n.hunkStart, n.fileStart]),
      [
        ['a', 1, 'new', 1, true, true],
        ['a', 2, 'old', 2, false, false],
        ['a', 3, 'new', 2, false, false],
        ['a', 5, 'old', 10, true, false],
        ['a', 6, 'new', 10, false, false],
        ['b', 1, 'new', 1, true, true],
        ['b', 2, 'new', 2, false, false],
      ],
    );
    assert.deepEqual(buildNavList(null), []);
    assert.deepEqual(buildNavList([{ path: 'x' }]), []);
  });

  it('findNavIndex / navCursor', () => {
    assert.equal(findNavIndex(nav, { path: 'a', side: 'old', line: 10 }), 3);
    assert.equal(findNavIndex(nav, { path: 'a', side: 'new', line: 10 }), 4);
    assert.equal(findNavIndex(nav, { path: 'z', side: 'new', line: 1 }), -1);
    assert.equal(findNavIndex(nav, null), -1);
    assert.deepEqual(navCursor(nav[3]), { path: 'a', side: 'old', line: 10 });
    assert.equal(navCursor(undefined), null);
  });

  it('stepNav は端で止まり、カーソルが無ければ先頭', () => {
    assert.equal(stepNav(nav, -1, -1), 0);
    assert.equal(stepNav(nav, -1, 1), 0);
    assert.equal(stepNav(nav, 0, -1), 0);
    assert.equal(stepNav(nav, 2, 1), 3);
    assert.equal(stepNav(nav, 6, 1), 6);
    assert.equal(stepNav([], 0, 1), -1);
  });

  it('jumpNav は hunk・ファイルの先頭へ', () => {
    assert.equal(jumpNav(nav, -1, 1), 0);
    assert.equal(jumpNav(nav, 0, 1), 3);
    assert.equal(jumpNav(nav, 3, 1), 5);
    assert.equal(jumpNav(nav, 6, 1), 6);
    assert.equal(jumpNav(nav, 4, -1), 3);
    assert.equal(jumpNav(nav, 3, -1), 0);
    assert.equal(jumpNav(nav, 0, -1), 0);
    assert.equal(jumpNav(nav, -1, -1), 5);
    assert.equal(jumpNav(nav, 1, 1, 'fileStart'), 5);
    assert.equal(jumpNav(nav, 6, -1, 'fileStart'), 5);
    assert.equal(jumpNav(nav, 5, -1, 'fileStart'), 0);
    assert.equal(jumpNav([], 0, 1), -1);
    assert.equal(jumpNav(nav.slice(1, 3), -1, -1), 0);
  });

  it('extendNav は同じファイル・同じ側で途切れないときだけ広げる', () => {
    const rowsByPath = new Map([
      ['a', a],
      ['b', b],
    ]);
    assert.equal(extendNav(nav, rowsByPath, 5, 6), 6);
    assert.equal(extendNav(nav, rowsByPath, 2, 3), null); // 側が違う
    assert.equal(extendNav(nav, rowsByPath, 0, 2), null); // 間に削除行
    assert.equal(extendNav(nav, rowsByPath, 4, 5), null); // ファイルが違う
    assert.equal(extendNav(nav, rowsByPath, 9, 5), null);
    assert.equal(extendNav(nav, new Map(), 5, 6), null);
  });

  it('navRange', () => {
    assert.deepEqual(navRange(nav, 6, 5), { side: 'new', start: 1, end: 2 });
    assert.deepEqual(navRange(nav, null, 3), { side: 'old', start: 10, end: 10 });
    assert.deepEqual(navRange(nav, 2, 3), { side: 'old', start: 10, end: 10 });
    assert.equal(navRange(nav, 0, 99), null);
  });
});

describe('diffReviewed', () => {
  const file = { path: 'src/a|b.js', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n' };

  it('hashText は中身で変わる', () => {
    assert.equal(hashText('abc'), hashText('abc'));
    assert.notEqual(hashText('abc'), hashText('abd'));
    assert.equal(hashText(null).length, 8);
  });

  it('reviewedKey は sessionKey・中身・パスで決まる', () => {
    const k = reviewedKey('s', file);
    assert.ok(k.startsWith('s|') && k.endsWith('|src/a|b.js'));
    assert.notEqual(k, reviewedKey('s', { ...file, patch: `${file.patch} ` }));
    assert.notEqual(k, reviewedKey('t', file));
    assert.notEqual(k, reviewedKey('s', { ...file, oldPath: 'x' }));
    assert.notEqual(reviewedKey('s', { path: 'p' }), '');
  });

  it('canMarkReviewed は hunk のある patch だけ', () => {
    assert.equal(canMarkReviewed(file), true);
    assert.equal(canMarkReviewed({ patch: '' }), false);
    assert.equal(canMarkReviewed({ patch: 'Binary files differ' }), false);
    assert.equal(canMarkReviewed(null), false);
  });

  it('toggleReviewed は上限を超えたら古いものから捨てる', () => {
    assert.deepEqual(toggleReviewed(['a', 'b'], 'a', true), ['b', 'a']);
    assert.deepEqual(toggleReviewed(['a', 'b'], 'a', false), ['b']);
    const full = Array.from({ length: REVIEWED_MAX }, (_, i) => `k${i}`);
    const next = toggleReviewed(full, 'new', true);
    assert.equal(next.length, REVIEWED_MAX);
    assert.equal(next[0], 'k1');
    assert.equal(next.at(-1), 'new');
  });

  it('parseReviewed / load / save', () => {
    assert.deepEqual(parseReviewed('["a",1,"b"]'), ['a', 'b']);
    assert.deepEqual(parseReviewed('{"a":1}'), []);
    assert.deepEqual(parseReviewed('not json'), []);
    assert.deepEqual(parseReviewed(null), []);
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    saveReviewed(['x'], storage);
    assert.equal(store.get(REVIEWED_STORAGE_KEY), '["x"]');
    assert.deepEqual(loadReviewed(storage), ['x']);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    assert.deepEqual(loadReviewed(broken), []);
    saveReviewed(['x'], broken);
    assert.deepEqual(loadReviewed(undefined), []);
  });

  it('subscribeReviewed は保存（失敗しても）のたびに書いた一覧を知らせ、解除後は知らせない', () => {
    const got = [];
    const off = subscribeReviewed((list) => got.push(list));
    const storage = { getItem: () => null, setItem: () => {} };
    saveReviewed(['a'], storage);
    saveReviewed(['b'], {
      setItem: () => {
        throw new Error('denied');
      },
    });
    off();
    saveReviewed(['c'], storage);
    assert.deepEqual(got, [['a'], ['b']]);
  });

  it('migrateReviewed はブリッジ ID の確認済みを claudeSessionId に付け替える', () => {
    const list = ['b1|h|p', 'c1|h|p', 'other|h|q'];
    assert.deepEqual(migrateReviewed(list, 'b1', 'c1'), ['c1|h|p', 'other|h|q']);
    assert.equal(migrateReviewed(list, 'zz', 'c1'), list);
    assert.equal(migrateReviewed(list, 'b1', 'b1'), list);
    assert.equal(migrateReviewed(list, null, 'c1'), list);
  });
});
