import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pinExcerpt, pinnedUuidSet, resolvePins, sortPins } from '../client/src/utils/pins.js';

describe('pinExcerpt', () => {
  it('改行・連続空白を潰して trim する', () => {
    assert.equal(pinExcerpt('  a\n\n b\t c  '), 'a b c');
  });

  it('上限を超えたら切って … を付ける', () => {
    assert.equal(pinExcerpt('abcdef', 3), 'abc…');
    assert.equal(pinExcerpt('abc', 3), 'abc');
  });

  it('null / undefined は空文字', () => {
    assert.equal(pinExcerpt(null), '');
    assert.equal(pinExcerpt(undefined), '');
  });
});

describe('pinnedUuidSet', () => {
  it('messageUuid の集合を返す（欠けたものは除く）', () => {
    const set = pinnedUuidSet([{ messageUuid: 'u1' }, { messageUuid: '' }, { messageUuid: 'u2' }]);
    assert.deepEqual([...set], ['u1', 'u2']);
  });

  it('null は空集合', () => {
    assert.equal(pinnedUuidSet(null).size, 0);
  });
});

describe('sortPins', () => {
  it('メッセージの時刻の古い順。無ければ pinnedAt で代用する', () => {
    const pins = [
      { messageUuid: 'b', messageTimestamp: '2026-10-29T10:00:00Z' },
      { messageUuid: 'c', messageTimestamp: null, pinnedAt: '2026-10-29T11:00:00Z' },
      { messageUuid: 'a', messageTimestamp: '2026-10-29T09:00:00Z' },
    ];
    assert.deepEqual(
      sortPins(pins).map((p) => p.messageUuid),
      ['a', 'b', 'c'],
    );
  });

  it('元の配列を変えない', () => {
    const pins = [
      { messageUuid: 'b', pinnedAt: '2' },
      { messageUuid: 'a', pinnedAt: '1' },
    ];
    sortPins(pins);
    assert.equal(pins[0].messageUuid, 'b');
  });
});

describe('resolvePins', () => {
  it('読み込まれているメッセージは loaded にして最新の本文から抜粋を作り直す', () => {
    const pins = [
      { messageUuid: 'u1', excerpt: '古い抜粋', messageTimestamp: '2026-10-29T09:00:00Z' },
      { messageUuid: 'u2', excerpt: '保存した抜粋', messageTimestamp: '2026-10-29T10:00:00Z' },
    ];
    const messages = [{ uuid: 'u1', role: 'assistant', content: '新しい\n本文' }];
    const [a, b] = resolvePins(pins, messages);
    assert.equal(a.loaded, true);
    assert.equal(a.excerpt, '新しい 本文');
    assert.equal(b.loaded, false);
    assert.equal(b.excerpt, '保存した抜粋');
  });

  it('読み込まれていても本文が空なら保存した抜粋を使う', () => {
    const [a] = resolvePins([{ messageUuid: 'u1', excerpt: '保存' }], [{ uuid: 'u1', content: '' }]);
    assert.equal(a.excerpt, '保存');
  });
});
