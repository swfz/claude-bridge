import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStarred, toggleStarred, sortStarredFirst } from '../client/src/utils/starredSessions.js';

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
