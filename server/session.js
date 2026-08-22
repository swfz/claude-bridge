import pty from 'node-pty';
import { randomUUID } from 'crypto';
// @xterm/headless は CJS なので named import できない
import xtermHeadless from '@xterm/headless';
import { readStatusByPid } from './claude-session-meta.js';
import { assertValidChoiceKeys, sanitizeChoiceText, toPtySequence, CHOICE_KEY_DELAY_MS } from './choice-keys.js';

const { Terminal } = xtermHeadless;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
// 本文を書いてから確定用 Enter を送るまでの間隔
const ENTER_DELAY_MS = 120;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
  constructor({ id, name, cwd, args = [] }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.args = args;
    this.createdAt = new Date().toISOString();
    this.status = null;
    this.waitingFor = null;
    this._outputCallbacks = [];
    this._exitCallbacks = [];
    this._process = null;
    this._outputBuffer = [];
    this._outputBufferSize = 0;
    this._maxBufferSize = 1024 * 1024; // 1MB
    // 生の ANSI 出力からは「今の画面」が分からないので、選択肢プロンプトを読むために
    // ヘッドレス端末で画面を再現する（tmux セッションの capture-pane に相当）
    this._term = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      allowProposedApi: true,
    });
  }

  start() {
    this._process = pty.spawn('claude', this.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    this._process.onData((data) => {
      this._outputBuffer.push(data);
      this._outputBufferSize += data.length;
      while (this._outputBufferSize > this._maxBufferSize) {
        const removed = this._outputBuffer.shift();
        this._outputBufferSize -= removed.length;
      }
      this._term?.write(data);
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
    const body = text.replace(/\n/g, '\r');
    const m = /^([\s\S]*?)(\r+)$/.exec(body);
    if (!m) {
      this._process.write(body);
      return;
    }
    // 本文と末尾の改行を一度に書くと Claude Code の TUI が「複数行入力の改行」と扱って
    // 送信されないため、確定用の Enter だけ少し遅らせて送る（tmux 側も send-keys を分けている）
    this._process.write(m[1]);
    setTimeout(() => this._process?.write('\r'), ENTER_DELAY_MS);
  }

  // 選択肢プロンプトの操作。write と違い改行を足さないので数字キー1つを送れる
  async sendChoiceKeys(keys) {
    if (!this._process) return;
    const list = assertValidChoiceKeys(keys);
    for (const [i, key] of list.entries()) {
      if (i > 0) await delay(CHOICE_KEY_DELAY_MS);
      this._process.write(toPtySequence(key));
    }
  }

  // 自由入力（"Type something"）用。Enter は付けない
  sendChoiceText(text) {
    const body = sanitizeChoiceText(text);
    if (!this._process || !body) return;
    this._process.write(body);
  }

  // ヘッドレス端末で再現した「今の画面」を返す（選択肢プロンプトのパース用）
  async getScreenText() {
    if (!this._term) return '';
    // write は非同期に処理されるので、空 write のコールバックで反映を待つ
    await new Promise((resolve) => this._term.write('', resolve));
    const buf = this._term.buffer.active;
    const lines = [];
    for (let y = buf.baseY; y < buf.baseY + this._term.rows; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }

  get claudePid() {
    return this._process?.pid ?? null;
  }

  resize(cols, rows) {
    if (this._process && cols > 0 && rows > 0) {
      this._process.resize(cols, rows);
      this._term.resize(cols, rows);
    }
  }

  kill() {
    if (this._process) {
      this._process.kill();
      this._process = null;
    }
    if (this._term) {
      this._term.dispose();
      this._term = null;
    }
  }

  getOutputBuffer() {
    return this._outputBuffer.join('');
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
      status: this.status,
      waitingFor: this.waitingFor,
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
    this.pastSessions = this.pastSessions.filter((p) => p.id !== pastSessionId);
    return this.createSession({ name: past.name, cwd: past.cwd });
  }

  removePastSession(pastSessionId) {
    this.pastSessions = this.pastSessions.filter((p) => p.id !== pastSessionId);
    this._persist();
  }

  listSessions() {
    const active = Array.from(this.sessions.values()).map((s) => s.toJSON());
    return [...active, ...this.pastSessions];
  }

  // 生きているセッションの実体（画面読み取り等に使う）
  activeSessions() {
    return Array.from(this.sessions.values());
  }

  // 各セッションの status / waitingFor を最新化。変化があれば true を返す
  // （waitingFor は選択肢待ちの検知に使う）
  async refreshStatuses() {
    let changed = false;
    for (const s of this.sessions.values()) {
      const pid = s.claudePid;
      if (pid == null) continue;
      const { status, waitingFor } = await readStatusByPid(pid);
      if (status !== s.status || waitingFor !== s.waitingFor) {
        s.status = status;
        s.waitingFor = waitingFor;
        changed = true;
      }
    }
    return changed;
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
    this.type = 'readonly';
  }

  // 閲覧専用: Claude へは送信しない
  write() {}
  resize() {}
  kill() {}
  getOutputBuffer() {
    return '';
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
      type: 'readonly',
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
