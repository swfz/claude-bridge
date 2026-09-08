import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksBinary } from '../client/src/utils/binaryText.js';

describe('binaryText: looksBinary', () => {
  it('普通のテキストはバイナリと見なさない', () => {
    assert.equal(looksBinary('hello\nworld\n'), false);
    assert.equal(looksBinary('日本語の本文も問題ない'), false);
  });

  it('空・未指定は false（読めるものが無いだけで、バイナリではない）', () => {
    assert.equal(looksBinary(''), false);
    assert.equal(looksBinary(null), false);
    assert.equal(looksBinary(undefined), false);
  });

  it('NUL が混ざっていればバイナリ', () => {
    assert.equal(looksBinary('ELF\u0000\u0000text'), true);
  });

  it('先頭 8KB より後ろの NUL は見ない', () => {
    assert.equal(looksBinary('a'.repeat(8192) + '\u0000'), false);
  });

  it('置換文字が 5% を超えればバイナリ', () => {
    // 100 文字中 6 文字が U+FFFD
    assert.equal(looksBinary('�'.repeat(6) + 'a'.repeat(94)), true);
  });

  it('置換文字が 5% 以下ならテキストとして扱う', () => {
    assert.equal(looksBinary('�'.repeat(5) + 'a'.repeat(95)), false);
  });
});
