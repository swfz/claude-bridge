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

// 本文を送ってから確定用の Enter を送るまでの間隔。
// 本文（複数行や末尾の \r を含む）と Enter を続けて送ると Claude Code の TUI が
// 一連の入力を「貼り付け」として扱い、Enter まで改行として入力欄に残る（送信されない）。
// session.js の ENTER_DELAY_MS と同じ理由で、Enter だけ少し遅らせる
const ENTER_DELAY_MS = 120;

export async function sendKeysToPane(paneId, text) {
  validatePaneId(paneId);
  try {
    // 末尾の改行は確定用の Enter に置き換える（呼び出し側が body + '\r' で渡してくる）
    const body = String(text).replace(/[\r\n]+$/, '');
    await execAsync(`tmux send-keys -t ${paneId} -l ${escapeForShell(body)}`);
    await delay(ENTER_DELAY_MS);
    await execAsync(`tmux send-keys -t ${paneId} Enter`);
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// C-u + 再送を試みるまでのポーリング回数（既定 pollMs=250 で約2秒）
const RESEND_AFTER_POLLS = 8;

// プロンプト待ちのシェルとみなすフォアグラウンドのコマンド名（ログインシェルは `-zsh` になる）
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);
const isShellCommand = (command) => SHELL_COMMANDS.has(command.replace(/^-/, ''));

async function paneCurrentCommand(paneId) {
  try {
    const { stdout } = await execAsync(`tmux display-message -p -t ${paneId} '#{pane_current_command}'`);
    return stdout.trim();
  } catch {
    return '';
  }
}

// 新しい window のシェルが rc（zinit/mise/starship 等）を読み終えてプロンプトを出すまで待つ。
// 「画面が空でなく、settleMs の間変化しない」を準備完了とみなす。readyTimeoutMs を過ぎたら
// 諦めて先へ進む（送信後の確認で取りこぼしは拾い直す）。
async function waitForQuietScreen(paneId, { pollMs, settleMs, deadline }) {
  let last = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const screen = await capturePane(paneId);
    if (screen !== last) {
      last = screen;
      stableSince = Date.now();
    } else if (screen.trim() && Date.now() - stableSince >= settleMs) {
      return;
    }
    await delay(pollMs);
  }
}

// 本文を送り、画面にエコーされるまで待つ。見えなければ入力行をクリアして再送する
async function typeUntilEchoed(paneId, sendLiteral, normalizedCommand, { pollMs, deadline }) {
  await sendLiteral();
  let pollsSinceResend = 0;
  while (true) {
    if (Date.now() > deadline) {
      throw new Error('シェルの起動を確認できませんでした（tmux window 内でコマンドが受け付けられません）');
    }
    await delay(pollMs);
    // ペイン幅が狭いとコマンドが折り返されるので、空白を全部除いて比較する
    const screen = await capturePane(paneId);
    if (screen.replace(/\s+/g, '').includes(normalizedCommand)) return;

    pollsSinceResend += 1;
    if (pollsSinceResend >= RESEND_AFTER_POLLS) {
      pollsSinceResend = 0;
      await execAsync(`tmux send-keys -t ${paneId} C-u`);
      await sendLiteral();
    }
  }
}

// 新しい tmux window のシェルにコマンドを打って実行させる。
// 画面のエコーだけでは準備完了と言えない（シェルが読む前でも端末ドライバが先行入力を
// エコーするので、rc の初期化中に Enter まで送ってしまい、取りこぼされることがある）。
// そのため (1) プロンプトが出て画面が落ち着くのを待ってから打ち、(2) Enter の後は
// ペインのフォアグラウンドがシェル以外に変わったかで起動を確かめ、
// シェルのままなら画面を見て Enter の再送／本文の打ち直しをする。
export async function sendCommandWhenShellReady(
  paneId,
  command,
  { pollMs = 250, timeoutMs = 20000, settleMs = 700, readyTimeoutMs = 8000, startCheckMs = 1500 } = {},
) {
  validatePaneId(paneId);
  const escapedCommand = escapeForShell(command);
  const normalizedCommand = command.replace(/\s+/g, '');
  const sendLiteral = () => execAsync(`tmux send-keys -t ${paneId} -l ${escapedCommand}`);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  await waitForQuietScreen(paneId, { pollMs, settleMs, deadline: startedAt + Math.min(readyTimeoutMs, timeoutMs) });

  await typeUntilEchoed(paneId, sendLiteral, normalizedCommand, { pollMs, deadline });
  await execAsync(`tmux send-keys -t ${paneId} Enter`);

  let lastCheck = Date.now();
  while (true) {
    if (Date.now() > deadline) {
      throw new Error('コマンドの起動を確認できませんでした（tmux window 内で Enter が受け付けられません）');
    }
    await delay(pollMs);

    // 落ち着いた時点の値と比べると rc の子プロセス（git 等）を拾って誤判定し得るので、
    // 既知のシェル名かどうかで見る
    const current = await paneCurrentCommand(paneId);
    if (current && !isShellCommand(current)) return;
    if (Date.now() - lastCheck < startCheckMs) continue;
    lastCheck = Date.now();
    // フォアグラウンドが分からないまま打ち直すと、起動済みの claude に本文を送りかねない。
    // 確かめようがないので（従来どおりエコー確認までで）終える
    if (!current) return;

    const normalizedScreen = (await capturePane(paneId)).replace(/\s+/g, '');
    const idx = normalizedScreen.lastIndexOf(normalizedCommand);
    if (idx === -1) {
      // 初期化中に先行入力ごと捨てられた。打ち直す
      await execAsync(`tmux send-keys -t ${paneId} C-u`);
      await typeUntilEchoed(paneId, sendLiteral, normalizedCommand, { pollMs, deadline });
      await execAsync(`tmux send-keys -t ${paneId} Enter`);
    } else if (normalizedScreen.slice(idx + normalizedCommand.length) === '') {
      // 本文は入力行に残ったまま（Enter だけ取りこぼされた）
      await execAsync(`tmux send-keys -t ${paneId} Enter`);
    } else {
      // コマンドの後ろに出力がある＝実行はされた（すぐ終了するコマンドなど）
      return;
    }
  }
}

// `tmux list-sessions -F "#{session_last_attached}\t#{session_name}"` の出力から
// 直近にアタッチされたセッション名を選ぶ。候補がなければ null。
export function pickTargetSession(stdout) {
  // 一度もアタッチされていないセッションは last_attached が空で行頭がタブになるので、
  // 全体を trim() すると先頭行のタブまで消えて名前を取りこぼす
  const rows = (stdout || '')
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

  // 末尾の `:` でセッション指定に固定する。素の `-t 0` のような数字だけの
  // セッション名は window index と解釈され「index 0 in use」で失敗する
  const command = sessionName
    ? `tmux new-window -t ${escapeForShell(`${sessionName}:`)} -n ${escapeForShell(windowName)}${cwdArg} ${format}`
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
  await sendCommandWhenShellReady(paneId, `claude --resume ${claudeSessionId}`);

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
