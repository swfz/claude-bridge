import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DATA_DIR = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const INBOX_DIR = join(DATA_DIR, 'inbox');

export class Storage {
  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  saveSessions(sessions) {
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  }

  loadSessions() {
    try {
      return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }

  saveThreads(sessionId, threads) {
    const file = join(DATA_DIR, `threads-${sessionId}.json`);
    writeFileSync(file, JSON.stringify(threads, null, 2));
  }

  loadThreads(sessionId) {
    try {
      const file = join(DATA_DIR, `threads-${sessionId}.json`);
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return [];
    }
  }

  saveComments(sessionId, comments) {
    const file = join(DATA_DIR, `comments-${sessionId}.json`);
    writeFileSync(file, JSON.stringify(comments, null, 2));
  }

  loadComments(sessionId) {
    try {
      const file = join(DATA_DIR, `comments-${sessionId}.json`);
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return [];
    }
  }

  // pending review（送信前に溜めた指摘）の下書き。Submit するまで保持し、
  // リロード/再オープン後も復元できるよう claudeSessionId 単位で永続化する。
  saveReviewDraft(sessionId, draft) {
    const file = join(DATA_DIR, `review-${sessionId}.json`);
    writeFileSync(file, JSON.stringify(draft, null, 2));
  }

  loadReviewDraft(sessionId) {
    try {
      const file = join(DATA_DIR, `review-${sessionId}.json`);
      const draft = JSON.parse(readFileSync(file, 'utf-8'));
      return Array.isArray(draft?.items) ? draft : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  // フックベース送信: 対象セッションの inbox に1行追記する（agent 側のフックが取り込む）。
  // sessionId はファイルパスに使うためトラバーサル対策で形式を検証する。
  appendInbox(sessionId, message) {
    if (!/^[\w-]+$/.test(sessionId || '')) {
      throw new Error(`invalid sessionId for inbox: ${sessionId}`);
    }
    mkdirSync(INBOX_DIR, { recursive: true });
    const file = join(INBOX_DIR, `${sessionId}.jsonl`);
    const line =
      JSON.stringify({
        id: message.id || `msg-${Date.now()}`,
        text: message.text || '',
        ts: message.ts || new Date().toISOString(),
      }) + '\n';
    appendFileSync(file, line, { mode: 0o600 });
  }
}
