import pty from "node-pty";
import { randomUUID } from "crypto";

export class Session {
  constructor({ id, name, cwd, args = [] }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.args = args;
    this.createdAt = new Date().toISOString();
    this._outputCallbacks = [];
    this._exitCallbacks = [];
    this._process = null;
    this._outputBuffer = [];
    this._outputBufferSize = 0;
    this._maxBufferSize = 1024 * 1024; // 1MB
  }

  start() {
    this._process = pty.spawn("claude", this.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    this._process.onData((data) => {
      this._outputBuffer.push(data);
      this._outputBufferSize += data.length;
      while (this._outputBufferSize > this._maxBufferSize) {
        const removed = this._outputBuffer.shift();
        this._outputBufferSize -= removed.length;
      }
      for (const cb of this._outputCallbacks) {
        cb(data);
      }
    });

    this._process.onExit(({ exitCode }) => {
      console.log(`Session ${this.id} (${this.name}) exited with code ${exitCode}`);
      this._process = null;
      for (const cb of this._exitCallbacks) {
        cb(exitCode);
      }
    });
  }

  write(text) {
    if (!this._process) return;
    // \n → \r に変換して PTY に送る
    this._process.write(text.replace(/\n/g, "\r"));
  }

  resize(cols, rows) {
    if (this._process && cols > 0 && rows > 0) {
      this._process.resize(cols, rows);
    }
  }

  kill() {
    if (this._process) {
      this._process.kill();
      this._process = null;
    }
  }

  getOutputBuffer() {
    return this._outputBuffer.join("");
  }

  onOutput(cb) {
    this._outputCallbacks.push(cb);
  }

  onExit(cb) {
    this._exitCallbacks.push(cb);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      createdAt: this.createdAt,
      alive: this._process !== null,
    };
  }
}

export class SessionManager {
  constructor(storage) {
    this.storage = storage;
    this.sessions = new Map();
    // サーバー再起動後に復元表示する過去セッション（プロセスなし）
    this.pastSessions = storage.loadSessions().map((s) => ({
      ...s,
      alive: false,
    }));
  }

  createSession({ name, cwd }) {
    const id = randomUUID().slice(0, 8);
    const session = new Session({ id, name, cwd });
    session.start();
    this.sessions.set(id, session);
    this.pastSessions = this.pastSessions.filter((p) => p.id !== id);
    this._persist();
    return session;
  }

  createSessionWithArgs({ name, cwd, args }) {
    const id = randomUUID().slice(0, 8);
    const session = new Session({ id, name, cwd, args });
    session.start();
    this.sessions.set(id, session);
    this.pastSessions = this.pastSessions.filter((p) => p.id !== id);
    this._persist();
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  killSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
      this._persist();
    }
  }

  // restart: 過去セッションと同じ名前・cwd で新規セッションを起動
  restartSession(pastSessionId) {
    const past = this.pastSessions.find((p) => p.id === pastSessionId);
    if (!past) return null;
    this.pastSessions = this.pastSessions.filter(
      (p) => p.id !== pastSessionId
    );
    return this.createSession({ name: past.name, cwd: past.cwd });
  }

  removePastSession(pastSessionId) {
    this.pastSessions = this.pastSessions.filter(
      (p) => p.id !== pastSessionId
    );
    this._persist();
  }

  listSessions() {
    const active = Array.from(this.sessions.values()).map((s) => s.toJSON());
    return [...active, ...this.pastSessions];
  }

  _persist() {
    const active = Array.from(this.sessions.values()).map((s) => s.toJSON());
    this.storage.saveSessions(active);
  }
}

// claude プロセスを起動せず、既存セッションの JSONL を読むだけの閲覧専用セッション。
// agent view 等で動いているセッションの会話にコメント/レビューを付けるための入れ物。
// Claude へは送信できない（write は no-op）。
export class ReadonlySession {
  constructor({ id, name, cwd, claudeSessionId, projectDir }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.claudeSessionId = claudeSessionId;
    this.projectDir = projectDir;
    this.createdAt = new Date().toISOString();
    this.type = "readonly";
  }

  // 閲覧専用: Claude へは送信しない
  write() {}
  resize() {}
  kill() {}
  getOutputBuffer() {
    return "";
  }
  onOutput() {}
  onExit() {}

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      claudeSessionId: this.claudeSessionId,
      projectDir: this.projectDir,
      createdAt: this.createdAt,
      alive: true,
      type: "readonly",
    };
  }
}

export class ReadonlySessionManager {
  constructor() {
    this.sessions = new Map();
  }

  create({ name, cwd, claudeSessionId, projectDir }) {
    const id = randomUUID().slice(0, 8);
    const session = new ReadonlySession({
      id,
      name,
      cwd,
      claudeSessionId,
      projectDir,
    });
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  remove(id) {
    this.sessions.delete(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }
}
