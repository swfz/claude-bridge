import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { peekPosition } from '../client/src/utils/recentPeek.js';

const viewport = { width: 1200, height: 800 };
const rect = (left, top, size = 20) => ({ left, top, right: left + size, bottom: top + size });

describe('peekPosition', () => {
  it('入るならアイコンの左下に出す', () => {
    assert.deepEqual(peekPosition(rect(100, 100), { width: 520, height: 300 }, viewport), {
      left: 100,
      top: 126,
      placement: 'below',
    });
  });

  it('下に入らなければ上に出す', () => {
    const pos = peekPosition(rect(100, 700), { width: 520, height: 300 }, viewport);
    assert.equal(pos.placement, 'above');
    assert.equal(pos.top, 700 - 6 - 300);
  });

  it('右にはみ出すなら左へずらす', () => {
    const pos = peekPosition(rect(1000, 100), { width: 520, height: 300 }, viewport);
    assert.equal(pos.left, 1200 - 8 - 520);
  });

  it('画面より広ければ左端の余白に寄せる', () => {
    const pos = peekPosition(rect(50, 100), { width: 600, height: 300 }, { width: 400, height: 800 });
    assert.equal(pos.left, 8);
  });

  it('上下どちらにも入らなければ広い側に置き、画面内に収める', () => {
    const pos = peekPosition(rect(100, 300), { width: 520, height: 500 }, { width: 1200, height: 700 });
    assert.equal(pos.placement, 'below');
    assert.equal(pos.top, 700 - 8 - 500);
    const up = peekPosition(rect(100, 500), { width: 520, height: 500 }, { width: 1200, height: 700 });
    assert.equal(up.placement, 'above');
    assert.equal(up.top, 8);
  });
});
