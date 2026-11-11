import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTabOrder, moveTab, tabKeyOf } from '../client/src/utils/tabOrder.js';

const s = (id, claudeSessionId) => ({ id, claudeSessionId });

describe('tabKeyOf', () => {
  it('prefers claudeSessionId', () => {
    assert.equal(tabKeyOf(s('a', 'c1')), 'c1');
    assert.equal(tabKeyOf(s('a')), 'a');
    assert.equal(tabKeyOf(null), null);
  });
});

describe('applyTabOrder', () => {
  it('returns as-is without order', () => {
    const list = [s('a'), s('b')];
    assert.equal(applyTabOrder(list, []), list);
  });

  it('sorts known tabs and appends unknown ones in server order', () => {
    const list = [s('a'), s('b', 'cb'), s('c'), s('d')];
    const ids = applyTabOrder(list, ['c', 'cb']).map((x) => x.id);
    assert.deepEqual(ids, ['c', 'b', 'a', 'd']);
  });

  it('matches by bridge id even after claudeSessionId is resolved', () => {
    const list = [s('a'), s('b', 'cb')];
    assert.deepEqual(
      applyTabOrder(list, ['b', 'a']).map((x) => x.id),
      ['b', 'a'],
    );
  });
});

describe('moveTab', () => {
  const list = [s('a'), s('b', 'cb'), s('c')];

  it('moves before target', () => {
    assert.deepEqual(moveTab(list, 'c', 'a'), ['c', 'a', 'cb']);
  });

  it('moves after target', () => {
    assert.deepEqual(moveTab(list, 'a', 'c', true), ['cb', 'c', 'a']);
    assert.deepEqual(moveTab(list, 'a', 'b', true), ['cb', 'a', 'c']);
  });

  it('keeps order when dropping on itself or unknown ids', () => {
    assert.deepEqual(moveTab(list, 'a', 'a'), ['a', 'cb', 'c']);
    assert.deepEqual(moveTab(list, 'x', 'a'), ['a', 'cb', 'c']);
    assert.deepEqual(moveTab(list, 'a', 'x'), ['a', 'cb', 'c']);
  });
});
