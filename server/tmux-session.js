import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { readStatusByPid } from "./claude-session-meta.js";
import { cwdToProjectDir } from "./jsonl-utils.js";

const execAsync = promisify(exec);

// claude コマンド判定（macOS ではシンボリックリンク解決によりバージョン番号が表示される）
function isClaudeCommand(command) {
  if (command === "claude") return true;
  // macOS: symlink 先の実バイナリ名がバージョン番号 (例: "2.1.100")
  // 他ツールでも同名バイナリがあれば誤検出するが、実際にはほぼない
  return /^\d+\.\d+\.\d+$/.test(command);
}

// tmux ペイン情報を取得し、Claude を実行中のペインだけ返す
export async function listClaudeTmuxPanes() {
  try {
    const { stdout } = await execAsync(
      'tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{session_name}"'
    );
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => {
        const [paneId, panePid, command, cwd, target, windowName, sessionName] =
          line.split("\t");
        return { paneId, panePid, command, cwd, target, windowName, sessionName };
      })
      .filter((p) => isClaudeCommand(p.command));
  } catch {
    return [];
  }
}

// tmux ペインにテキストを送信
function validatePaneId(paneId) {
  // tmux pane ID は %<数字> の形式
  if (!/^%\d+$/.test(paneId)) {
    throw new Error(`Invalid paneId format: ${paneId}`);
  }
}

// tmux セッション名のバリデーション（シェルに渡すためインジェクション対策）
// tmux のセッション名は英数・ハイフン・アンダースコア・ドット・コロンのみ許可
export function validateSessionName(name) {
  if (typeof name !== "string" || !/^[\w.:-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
}

export async function sendKeysToPane(paneId, text) {
  validatePaneId(paneId);
  try {
    const escaped = escapeForShell(text);
    await execAsync(
      `tmux send-keys -t ${paneId} -l ${escaped} && tmux send-keys -t ${paneId} Enter`
    );
  } catch (e) {
    console.error(`Failed to send keys to pane ${paneId}:`, e.message);
  }
}

function escapeForShell(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

export function resolveTmuxJsonlTarget({ claudeSessionId, cwd }) {
  if (!claudeSessionId) return null;
  return {
    sessionId: claudeSessionId,
    projectDir: cwdToProjectDir(cwd || ""),
  };
}

// tmux ペインをラップするセッションクラス
export class TmuxSession {
  constructor({ id, name, cwd, paneId, target, claudePid, status }) {
    validatePaneId(paneId);
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.paneId = paneId;
    this.target = target;
    this.claudePid = claudePid ?? null;
    this.status = status ?? null;
    this.createdAt = new Date().toISOString();
    this.type = "tmux";
  }

  write(text) {
    sendKeysToPane(this.paneId, text);
  }

  resize() {
    // tmux ペインのリサイズはユーザーのターミナルに任せる
  }

  kill() {
    // tmux ペインは kill しない（ユーザーのセッション）
  }

  async getOutputBuffer() {
    // tmux capture-pane で現在の画面内容を取得
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${this.paneId} -p -S -500`
      );
      return stdout;
    } catch {
      return "";
    }
  }

  onOutput() {
    // tmux ペインの出力はキャプチャしない（JSONL watcher に任せる）
  }

  onExit() {
    // tmux ペインの終了は監視しない
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      paneId: this.paneId,
      target: this.target,
      claudePid: this.claudePid,
      status: this.status,
      createdAt: this.createdAt,
      alive: true,
      type: "tmux",
    };
  }
}

export class TmuxSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  attachPane({ paneId, name, cwd, target, claudePid, status }) {
    const id = randomUUID().slice(0, 8);
    const session = new TmuxSession({
      id,
      name,
      cwd,
      paneId,
      target,
      claudePid,
      status,
    });
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  detachSession(id) {
    this.sessions.delete(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  // 各 tmux セッションの status を最新化。変化があれば true を返す
  async refreshStatuses() {
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.claudePid == null) continue;
      const status = await readStatusByPid(s.claudePid);
      if (status !== s.status) {
        s.status = status;
        changed = true;
      }
    }
    return changed;
  }
}
