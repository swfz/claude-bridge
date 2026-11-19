import { describe, it } from 'vitest';
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

describe('peekPosition（境界）', () => {
  const pop = { width: 520, height: 300 };

  it('下にも上にも入るなら下を選ぶ', () => {
    assert.deepEqual(peekPosition(rect(100, 400), pop, viewport), { left: 100, top: 426, placement: 'below' });
  });

  it('下端の余白ちょうどまでなら下に出し、1px でもはみ出すなら上に出す', () => {
    // bottom 486 + gap 6 + 300 = 792 = 800 - 8
    assert.deepEqual(peekPosition(rect(100, 466), pop, viewport), { left: 100, top: 492, placement: 'below' });
    assert.deepEqual(peekPosition(rect(100, 476), pop, viewport), { left: 100, top: 170, placement: 'above' });
  });

  it('アイコンが下端にかかっていても上に入るなら、上の位置を下端の余白で削らない', () => {
    // above = 799 - 6 - 300 = 493 >= 8。広い側を選ぶ分岐に入ると 800 - 8 - 300 = 492 に頭打ちされる
    assert.deepEqual(peekPosition(rect(100, 799), pop, viewport), { left: 100, top: 493, placement: 'above' });
  });

  it('右端の余白に食い込むだけでも左へずらす', () => {
    // 680 + 520 = 1200 > 1200 - 8
    assert.equal(peekPosition(rect(680, 100), pop, viewport).left, 672);
  });

  it('アイコンが左端の余白より左にあれば余白に寄せる', () => {
    assert.equal(peekPosition(rect(3, 100), pop, viewport).left, 8);
  });

  it('画面より高いポップオーバーは画面の高さに縮めて下に収める', () => {
    // アイコンが画面上端の外まで流れていても、下に入る分だけ表示する
    const anchor = { left: 100, top: -20, right: 120, bottom: 0 };
    assert.deepEqual(peekPosition(anchor, { width: 520, height: 790 }, viewport), {
      left: 100,
      top: 6,
      placement: 'below',
    });
  });

  it('上下どちらにも入らず空きが同じなら下に置く', () => {
    // 上の空き 340 = 下の空き 700 - 360
    const pos = peekPosition(rect(100, 340), { width: 520, height: 500 }, { width: 1200, height: 700 });
    assert.deepEqual(pos, { left: 100, top: 192, placement: 'below' });
  });
});
