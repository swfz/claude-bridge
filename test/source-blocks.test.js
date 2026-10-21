import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEAF_BLOCKS, ANY_BLOCK, collectSourceBlocks, blockForLine } from '../client/src/utils/sourceBlocks.js';

// DOM の代わりに、collectSourceBlocks / blockForLine が触るプロパティだけを持つ要素
function el(tagName, line) {
  return {
    tagName,
    getAttribute: (name) => (name === 'data-source-line' ? String(line) : null),
  };
}

function rootOf(elements) {
  return {
    querySelectorAll: (selector) => {
      assert.equal(selector, '[data-source-line]');
      return elements;
    },
  };
}

describe('LEAF_BLOCKS / ANY_BLOCK', () => {
  it('ANY_BLOCK は LEAF_BLOCKS にコンテナ要素を足したもの', () => {
    for (const tag of LEAF_BLOCKS) assert.ok(ANY_BLOCK.has(tag), tag);
    for (const tag of ['TABLE', 'UL', 'OL', 'DL', 'DIV']) {
      assert.ok(ANY_BLOCK.has(tag), tag);
      assert.ok(!LEAF_BLOCKS.has(tag), tag);
    }
  });
});

describe('collectSourceBlocks', () => {
  it('data-source-line を持つ要素を行番号の昇順に集める', () => {
    const p3 = el('P', 3);
    const h1 = el('H1', 1);
    const ul = el('UL', 5);
    const blocks = collectSourceBlocks(rootOf([p3, h1, ul]));
    assert.deepEqual(
      blocks.map((b) => [b.el, b.line]),
      [
        [h1, 1],
        [p3, 3],
        [ul, 5],
      ],
    );
  });

  it('タグで絞り込まない(コンテナも拾い、選び分けは blockForLine で行う)', () => {
    const blocks = collectSourceBlocks(rootOf([el('DIV', 1), el('SPAN', 2)]));
    assert.deepEqual(
      blocks.map((b) => b.el.tagName),
      ['DIV', 'SPAN'],
    );
  });

  it('同じ行の要素は DOM 順のまま(安定ソート)', () => {
    const ul = el('UL', 2);
    const li = el('LI', 2);
    const blocks = collectSourceBlocks(rootOf([ul, li]));
    assert.deepEqual(
      blocks.map((b) => b.el),
      [ul, li],
    );
  });

  it('行番号が 0 以下・数値でない要素は除く', () => {
    const blocks = collectSourceBlocks(rootOf([el('P', 0), el('P', -1), el('P', 'abc'), el('P', 4)]));
    assert.deepEqual(
      blocks.map((b) => b.line),
      [4],
    );
  });

  it('対象が無ければ空配列', () => {
    assert.deepEqual(collectSourceBlocks(rootOf([])), []);
  });
});

describe('blockForLine', () => {
  // 1: 見出し / 3-4: リスト(ul と 2 つの li) / 6: 表(table と tr)
  const h1 = el('H1', 1);
  const ul = el('UL', 3);
  const li3 = el('LI', 3);
  const li4 = el('LI', 4);
  const table = el('TABLE', 6);
  const tr = el('TR', 6);
  const blocks = collectSourceBlocks(rootOf([h1, ul, li3, li4, table, tr]));

  it('先頭行はその行のブロック', () => {
    assert.equal(blockForLine(blocks, 1), h1);
  });

  it('同じ行に複数あれば末端ブロックを選ぶ', () => {
    assert.equal(blockForLine(blocks, 3), li3);
    assert.equal(blockForLine(blocks, 6), tr);
  });

  it('同じ行に末端ブロックが複数あれば DOM 順で最後(最も深い)のもの', () => {
    const outer = el('LI', 2);
    const inner = el('P', 2);
    assert.equal(blockForLine(collectSourceBlocks(rootOf([outer, inner])), 2), inner);
  });

  it('末端ブロックが無ければコンテナ、それも無ければ最初の要素', () => {
    const div = el('DIV', 2);
    const span = el('SPAN', 2);
    assert.equal(blockForLine(collectSourceBlocks(rootOf([span, div])), 2), div);
    assert.equal(blockForLine(collectSourceBlocks(rootOf([span, el('EM', 2)])), 2), span);
  });

  it('ブロック間の空行は直前のブロック', () => {
    assert.equal(blockForLine(blocks, 2), h1);
    assert.equal(blockForLine(blocks, 5), li4);
  });

  it('最後のブロックより後ろの行は最後のブロック', () => {
    assert.equal(blockForLine(blocks, 100), tr);
  });

  it('最初のブロックより前の行は null', () => {
    assert.equal(blockForLine(blocks, 0), null);
  });

  it('exactOnly では完全一致が無ければ null', () => {
    assert.equal(blockForLine(blocks, 2, { exactOnly: true }), null);
    assert.equal(blockForLine(blocks, 4, { exactOnly: true }), li4);
  });

  it('ブロックが無ければ null', () => {
    assert.equal(blockForLine([], 1), null);
  });
});
