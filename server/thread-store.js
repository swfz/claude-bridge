import { randomUUID } from 'crypto';

export class ThreadStore {
  constructor(storage) {
    this.storage = storage;
    // sessionId -> Map<threadId, thread>
    this.threads = new Map();
  }

  loadForSession(sessionId) {
    if (!this.threads.has(sessionId)) {
      const saved = this.storage.loadThreads(sessionId);
      const map = new Map();
      for (const t of saved) {
        map.set(t.id, t);
      }
      this.threads.set(sessionId, map);
    }
    return this.threads.get(sessionId);
  }

  createThread(sessionId, { messageId, selectedText }) {
    const threads = this.loadForSession(sessionId);
    const thread = {
      id: `thread-${randomUUID().slice(0, 8)}`,
      messageId,
      selectedText,
      resolved: false,
      replies: [],
      createdAt: new Date().toISOString(),
    };
    threads.set(thread.id, thread);
    this._save(sessionId);
    return thread;
  }

  addReply(sessionId, threadId, { role, text }) {
    const threads = this.loadForSession(sessionId);
    const thread = threads.get(threadId);
    if (!thread) return null;
    const reply = {
      id: `reply-${randomUUID().slice(0, 8)}`,
      role,
      text,
      timestamp: new Date().toISOString(),
    };
    thread.replies.push(reply);
    this._save(sessionId);
    return reply;
  }

  resolveThread(sessionId, threadId) {
    const threads = this.loadForSession(sessionId);
    const thread = threads.get(threadId);
    if (!thread) return null;
    thread.resolved = !thread.resolved;
    this._save(sessionId);
    return thread;
  }

  deleteThread(sessionId, threadId) {
    const threads = this.loadForSession(sessionId);
    const deleted = threads.delete(threadId);
    if (deleted) this._save(sessionId);
    return deleted;
  }

  getThreadsForSession(sessionId) {
    const threads = this.loadForSession(sessionId);
    return Array.from(threads.values());
  }

  _save(sessionId) {
    const threads = this.threads.get(sessionId);
    if (threads) {
      this.storage.saveThreads(sessionId, Array.from(threads.values()));
    }
  }
}
