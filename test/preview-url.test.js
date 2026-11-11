import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { previewUrl } from '../client/src/utils/previewUrl.js';

describe('previewUrl', () => {
  it('既定は相対 URL でパスをエンコードする', () => {
    assert.equal(previewUrl('/home/a b/c.md'), '/preview?path=%2Fhome%2Fa%20b%2Fc.md');
  });

  it('origin を渡すと絶対 URL にする（PiP 窓の document 用）', () => {
    assert.equal(
      previewUrl('/tmp/x.png', 'http://localhost:3000'),
      'http://localhost:3000/preview?path=%2Ftmp%2Fx.png',
    );
  });
});
