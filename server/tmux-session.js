import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

// tmux ペイン情報を取得し、Claude を実行中のペインだけ返す
export async function listClaudeTmuxPanes() {
  try {
    const { stdout } = await execAsync(
      'tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_name}"'
    );
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => {
        const [paneId, panePid, command, cwd, target, windowName] =
          line.split("\t");
        return { paneId, panePid, command, cwd, target, windowName };
      })
      .filter((p) => p.command === "claude");
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

// tmux ペインをラップするセッションクラス
export class TmuxSession {
  constructor({ id, name, cwd, paneId, target }) {
    validatePaneId(paneId);
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.paneId = paneId;
    this.target = target;
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

  attachPane({ paneId, name, cwd, target }) {
    const id = randomUUID().slice(0, 8);
    const session = new TmuxSession({ id, name, cwd, paneId, target });
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
}
