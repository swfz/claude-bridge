import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitive, toggleSensitive, splitSensitive } from '../client/src/utils/sensitiveSessions.js';

describe('isSensitive', () => {
  it('detects a sensitive session', () => {
    assert.equal(isSensitive(['a', 'b'], 'b'), true);
    assert.equal(isSensitive(['a'], 'b'), false);
  });

  it('handles missing input', () => {
    assert.equal(isSensitive(null, 'a'), false);
    assert.equal(isSensitive(['a'], null), false);
    assert.equal(isSensitive(['a'], ''), false);
  });
});

describe('toggleSensitive', () => {
  it('adds a new flag at the front', () => {
    assert.deepEqual(toggleSensitive(['a'], 'b'), ['b', 'a']);
  });

  it('removes an existing flag', () => {
    assert.deepEqual(toggleSensitive(['a', 'b'], 'a'), ['b']);
  });

  it('returns the list unchanged for a missing id', () => {
    assert.deepEqual(toggleSensitive(['a'], null), ['a']);
    assert.deepEqual(toggleSensitive(null, null), []);
  });
});

describe('splitSensitive', () => {
  const items = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }];

  it('splits into visible and hidden keeping the relative order', () => {
    const { visible, hidden } = splitSensitive(items, ['d', 'b']);
    assert.deepEqual(
      visible.map((i) => i.sessionId),
      ['a', 'c'],
    );
    assert.deepEqual(
      hidden.map((i) => i.sessionId),
      ['b', 'd'],
    );
  });

  it('keeps everything visible when nothing is sensitive', () => {
    const { visible, hidden } = splitSensitive(items, []);
    assert.deepEqual(
      visible.map((i) => i.sessionId),
      ['a', 'b', 'c', 'd'],
    );
    assert.deepEqual(hidden, []);
  });

  it('uses a custom keyOf (open tabs are keyed by claudeSessionId)', () => {
    const tabs = [
      { id: 't1', claudeSessionId: 'a' },
      { id: 't2', claudeSessionId: 'b' },
    ];
    const { visible, hidden } = splitSensitive(tabs, ['b'], (t) => t.claudeSessionId);
    assert.deepEqual(
      visible.map((t) => t.id),
      ['t1'],
    );
    assert.deepEqual(
      hidden.map((t) => t.id),
      ['t2'],
    );
  });

  it('keeps items without a key visible', () => {
    const tabs = [{ id: 't1' }, { id: 't2', claudeSessionId: null }];
    const { visible, hidden } = splitSensitive(tabs, ['a'], (t) => t.claudeSessionId);
    assert.deepEqual(
      visible.map((t) => t.id),
      ['t1', 't2'],
    );
    assert.deepEqual(hidden, []);
  });

  it('handles missing input', () => {
    assert.deepEqual(splitSensitive(null, ['a']), { visible: [], hidden: [] });
  });
});
