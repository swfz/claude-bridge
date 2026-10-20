import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PTY_KEY_SEQUENCES,
  isValidChoiceKey,
  assertValidChoiceKeys,
  toPtySequence,
  sanitizeChoiceText,
} from '../server/choice-keys.js';

const NAMED_KEYS = ['Enter', 'Escape', 'Tab', 'BTab', 'Space', 'Up', 'Down', 'Left', 'Right'];

describe('isValidChoiceKey', () => {
  it('数字 1 桁は有効', () => {
    for (let i = 0; i <= 9; i++) {
      assert.equal(isValidChoiceKey(String(i)), true, `"${i}"`);
    }
  });

  it('名前付きキーは有効', () => {
    for (const key of NAMED_KEYS) {
      assert.equal(isValidChoiceKey(key), true, key);
    }
  });

  it('ホワイトリスト外は無効', () => {
    for (const key of [
      '10',
      '',
      'Ctrl-C',
      'C-c',
      'enter',
      ' Enter',
      '1\n',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      assert.equal(isValidChoiceKey(key), false, JSON.stringify(key));
    }
  });

  it('文字列以外は無効', () => {
    for (const key of [1, 0, null, undefined, {}, ['1'], true]) {
      assert.equal(isValidChoiceKey(key), false, String(key));
    }
  });
});

describe('assertValidChoiceKeys', () => {
  it('配列はそのまま返す', () => {
    const keys = ['Down', 'Down', 'Enter'];
    assert.deepEqual(assertValidChoiceKeys(keys), ['Down', 'Down', 'Enter']);
  });

  it('単体は配列に包んで返す', () => {
    assert.deepEqual(assertValidChoiceKeys('1'), ['1']);
  });

  it('空配列は空配列を返す', () => {
    assert.deepEqual(assertValidChoiceKeys([]), []);
  });

  it('不正なキーを含む配列は throw する', () => {
    assert.throws(() => assertValidChoiceKeys(['1', 'Ctrl-C']), {
      message: 'Invalid choice key: Ctrl-C',
    });
  });

  it('不正な単体キーは throw する', () => {
    assert.throws(() => assertValidChoiceKeys('__proto__'), {
      message: 'Invalid choice key: __proto__',
    });
  });
});

describe('toPtySequence', () => {
  it('数字はそのまま', () => {
    assert.equal(toPtySequence('3'), '3');
  });

  it('名前付きキーはエスケープシーケンスに変換する', () => {
    assert.equal(toPtySequence('Enter'), '\r');
    assert.equal(toPtySequence('Escape'), '\x1b');
    assert.equal(toPtySequence('Tab'), '\t');
    assert.equal(toPtySequence('BTab'), '\x1b[Z');
    assert.equal(toPtySequence('Space'), ' ');
    assert.equal(toPtySequence('Up'), '\x1b[A');
    assert.equal(toPtySequence('Down'), '\x1b[B');
    assert.equal(toPtySequence('Right'), '\x1b[C');
    assert.equal(toPtySequence('Left'), '\x1b[D');
  });

  it('名前付きキーは全て PTY_KEY_SEQUENCES に定義がある', () => {
    assert.deepEqual(Object.keys(PTY_KEY_SEQUENCES).sort(), [...NAMED_KEYS].sort());
  });
});

describe('sanitizeChoiceText', () => {
  it('通常の文字列はそのまま', () => {
    assert.equal(sanitizeChoiceText('hello world'), 'hello world');
  });

  it('改行は空白 1 つに潰す', () => {
    assert.equal(sanitizeChoiceText('a\nb'), 'a b');
    assert.equal(sanitizeChoiceText('a\r\nb'), 'a b');
    assert.equal(sanitizeChoiceText('a\n\n\rb'), 'a b');
  });

  it('2000 文字で切る', () => {
    assert.equal(sanitizeChoiceText('x'.repeat(2001)), 'x'.repeat(2000));
    assert.equal(sanitizeChoiceText('x'.repeat(2000)), 'x'.repeat(2000));
  });

  it('文字列以外は空文字', () => {
    for (const v of [undefined, null, 1, {}, ['a']]) {
      assert.equal(sanitizeChoiceText(v), '', String(v));
    }
  });
});
