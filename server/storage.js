import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".claude-bridge");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");

export class Storage {
  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  saveSessions(sessions) {
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  }

  loadSessions() {
    try {
      return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
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
      return JSON.parse(readFileSync(file, "utf-8"));
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
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return [];
    }
  }
}
