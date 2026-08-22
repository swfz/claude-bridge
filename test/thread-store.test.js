import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadStore } from '../server/thread-store.js';

// Storage のモック
function createMockStorage() {
  const data = {};
  return {
    loadThreads: (sessionId) => data[`threads-${sessionId}`] || [],
    saveThreads: (sessionId, threads) => {
      data[`threads-${sessionId}`] = threads;
    },
    _data: data,
  };
}

describe('ThreadStore', () => {
  let store;
  let storage;

  beforeEach(() => {
    storage = createMockStorage();
    store = new ThreadStore(storage);
  });

  describe('createThread', () => {
    it('creates a thread with correct fields', () => {
      const thread = store.createThread('session1', {
        messageId: 'msg-1',
        selectedText: 'hello world',
      });

      assert.ok(thread.id.startsWith('thread-'));
      assert.equal(thread.messageId, 'msg-1');
      assert.equal(thread.selectedText, 'hello world');
      assert.equal(thread.resolved, false);
      assert.deepEqual(thread.replies, []);
      assert.ok(thread.createdAt);
    });

    it('persists to storage', () => {
      store.createThread('session1', { messageId: 'msg-1', selectedText: 'test' });

      const saved = storage._data['threads-session1'];
      assert.equal(saved.length, 1);
    });
  });

  describe('addReply', () => {
    it('adds a reply to existing thread', () => {
      const thread = store.createThread('s1', { messageId: 'm1', selectedText: 'text' });
      const reply = store.addReply('s1', thread.id, { role: 'human', text: 'my reply' });

      assert.ok(reply.id.startsWith('reply-'));
      assert.equal(reply.role, 'human');
      assert.equal(reply.text, 'my reply');
      assert.ok(reply.timestamp);

      const threads = store.getThreadsForSession('s1');
      assert.equal(threads[0].replies.length, 1);
    });

    it('returns null for nonexistent thread', () => {
      assert.equal(store.addReply('s1', 'nonexistent', { role: 'human', text: 'test' }), null);
    });
  });

  describe('resolveThread', () => {
    it('toggles resolved status', () => {
      const thread = store.createThread('s1', { messageId: 'm1', selectedText: 'text' });

      store.resolveThread('s1', thread.id);
      assert.equal(store.getThreadsForSession('s1')[0].resolved, true);

      store.resolveThread('s1', thread.id);
      assert.equal(store.getThreadsForSession('s1')[0].resolved, false);
    });

    it('returns null for nonexistent thread', () => {
      assert.equal(store.resolveThread('s1', 'nonexistent'), null);
    });
  });

  describe('deleteThread', () => {
    it('removes the thread', () => {
      const thread = store.createThread('s1', { messageId: 'm1', selectedText: 'text' });
      const deleted = store.deleteThread('s1', thread.id);

      assert.equal(deleted, true);
      assert.equal(store.getThreadsForSession('s1').length, 0);
    });

    it('returns false for nonexistent thread', () => {
      assert.equal(store.deleteThread('s1', 'nonexistent'), false);
    });
  });

  describe('getThreadsForSession', () => {
    it('returns all threads for a session', () => {
      store.createThread('s1', { messageId: 'm1', selectedText: 'a' });
      store.createThread('s1', { messageId: 'm2', selectedText: 'b' });
      store.createThread('s2', { messageId: 'm3', selectedText: 'c' });

      assert.equal(store.getThreadsForSession('s1').length, 2);
      assert.equal(store.getThreadsForSession('s2').length, 1);
    });

    it('returns empty array for unknown session', () => {
      assert.deepEqual(store.getThreadsForSession('unknown'), []);
    });
  });
});
