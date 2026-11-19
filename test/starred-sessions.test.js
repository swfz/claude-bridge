import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isStarred,
  loadStarred,
  saveStarred,
  sortStarredFirst,
  toggleStarred,
} from '../client/src/utils/starredSessions.js';

describe('isStarred', () => {
  it('detects a starred session', () => {
    assert.equal(isStarred(['a', 'b'], 'b'), true);
    assert.equal(isStarred(['a'], 'b'), false);
  });

  it('handles missing input', () => {
    assert.equal(isStarred(null, 'a'), false);
    assert.equal(isStarred(['a'], null), false);
    assert.equal(isStarred(['a'], ''), false);
  });

  it('Star の一覧が無ければどの ID も Star 付きではない', () => {
    assert.equal(isStarred(undefined, 'Stryker was here!'), false);
  });
});

describe('toggleStarred', () => {
  it('adds a new star at the front', () => {
    assert.deepEqual(toggleStarred(['a'], 'b'), ['b', 'a']);
  });

  it('removes an existing star', () => {
    assert.deepEqual(toggleStarred(['a', 'b'], 'a'), ['b']);
  });

  it('returns the list unchanged for a missing id', () => {
    assert.deepEqual(toggleStarred(['a'], null), ['a']);
    assert.deepEqual(toggleStarred(null, null), []);
  });
});

describe('sortStarredFirst', () => {
  const items = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }];

  it('moves starred items to the front keeping the relative order', () => {
    const result = sortStarredFirst(items, ['d', 'b']);
    assert.deepEqual(
      result.map((i) => i.sessionId),
      ['b', 'd', 'a', 'c'],
    );
  });

  it('keeps the order when nothing is starred', () => {
    assert.deepEqual(
      sortStarredFirst(items, []).map((i) => i.sessionId),
      ['a', 'b', 'c', 'd'],
    );
  });

  it('handles missing input', () => {
    assert.deepEqual(sortStarredFirst(null, ['a']), []);
  });
});

describe('loadStarred / saveStarred（localStorage）', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('homeStarredSessions キーに JSON 配列で保存する', () => {
    saveStarred(['a', 'b']);
    assert.equal(store.get('homeStarredSessions'), '["a","b"]');
  });

  it('null を保存すると空配列になる', () => {
    saveStarred(null);
    assert.equal(store.get('homeStarredSessions'), '[]');
  });

  it('保存したものを読み戻せる', () => {
    store.set('homeStarredSessions', '["a","b"]');
    assert.deepEqual(loadStarred(), ['a', 'b']);
  });

  it('未保存なら空配列', () => {
    assert.deepEqual(loadStarred(), []);
  });

  it('文字列以外の要素は捨てる', () => {
    store.set('homeStarredSessions', '["a",1,null,{"x":1},"b"]');
    assert.deepEqual(loadStarred(), ['a', 'b']);
  });

  it('配列でない値・壊れた JSON は空配列にする', () => {
    store.set('homeStarredSessions', '{"a":1}');
    assert.deepEqual(loadStarred(), []);
    store.set('homeStarredSessions', '{broken');
    assert.deepEqual(loadStarred(), []);
  });
});
