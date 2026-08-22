import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isScrolledToBottom, BOTTOM_THRESHOLD_PX } from '../client/src/utils/scroll.js';

describe('isScrolledToBottom', () => {
  it('最下部ぴったりなら true', () => {
    assert.strictEqual(isScrolledToBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }), true);
  });

  it('閾値内の余りなら true（少し上で止めていても追従する）', () => {
    assert.strictEqual(isScrolledToBottom({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 }), true);
  });

  it('閾値を超えて上にいれば false', () => {
    assert.strictEqual(isScrolledToBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }), false);
  });

  it('スクロールできない高さなら true', () => {
    assert.strictEqual(isScrolledToBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 200 }), true);
  });

  it('閾値は引数で変えられる', () => {
    const el = { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 };
    assert.strictEqual(isScrolledToBottom(el, 50), false);
    assert.strictEqual(isScrolledToBottom(el, 150), true);
  });

  it('el が無ければ false（追従しない側に倒す）', () => {
    assert.strictEqual(isScrolledToBottom(null), false);
  });

  it('既定の閾値が定数として公開されている', () => {
    assert.strictEqual(typeof BOTTOM_THRESHOLD_PX, 'number');
  });
});
