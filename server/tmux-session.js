import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { readStatusByPid } from './claude-session-meta.js';
import { mapPaneIdsToPids } from './running-sessions.js';
import { cwdToProjectDir } from './jsonl-utils.js';
import { assertValidChoiceKeys, sanitizeChoiceText, CHOICE_KEY_DELAY_MS } from './choice-keys.js';

const execAsync = promisify(exec);

// claude コマンド判定（macOS ではシンボリックリンク解決によりバージョン番号が表示される）
function isClaudeCommand(command) {
  if (command === 'claude') return true;
  // macOS: symlink 先の実バイナリ名がバージョン番号 (例: "2.1.100")
  // 他ツールでも同名バイナリがあれば誤検出するが、実際にはほぼない
  return /^\d+\.\d+\.\d+$/.test(command);
}

// tmux ペイン情報を取得し、Claude を実行中のペインだけ返す
export async function listClaudeTmuxPanes() {
  try {
    const { stdout } = await execAsync(
      'tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{session_name}"',
    );
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => {
        const [paneId, panePid, command, cwd, target, windowName, sessionName] = line.split('\t');
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
  if (typeof name !== 'string' || !/^[\w.:-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
}

export async function sendKeysToPane(paneId, text) {
  validatePaneId(paneId);
  try {
    const escaped = escapeForShell(text);
    await execAsync(`tmux send-keys -t ${paneId} -l ${escaped} && tmux send-keys -t ${paneId} Enter`);
  } catch (e) {
    console.error(`Failed to send keys to pane ${paneId}:`, e.message);
  }
}

// 選択肢プロンプト用の生キー送信。sendKeysToPane と違い Enter を勝手に付けないので、
// 数字キー1つ（＝選択の確定/トグル）や Escape（キャンセル）をそのまま送れる。
// tmux の send-keys はキー名（Enter / Escape / Tab ...）をそのまま解釈できる。
export async function sendChoiceKeysToPane(paneId, keys) {
  validatePaneId(paneId);
  const list = assertValidChoiceKeys(keys);
  for (const [i, key] of list.entries()) {
    if (i > 0) await delay(CHOICE_KEY_DELAY_MS);
    // 数字は -l でリテラル送信（tmux のキー名として解釈されるのを避ける）
    const arg = /^[0-9]$/.test(key) ? `-l ${escapeForShell(key)}` : key;
    await execAsync(`tmux send-keys -t ${paneId} ${arg}`);
  }
}

// 自由入力（"Type something"）用。テキストをリテラルで送るだけで Enter は付けない
export async function sendChoiceTextToPane(paneId, text) {
  validatePaneId(paneId);
  const body = sanitizeChoiceText(text);
  if (!body) return;
  await execAsync(`tmux send-keys -t ${paneId} -l ${escapeForShell(body)}`);
}

// ペインの現在の画面テキストを取得（scrollback 行数を指定すると遡れる）
export async function capturePane(paneId, { scrollback = 0 } = {}) {
  validatePaneId(paneId);
  const range = scrollback > 0 ? ` -S -${Math.min(2000, scrollback)}` : '';
  const { stdout } = await execAsync(`tmux capture-pane -t ${paneId} -p${range}`);
  return stdout;
}

function escapeForShell(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// tmux サーバーが動いていないときに作る受け皿セッション名
const FALLBACK_TMUX_SESSION = 'bridge';
// シェルの rc 読み込み中に send-keys すると入力が食われることがあるので少し待つ
const SHELL_READY_DELAY_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `tmux list-sessions -F "#{session_last_attached}\t#{session_name}"` の出力から
// 直近にアタッチされたセッション名を選ぶ。候補がなければ null。
export function pickTargetSession(stdout) {
  const rows = (stdout || '')
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [lastAttached, name] = line.split('\t');
      return { name, lastAttached: Number(lastAttached) || 0 };
    })
    .filter((r) => r.name && /^[\w.:-]+$/.test(r.name));

  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.lastAttached - a.lastAttached)[0].name;
}

// window 名。tmux の target 記法（`sess:win.pane`）と衝突しない文字だけにする
export function buildResumeWindowName(claudeSessionId) {
  return `claude-${String(claudeSessionId)
    .replace(/[^\w-]/g, '')
    .slice(0, 8)}`;
}

// tmux に新しい window を作り、そこで `claude --resume <id>` を起動する。
// PTY 直起動（resume_session）と違い、claude は tmux 側のプロセスになるので
// ブリッジを落としても生き続け、ターミナルからも操作できる。
export async function resumeInTmuxWindow({ claudeSessionId, cwd }) {
  if (!/^[\w-]+$/.test(claudeSessionId || '')) {
    throw new Error(`Invalid claudeSessionId: ${claudeSessionId}`);
  }

  const windowName = buildResumeWindowName(claudeSessionId);
  const cwdArg = cwd ? ` -c ${escapeForShell(cwd)}` : '';
  const format = "-P -F '#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}'";

  // 直近使ったセッションに window を足す。tmux サーバー自体が無ければ受け皿を作る
  // （new-session の初期 window をそのまま使うので空 window は残らない）。
  let sessionName;
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_last_attached}\t#{session_name}"');
    sessionName = pickTargetSession(stdout);
  } catch {
    sessionName = null;
  }

  const command = sessionName
    ? `tmux new-window -t ${sessionName} -n ${escapeForShell(windowName)}${cwdArg} ${format}`
    : `tmux new-session -d -s ${FALLBACK_TMUX_SESSION} -n ${escapeForShell(windowName)}${cwdArg} ${format}`;

  let stdout;
  try {
    ({ stdout } = await execAsync(command));
  } catch (e) {
    // tmux 自体が無い場合はコマンド全文を見せても意味がないので短く伝える
    if (/tmux: (not found|command not found)/.test(e.message)) {
      throw new Error('tmux コマンドが見つかりません（内蔵の「再開（内蔵）」を使ってください）', { cause: e });
    }
    throw new Error(`tmux window の作成に失敗しました: ${e.message}`, { cause: e });
  }

  const [paneId, target] = stdout.trim().split('\t');
  validatePaneId(paneId);

  // シェル経由で流すので rc（mise/nvm 等）を通る。claude を抜けてもペインは残る
  await delay(SHELL_READY_DELAY_MS);
  await sendKeysToPane(paneId, `claude --resume ${claudeSessionId}`);

  return {
    paneId,
    target: target || paneId,
    sessionName: sessionName || FALLBACK_TMUX_SESSION,
    windowName,
  };
}

