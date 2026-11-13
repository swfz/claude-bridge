import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampToViewport, dragTo } from '../client/src/utils/dragPosition.js';

const VIEWPORT = { width: 1000, height: 800 };

describe('clampToViewport', () => {
  it('画面内ならそのまま', () => {
    assert.deepEqual(clampToViewport({ x: 100, y: 200, width: 320, height: 160 }, VIEWPORT), { x: 100, y: 200 });
  });

  it('左上にはみ出したら余白の位置に寄せる', () => {
    assert.deepEqual(clampToViewport({ x: -50, y: -10, width: 320, height: 160 }, VIEWPORT), { x: 4, y: 4 });
  });

  it('右下にはみ出したら箱が収まる位置に寄せる', () => {
    assert.deepEqual(clampToViewport({ x: 900, y: 790, width: 320, height: 160 }, VIEWPORT), { x: 676, y: 636 });
  });

  it('箱が画面より大きければ左上を余白に寄せる', () => {
    assert.deepEqual(clampToViewport({ x: 300, y: 300, width: 2000, height: 2000 }, VIEWPORT), { x: 4, y: 4 });
  });
});

describe('dragTo', () => {
  it('開始時の矩形にポインタの移動量を足す', () => {
    const start = { left: 100, top: 100, width: 320, height: 160 };
    assert.deepEqual(dragTo(start, 30, -20, VIEWPORT), { x: 130, y: 80 });
  });

  it('移動先も画面内に収める', () => {
    const start = { left: 100, top: 100, width: 320, height: 160 };
    assert.deepEqual(dragTo(start, -500, 5000, VIEWPORT), { x: 4, y: 636 });
  });
});
