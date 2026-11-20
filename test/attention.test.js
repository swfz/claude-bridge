import { describe, it } from 'vitest';
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

describe('updateAttention（境界）', () => {
  it('追加するときは current を書き換えず、新しい Set を返す', () => {
    const prev = new Map([['a', 'busy']]);
    const current = new Set();
    const next = updateAttention({ prev, current, sessions: [{ id: 'a', status: 'idle', alive: true }] });
    assert.notEqual(next, current);
    assert.deepEqual([...current], []);
    assert.deepEqual([...next], ['a']);
  });

  it('外すときも current を書き換えず、新しい Set を返す', () => {
    const current = new Set(['a']);
    const next = updateAttention({ prev: new Map([['a', 'idle']]), current, sessions: [] });
    assert.notEqual(next, current);
    assert.deepEqual([...current], ['a']);
    assert.deepEqual([...next], []);
  });

  it('1 回の更新で複数の追加・削除をまとめて反映する', () => {
    const prev = new Map([
      ['a', 'busy'],
      ['b', 'busy'],
    ]);
    const current = new Set(['x', 'y']);
    const sessions = [
      { id: 'a', status: 'idle', alive: true },
      { id: 'b', status: 'waiting', alive: true },
    ];
    const next = updateAttention({ prev, current, sessions });
    assert.deepEqual([...next].sort(), ['a', 'b']);
    assert.deepEqual([...current], ['x', 'y']);
  });

  it('死んだセッションは busy から抜けても追加しない', () => {
    const prev = new Map([['a', 'busy']]);
    const next = updateAttention({ prev, current: new Set(), sessions: [{ id: 'a', status: 'idle', alive: false }] });
    assert.deepEqual([...next], []);
  });

  it('前回のスナップショットが無ければ何も追加しない', () => {
    const current = new Set();
    const next = updateAttention({ prev: undefined, current, sessions: [{ id: 'a', status: 'idle', alive: true }] });
    assert.equal(next, current);
  });

  it('busy のままのセッションは追加しない', () => {
    const prev = new Map([['a', 'busy']]);
    const next = updateAttention({ prev, current: new Set(), sessions: [{ id: 'a', status: 'busy', alive: true }] });
    assert.deepEqual([...next], []);
  });

  it('見ているのが別のタブなら、busy から抜けたタブは追加する', () => {
    const prev = new Map([['a', 'busy']]);
    const next = updateAttention({
      prev,
      current: new Set(),
      sessions: [{ id: 'a', status: 'idle', alive: true }],
      activeSessionId: 'b',
      isViewingActive: true,
    });
    assert.deepEqual([...next], ['a']);
  });

  it('すでに対象のタブがまた busy から抜けても同じ参照を返す', () => {
    const prev = new Map([['a', 'busy']]);
    const current = new Set(['a']);
    const next = updateAttention({ prev, current, sessions: [{ id: 'a', status: 'idle', alive: true }] });
    assert.equal(next, current);
  });
});