export function resolveTmuxJsonlTarget({ claudeSessionId, cwd }) {
  if (!claudeSessionId) return null;
  return {
    sessionId: claudeSessionId,
    projectDir: cwdToProjectDir(cwd || ''),
  };
}

// tmux ペインをラップするセッションクラス
export class TmuxSession {
  constructor({ id, name, cwd, paneId, target, claudePid, status, waitingFor }) {
    validatePaneId(paneId);
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.paneId = paneId;
    this.target = target;
    this.claudePid = claudePid ?? null;
    this.status = status ?? null;
    this.waitingFor = waitingFor ?? null;
    this.createdAt = new Date().toISOString();
    this.type = 'tmux';
  }

  write(text) {
    sendKeysToPane(this.paneId, text);
  }

  // 選択肢プロンプトの現在の状態を読むための画面テキスト
  getScreenText() {
    return capturePane(this.paneId);
  }

  sendChoiceKeys(keys) {
    return sendChoiceKeysToPane(this.paneId, keys);
  }

  sendChoiceText(text) {
    return sendChoiceTextToPane(this.paneId, text);
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
      const { stdout } = await execAsync(`tmux capture-pane -t ${this.paneId} -p -S -500`);
      return stdout;
    } catch {
      return '';
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
      waitingFor: this.waitingFor,
      createdAt: this.createdAt,
      alive: true,
      type: 'tmux',
    };
  }
}

export class TmuxSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  attachPane({ paneId, name, cwd, target, claudePid, status, waitingFor }) {
    const id = randomUUID().slice(0, 8);
    const session = new TmuxSession({
      id,
      name,
      cwd,
      paneId,
      target,
      claudePid,
      status,
      waitingFor,
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

  // アタッチ中のセッションの実体（画面読み取り等に使う）
  activeSessions() {
    return Array.from(this.sessions.values());
  }

  // 各 tmux セッションの status / waitingFor を最新化。変化があれば true を返す
  // resolvePids / readStatus はテストから差し替えられるようにしている。
  async refreshStatuses({ resolvePids = mapPaneIdsToPids, readStatus = readStatusByPid } = {}) {
    let changed = false;

    // resume_in_tmux 直後は claudePid が分からないので、ステータスファイルの
    // tmux フィールド（paneId）から逆引きしてバックフィルする
    // （これをしないと該当タブでは選択肢プロンプトが永久に検知されない）
    const unresolved = Array.from(this.sessions.values()).filter((s) => s.claudePid == null);
    if (unresolved.length > 0) {
      const pidByPane = await resolvePids(unresolved.map((s) => s.paneId));
      for (const s of unresolved) {
        const pid = pidByPane.get(s.paneId);
        if (pid != null) {
          s.claudePid = pid;
          changed = true;
        }
      }
    }

    for (const s of this.sessions.values()) {
      if (s.claudePid == null) continue;
      const { status, waitingFor } = await readStatus(s.claudePid);
      if (status !== s.status || waitingFor !== s.waitingFor) {
        s.status = status;
        s.waitingFor = waitingFor;
        changed = true;
      }
    }
    return changed;
  }
}
