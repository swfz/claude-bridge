import { describe, it } from 'vitest';
import assert from 'node:assert';
import {
  KEY_STEP,
  KEY_STEP_LARGE,
  clampWidth,
  maxWidthFor,
  parseStoredWidth,
  widthFromDrag,
  widthFromKey,
} from '../client/src/utils/resizableWidth.js';

describe('maxWidthFor', () => {
  it('画面幅に対する割合で切り捨てる', () => {
    assert.strictEqual(maxWidthFor(1280, { maxRatio: 0.95 }), 1216);
  });
  it('端から残す余白があれば小さい方', () => {
    assert.strictEqual(maxWidthFor(1280, { maxRatio: 1, margin: 100 }), 1180);
    assert.strictEqual(maxWidthFor(1000, { maxRatio: 0.5, margin: 100 }), 500);
  });
  it('既定は 95%・余白なし', () => {
    assert.strictEqual(maxWidthFor(1000), 950);
  });
  it('負・数値でない画面幅は 0', () => {
    assert.strictEqual(maxWidthFor(-10), 0);
    assert.strictEqual(maxWidthFor(undefined), 0);
    assert.strictEqual(maxWidthFor(50, { maxRatio: 1, margin: 100 }), 0);
  });
});

describe('clampWidth', () => {
  const opts = { min: 480, maxRatio: 0.95 };
  it('範囲内はそのまま（整数に丸める）', () => {
    assert.strictEqual(clampWidth(700.4, 1280, opts), 700);
  });
  it('下限・上限で詰める', () => {
    assert.strictEqual(clampWidth(100, 1280, opts), 480);
    assert.strictEqual(clampWidth(5000, 1280, opts), 1216);
  });
  it('上限が下限より小さい狭い画面では上限（画面からはみ出さない方）を優先する', () => {
    assert.strictEqual(clampWidth(100, 400, opts), 380);
    assert.strictEqual(clampWidth(900, 400, opts), 380);
  });
  it('既定の下限は 400', () => {
    assert.strictEqual(clampWidth(10, 2000), 400);
  });
});

describe('widthFromDrag', () => {
  it('左へ動かすと広がり、右へ動かすと狭まる', () => {
    assert.strictEqual(widthFromDrag(800, 500, 450), 850);
    assert.strictEqual(widthFromDrag(800, 500, 600), 700);
  });
});

describe('widthFromKey', () => {
  it('← で広げ、→ で狭める', () => {
    assert.strictEqual(widthFromKey(800, { key: 'ArrowLeft' }), 800 + KEY_STEP);
    assert.strictEqual(widthFromKey(800, { key: 'ArrowRight' }), 800 - KEY_STEP);
  });
  it('Shift で大きく動かす', () => {
    assert.strictEqual(widthFromKey(800, { key: 'ArrowLeft', shiftKey: true }), 800 + KEY_STEP_LARGE);
    assert.strictEqual(widthFromKey(800, { key: 'ArrowRight', shiftKey: true }), 800 - KEY_STEP_LARGE);
  });
  it('それ以外のキーは null', () => {
    assert.strictEqual(widthFromKey(800, { key: 'ArrowUp' }), null);
    assert.strictEqual(widthFromKey(800, { key: 'a' }), null);
  });
});

describe('parseStoredWidth', () => {
  it('正の数値を整数で読む', () => {
    assert.strictEqual(parseStoredWidth('812'), 812);
    assert.strictEqual(parseStoredWidth('812.6'), 813);
  });
  it('無い・読めない・正でないものは null', () => {
    for (const raw of [null, undefined, '', 'abc', '0', '-5', 'Infinity']) {
      assert.strictEqual(parseStoredWidth(raw), null, String(raw));
    }
  });
});
