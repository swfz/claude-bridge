import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusMapOf, updateAttention } from '../client/src/utils/attention.js';

describe('statusMapOf', () => {
  it('maps sessionId to status', () => {
    const map = statusMapOf([
      { id: 'a', status: 'busy' },
      { id: 'b', status: 'idle' },
    ]);
    assert.equal(map.get('a'), 'busy');
    assert.equal(map.get('b'), 'idle');
  });

  it('returns an empty map for missing input', () => {
    assert.equal(statusMapOf(null).size, 0);
  });
});

describe('updateAttention', () => {
  it('adds a session that transitions from busy to idle', () => {
    const prev = new Map([['a', 'busy']]);
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({ prev, current: new Set(), sessions });
    assert.deepEqual([...next], ['a']);
  });

  it('adds a session that transitions from busy to waiting', () => {
    const prev = new Map([['a', 'busy']]);
    const sessions = [{ id: 'a', status: 'waiting', alive: true }];
    const next = updateAttention({ prev, current: new Set(), sessions });
    assert.deepEqual([...next], ['a']);
  });

  it('does not add a session that stays idle', () => {
    const prev = new Map([['a', 'idle']]);
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({ prev, current: new Set(), sessions });
    assert.deepEqual([...next], []);
  });

  it('does not treat the first sighting of a session as a transition', () => {
    const prev = new Map(); // まだ何も記録していない（接続直後）
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({ prev, current: new Set(), sessions });
    assert.deepEqual([...next], []);
  });

  it('does not add the active tab while the user is viewing it', () => {
    const prev = new Map([['a', 'busy']]);
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({
      prev,
      current: new Set(),
      sessions,
      activeSessionId: 'a',
      isViewingActive: true,
    });
    assert.deepEqual([...next], []);
  });

  it('adds the active tab when the user is not actually viewing it (e.g. tab hidden)', () => {
    const prev = new Map([['a', 'busy']]);
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({
      prev,
      current: new Set(),
      sessions,
      activeSessionId: 'a',
      isViewingActive: false,
    });
    assert.deepEqual([...next], ['a']);
  });

  it('removes a session that disappeared from the list', () => {
    const prev = new Map([['a', 'idle']]);
    const next = updateAttention({
      prev,
      current: new Set(['a']),
      sessions: [],
    });
    assert.deepEqual([...next], []);
  });

  it('removes a session that became dead', () => {
    const prev = new Map([['a', 'idle']]);
    const sessions = [{ id: 'a', status: 'idle', alive: false }];
    const next = updateAttention({ prev, current: new Set(['a']), sessions });
    assert.deepEqual([...next], []);
  });

  it('returns the same reference when nothing changes', () => {
    const prev = new Map([['a', 'idle']]);
    const current = new Set();
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({ prev, current, sessions });
    assert.equal(next, current);
  });

  it('keeps an existing attention entry that has not been resolved yet', () => {
    const prev = new Map([['a', 'idle']]);
    const current = new Set(['a']);
    const sessions = [{ id: 'a', status: 'idle', alive: true }];
    const next = updateAttention({ prev, current, sessions });
    assert.deepEqual([...next], ['a']);
  });
});
