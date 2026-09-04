import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { halfScreenJump } from '../client/src/utils/pickJump.js';

// 画面上に 100px 間隔で並ぶ 6 件（チャットと同じく、上ほど番号が大きい）
const items = [6, 5, 4, 3, 2, 1].map((n, i) => ({ n, top: i * 100 }));

describe('pickJump: halfScreenJump', () => {
  it('下方向に半画面（250px）以上離れた最初の要素へ飛ぶ', () => {
    assert.equal(halfScreenJump({ items, current: 6, half: 250, direction: 'down' }), 3);
  });
  it('上方向も同じ', () => {
    assert.equal(halfScreenJump({ items, current: 1, half: 250, direction: 'up' }), 4);
  });
  it('半画面ぶん進めないときは端で止まる', () => {
    assert.equal(halfScreenJump({ items, current: 2, half: 250, direction: 'down' }), 1);
    assert.equal(halfScreenJump({ items, current: 1, half: 250, direction: 'down' }), 1);
  });
  it('未選択なら進む方向の手前の端から', () => {
    assert.equal(halfScreenJump({ items, current: null, half: 250, direction: 'down' }), 6);
    assert.equal(halfScreenJump({ items, current: null, half: 250, direction: 'up' }), 1);
  });
  it('要素が無ければ current のまま', () => {
    assert.equal(halfScreenJump({ items: [], current: 3, half: 250, direction: 'down' }), 3);
  });
});
