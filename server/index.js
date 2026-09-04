import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync, lstatSync, readdirSync } from 'fs';
import { extname, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SessionManager, ReadonlySessionManager } from './session.js';
import { Storage } from './storage.js';
import { ThreadStore } from './thread-store.js';
import { listClaudeSessions, listRecentSessions, loadSessionHistory } from './claude-sessions.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { cwdToProjectDir } from './jsonl-utils.js';
import { listClaudeTmuxPanes, resolveTmuxJsonlTarget, resumeInTmuxWindow, TmuxSessionManager } from './tmux-session.js';
import { listClaudeAgents } from './claude-agents.js';
import { enrichPanesWithSessionMeta, readStatusByPid } from './claude-session-meta.js';
import { listRunningSessions } from './running-sessions.js';
import { parseChoicePrompt } from './choice-prompt.js';
import { listSubagentTasks, readSubagentTranscript } from './subagent-tasks.js';
import { listShellTasks, readShellTaskOutput } from './shell-tasks.js';
import { readRateLimits } from './rate-limits.js';
import { listSlashCommands } from './slash-commands.js';
import { getActivityHeatmap } from './activity-heatmap.js';

const PORT = process.env.PORT || 3000;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ローカルファイルプレビュー用エンドポイント
// /preview?path=/home/user/file.html
const MIME_MAP = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.sql': 'text/plain; charset=utf-8',
  '.sqlx': 'text/plain; charset=utf-8',
};

// パスのサンドボックスチェック（home/tmp 配下のみ許可）
function validateSafePath(filePath) {
  if (!filePath) return { status: 400, error: 'path parameter required' };

  // セキュリティ: パス正規化でトラバーサル攻撃を防止
  const canonical = resolve(filePath);
  const home = resolve(process.env.HOME || '/home');
  const tmp = resolve('/tmp');
  if (
    !canonical.startsWith(home + '/') &&
    canonical !== home &&
    !canonical.startsWith(tmp + '/') &&
    canonical !== tmp
  ) {
    return { status: 403, error: 'Access denied: path must be under home or /tmp' };
  }
  return { status: 200, canonical };
}

// ファイルパスのセキュリティ検証と lstat 取得を共通化
function validatePreviewPath(filePath) {
  const safe = validateSafePath(filePath);
  if (safe.error) return safe;

  try {
    // シンボリックリンクを辿らず検査（リンク先への脱出を防止）
    const lstat = lstatSync(safe.canonical);
    if (lstat.isSymbolicLink()) {
      return { status: 403, error: 'Access denied: symlinks not allowed' };
    }
    if (!lstat.isFile()) {
      return { status: 400, error: 'Not a file' };
    }
    // 100MB 上限
    if (lstat.size > 100 * 1024 * 1024) {
      return { status: 413, error: 'File too large' };
    }
    return { status: 200, canonical: safe.canonical, lstat };
  } catch {
    return { status: 404, error: 'File not found' };
  }
}

// ファイラで常に除外するディレクトリ名
const EXCLUDED_DIRS = new Set(['node_modules']);

app.get('/preview', (req, res) => {
  const result = validatePreviewPath(req.query.path);
  if (result.error) {
    return res.status(result.status).send(result.error);
  }

  const ext = extname(result.canonical).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.sendFile(result.canonical);
});

// ファイル存在確認 (プレビューボタンを出すべきかの判定用)
// プレビュー可能条件 (homeもしくは/tmp配下の実ファイル, 100MB以下, 非シンボリックリンク) を満たす場合のみ ok
app.get('/file-exists', (req, res) => {
  const result = validatePreviewPath(req.query.path);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ exists: result.status === 200 });
});

// ファイラ用ディレクトリ一覧
// /ls?path=/home/user/project
// 隠しファイル・node_modules 等は除外する
app.get('/ls', (req, res) => {
  const safe = validateSafePath(req.query.path);
  if (safe.error) {
    return res.status(safe.status).send(safe.error);
  }

  try {
    const lstat = lstatSync(safe.canonical);
    if (lstat.isSymbolicLink()) {
      return res.status(403).send('Access denied: symlinks not allowed');
    }
    if (!lstat.isDirectory()) {
      return res.status(400).send('Not a directory');
    }
  } catch {
    return res.status(404).send('Directory not found');
  }

  let dirents;
  try {
    dirents = readdirSync(safe.canonical, { withFileTypes: true });
  } catch (err) {
    return res.status(500).send(`Failed to read directory: ${err.code || err.message}`);
  }

  const entries = dirents
    // 隠しファイル・除外ディレクトリは表示しない
    .filter((e) => !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name))
    // シンボリックリンク・特殊ファイルは除外（プレビュー方針と揃える）
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }))
    // ディレクトリを先頭にしてアルファベット順
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  res.setHeader('Cache-Control', 'no-cache');
  res.json({ path: safe.canonical, entries });
});

// ファイラのルート候補
// サンドボックス（home / /tmp 配下）の起点をクライアントに教えるだけ。
// クライアント側は絶対パスだけを扱えるようにしたいので `~` の展開はここで済ませる。
app.get('/roots', (req, res) => {
  const home = resolve(process.env.HOME || '/home');
  const homeTmp = join(home, 'tmp');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ home, tmp: '/tmp', homeTmp: existsSync(homeTmp) ? homeTmp : null });
});

// ファイラ用の再帰ファイル名検索
// /search?path=<dir>&q=<term>
// cwd 配下を walk し、ファイル名に q を含むものを返す。隠し/node_modules は除外、
// シンボリックリンクは辿らない。暴走防止に件数・訪問数の上限を設ける。
app.get('/search', (req, res) => {
  const safe = validateSafePath(req.query.path);
  if (safe.error) {
    return res.status(safe.status).send(safe.error);
  }
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();
  if (!q) {
    return res.json({ matches: [], truncated: false });
  }

  try {
    const st = lstatSync(safe.canonical);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return res.status(400).send('Not a directory');
    }
  } catch {
    return res.status(404).send('Directory not found');
  }

  const MAX_MATCHES = 300;
  const MAX_VISIT = 20000;
  const matches = [];
  let visited = 0;
  const stack = [safe.canonical];

  while (stack.length > 0 && matches.length < MAX_MATCHES && visited < MAX_VISIT) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirents) {
      if (matches.length >= MAX_MATCHES || visited >= MAX_VISIT) break;
      if (e.name.startsWith('.') || EXCLUDED_DIRS.has(e.name)) continue;
      if (e.isSymbolicLink()) continue; // リンクは辿らない
      visited++;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase().includes(q)) {
        matches.push({ name: e.name, path: full });
      }
    }
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ matches, truncated: matches.length >= MAX_MATCHES });
});

// クライアントのビルド成果物を配信
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', 'client', 'dist');
// HTML はキャッシュ禁止、JS/CSS はハッシュ付きなので長期キャッシュOK
app.use(
  express.static(clientDist, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }),
);
// SPA フォールバック
app.get('/{*splat}', (req, res) => {
  const indexPath = join(clientDist, 'index.html');
  if (existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Client not built. Run: cd client && npm run build');
  }
});

const storage = new Storage();
const sessionManager = new SessionManager(storage);
const tmuxSessionManager = new TmuxSessionManager();
const readonlySessionManager = new ReadonlySessionManager();
const threadStore = new ThreadStore(storage);
const jsonlWatcher = new JsonlWatcher();

// クライアントから来るセッション ID 配列（Star 付きなど）を検証する。
// ファイル名の一部になるので inbox と同じ文字種に限り、件数も抑える。
function sanitizeSessionIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => typeof id === 'string' && /^[\w-]+$/.test(id)).slice(0, 200);
}

// ホーム画面の「直近のセッション」の期間。クライアント指定を 1〜365 日に丸める
function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return 7;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

// 「直近のセッション」の件数上限。固定 50 件だと活発な期間は新しい数日分で埋まって
// 30 日を選んでも 7 日分しか見えなくなるため、期間に比例させる（1 日あたり 10 件・下限 50・上限 500）
function recentSessionLimit(days) {
  return Math.min(500, Math.max(50, days * 10));
}

// ヒートマップの期間。1 年分の升目が既定で、指定は 28〜730 日に丸める
function clampHeatmapDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return 365;
  return Math.min(730, Math.max(28, Math.floor(n)));
}

function findSession(id) {
  return sessionManager.getSession(id) || tmuxSessionManager.getSession(id) || readonlySessionManager.getSession(id);
}

function allSessions() {
  const sessions = [
    ...sessionManager.listSessions(),
    ...tmuxSessionManager.listSessions(),
    ...readonlySessionManager.listSessions(),
  ];
  // watcher が把握している JSONL から claudeSessionId / projectDir を付与する。
  // ブラウザ再読込後にクライアントが履歴を再取得できるようにするため。
  return sessions.map((s) => {
    const meta = jsonlWatcher.getSessionMeta(s.id);
    return meta ? { ...s, ...meta } : s;
  });
}

function broadcastSessionList() {
  broadcast({ type: 'session_list', sessions: allSessions() });
}

// 閉じた WebSocket への送信は 'error' を emit してプロセスを落とし得るので、
// 非同期処理の完了後に返すものはこれを通す（リロードで ws が消えていても続行する）。
function sendTo(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

// tmux ペインをブリッジのタブとして開く。attach_tmux_pane（既存ペインへの接続）と
// resume_in_tmux（新しい window で resume 起動）の共通処理。
function attachTmuxPaneAsSession(ws, { paneId, name, cwd, target, claudePid, claudeSessionId, status, waitingFor }) {
  const session = tmuxSessionManager.attachPane({
    paneId,
    name: name || `tmux: ${target}`,
    cwd,
    target,
    claudePid,
    status,
    waitingFor,
  });

  // ペインごとに解決済みの sessionId がある場合だけ JSONL に紐づける。
  // cwd の最新 JSONL 推定は、複数 tmux セッション/同一 cwd で取り違えるため使わない。
  const resolved = resolveTmuxJsonlTarget({ claudeSessionId, cwd });
  if (resolved) {
    loadSessionHistory(resolved.sessionId, resolved.projectDir).then((history) => {
      sendTo(ws, {
        type: 'session_history',
        bridgeSessionId: session.id,
        messages: history,
      });
    });

    // JSONL 監視開始（新規メッセージのみ配信）
    jsonlWatcher.startWatching({
      bridgeSessionId: session.id,
      cwd,
      sessionId: resolved.sessionId,
      attachExisting: true,
      onMessage: (chatMsg) => broadcast(chatMsg),
    });
  }

  sendTo(ws, { type: 'session_opened', bridgeSessionId: session.id });
  broadcastSessionList();
  return session;
}

// JSONL の読み先（<projectDir>/<claudeSessionId>）を解決する。readonly セッションは
// 自分で両方持ち、それ以外は watcher が監視中の JSONL から把握している。
function resolveClaudeTarget(session) {
  if (!session) return null;
  const meta =
    session.claudeSessionId && session.projectDir
      ? {
          claudeSessionId: session.claudeSessionId,
          projectDir: session.projectDir,
        }
      : jsonlWatcher.getSessionMeta(session.id);
  return meta?.claudeSessionId && meta?.projectDir ? meta : null;
}

// コメント/レビューの保存キーを解決する。claudeSessionId を優先し、無ければ
// ブリッジ sessionId にフォールバック。ファイル名に使うため形式を検証して不正なら null。
// クライアントは sessionKey（旧 commentKey）で渡す。
function sessionKeyOf(msg) {
  const key = msg.sessionKey || msg.commentKey || msg.sessionId || '';
  return /^[\w-]+$/.test(key) ? key : null;
}

// ping/pong で接続切れを検知
const PING_INTERVAL = 30_000;
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

// 選択肢プロンプト（AskUserQuestion / ツール許可 / trust 確認）の現在の状態を画面から読む。
// JSONL には回答後にしか書かれないので、待っている間の情報源は画面テキストだけ。
async function readChoicePrompt(session) {
  if (!session || typeof session.getScreenText !== 'function') return null;
  try {
    return parseChoicePrompt(await session.getScreenText());
  } catch (e) {
    console.error(`Failed to read screen of session ${session.id}:`, e.message);
    return null;
  }
}

// キーを送ってから TUI が描き直すまでの待ち
const SCREEN_SETTLE_MS = 450;

// クライアントへ配った内容（sessionId -> JSON 文字列）。同じものを送り続けないための記録
const lastChoicePrompts = new Map();

// 回答直後に「まだ待ち」と見せないよう、そのセッションの status だけ先に更新する
async function refreshSessionStatus(session) {
  if (!session || session.claudePid == null) return;
  const { status, waitingFor } = await readStatusByPid(session.claudePid);
  session.status = status;
  session.waitingFor = waitingFor;
}

function broadcastChoicePrompt(session, prompt) {
  const payload = {
    type: 'choice_prompt',
    sessionId: session.id,
    waitingFor: session.waitingFor ?? null,
    prompt,
  };
  const json = JSON.stringify(payload);
  if (lastChoicePrompts.get(session.id) === json) return;
  lastChoicePrompts.set(session.id, json);
  broadcast(payload);
}

// 選択肢待ちのセッションだけ画面を読む（待っていなければ prompt を消す通知だけ出す）
async function pollChoicePrompts() {
  const sessions = [...sessionManager.activeSessions(), ...tmuxSessionManager.activeSessions()];
  for (const session of sessions) {
    const prompt = session.waitingFor ? await readChoicePrompt(session) : null;
    broadcastChoicePrompt(session, prompt);
  }
}

// セッションの busy/idle/waiting を定期的に最新化し、変化があればタブと選択肢カードへ反映
const STATUS_INTERVAL = 4_000;
const statusInterval = setInterval(async () => {
  const [tmuxChanged, ptyChanged] = await Promise.all([
    tmuxSessionManager.refreshStatuses(),
    sessionManager.refreshStatuses(),
  ]);
  if (tmuxChanged || ptyChanged) broadcastSessionList();
  await pollChoicePrompts();
}, STATUS_INTERVAL);
wss.on('close', () => clearInterval(statusInterval));

// Claude のレート制限（5時間/7日ウィンドウの使用率）。bridge-statusline-tee.js が
// 横流ししたファイルを読むだけ（外部通信なし）なのでローカルファイル読みとして短い間隔で回す。
const RATE_LIMITS_INTERVAL = 15_000;
// { usage, fetchedAt } を保持。取得に失敗しても古い値は消さない（stale 表示を許容する）
let lastRateLimits = null;
// 直前にクライアントへ配った内容（JSON 文字列）。statusline が更新されない間は
// 同じ内容が続くので、変化があったときだけ broadcast する。
let lastRateLimitsJson = null;
// 失敗理由が変わったときだけログを出す（毎回吐いてログを埋めないため）
let lastRateLimitFailureReason = null;
async function pollRateLimits() {
  const result = await readRateLimits();
  if (result.ok) {
    lastRateLimits = { usage: result.usage, fetchedAt: result.fetchedAt };
    lastRateLimitFailureReason = null;
    const json = JSON.stringify({ usage: result.usage, fetchedAt: result.fetchedAt });
    if (json === lastRateLimitsJson) return;
    lastRateLimitsJson = json;
    broadcast({ type: 'rate_limits', usage: result.usage, fetchedAt: result.fetchedAt });
    return;
  }
  if (result.reason !== lastRateLimitFailureReason) {
    lastRateLimitFailureReason = result.reason;
    if (result.reason === 'no-file') {
      console.log('rate limits: statusline 連携が未設定です（npm run setup:statusline で登録してください）');
    } else {
      console.error(`rate limits: read failed (${result.reason})`);
    }
  }
}
pollRateLimits();
const rateLimitsInterval = setInterval(pollRateLimits, RATE_LIMITS_INTERVAL);
wss.on('close', () => clearInterval(rateLimitsInterval));

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.send(
    JSON.stringify({
      type: 'session_list',
      sessions: allSessions(),
    }),
  );

  // 直近のレート制限情報があれば接続直後に送る（次のポーリングを待たせない）
  if (lastRateLimits) {
    sendTo(ws, {
      type: 'rate_limits',
      usage: lastRateLimits.usage,
      fetchedAt: lastRateLimits.fetchedAt,
    });
  }

  // 選択肢プロンプトの読み取り/送信で await するため async。
  // 各 case は自分で try/catch する（このハンドラの外に例外を投げない）
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'new_session': {
        const sessionCwd = msg.cwd || process.env.HOME;
        const session = sessionManager.createSession({
          name: msg.name || 'New Session',
          cwd: sessionCwd,
        });

        session.onOutput((data) => {
          broadcast({
            type: 'output',
            sessionId: session.id,
            data,
          });
        });

        session.onExit((code) => {
          jsonlWatcher.stopWatching(session.id);
          broadcast({
            type: 'session_exited',
            sessionId: session.id,
            code,
          });
        });

        // JSONL 監視開始
        jsonlWatcher.startWatching({
          bridgeSessionId: session.id,
          cwd: sessionCwd,
          onMessage: (chatMsg) => broadcast(chatMsg),
        });

        ws.send(JSON.stringify({ type: 'session_opened', bridgeSessionId: session.id }));
        broadcastSessionList();
        break;
      }

      case 'input': {
        const session = findSession(msg.sessionId);
        if (session) {
          // 「届かない」調査用に到達だけ記録する（本文は残さない）
          console.log(`input -> ${String(msg.sessionId).slice(0, 8)} (${(msg.text || '').length} chars)`);
          session.write(msg.text);
        } else {
          console.warn(`input: session ${msg.sessionId} not found or dead`);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'セッションが見つかりません。新しいセッションを作成してください。',
              sessionId: msg.sessionId,
            }),
          );
        }
        break;
      }

      case 'resize': {
        const session = findSession(msg.sessionId);
        if (session) {
          session.resize(msg.cols, msg.rows);
        }
        break;
      }

      // いま画面に出ている選択肢プロンプトを読む（タブを開いた直後などの明示取得）
      case 'get_choice_prompt': {
        const session = findSession(msg.sessionId);
        if (!session) break;
        // 待ち状態のときだけ画面を読む（入力欄に番号付きリストを書いている最中などを
        // プロンプトと誤認しないため。判定は ~/.claude/sessions の waitingFor に任せる）
        await refreshSessionStatus(session);
        const prompt = session.waitingFor ? await readChoicePrompt(session) : null;
        sendTo(ws, {
          type: 'choice_prompt',
          sessionId: session.id,
          waitingFor: session.waitingFor ?? null,
          prompt,
        });
        // 明示取得の結果も記録しておき、直後のポーリングで同じものを送らないようにする
        lastChoicePrompts.set(
          session.id,
          JSON.stringify({
            type: 'choice_prompt',
            sessionId: session.id,
            waitingFor: session.waitingFor ?? null,
            prompt,
          }),
        );
        break;
      }

      // 選択肢プロンプトへの回答。keys は数字キー（選択/トグル）や Enter / Tab / Escape。
      // text があれば「番号キー → テキスト → Enter」の順で送る（"Type something" 用）。
      case 'answer_choice_prompt': {
        const session = findSession(msg.sessionId);
        if (!session || typeof session.sendChoiceKeys !== 'function') {
          sendTo(ws, {
            type: 'choice_prompt_error',
            sessionId: msg.sessionId,
            message: 'このセッションには選択肢を送れません（閲覧専用です）。',
          });
          break;
        }
        try {
          const keys = Array.isArray(msg.keys) ? msg.keys : [];
          if (keys.length > 0) await session.sendChoiceKeys(keys);
          if (msg.text) {
            await session.sendChoiceText(msg.text);
            await session.sendChoiceKeys(['Enter']);
          }
        } catch (e) {
          console.error('answer_choice_prompt failed:', e.message);
          sendTo(ws, {
            type: 'choice_prompt_error',
            sessionId: msg.sessionId,
            message: `選択の送信に失敗しました: ${e.message}`,
          });
          break;
        }
        // 送信後は次の質問やレビュー画面に進んでいることがあるので読み直して配る
        await new Promise((r) => setTimeout(r, SCREEN_SETTLE_MS));
        await refreshSessionStatus(session);
        broadcastChoicePrompt(session, session.waitingFor ? await readChoicePrompt(session) : null);
        broadcastSessionList();
        break;
      }

      case 'kill_session': {
        jsonlWatcher.stopWatching(msg.sessionId);
        sessionManager.killSession(msg.sessionId);
        lastChoicePrompts.delete(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case 'restart_session': {
        const restarted = sessionManager.restartSession(msg.sessionId);
        if (restarted) {
          restarted.onOutput((data) => {
            broadcast({
              type: 'output',
              sessionId: restarted.id,
              data,
            });
          });
          restarted.onExit((code) => {
            broadcast({
              type: 'session_exited',
              sessionId: restarted.id,
              code,
            });
          });
        }
        broadcastSessionList();
        break;
      }

      case 'remove_past_session': {
        sessionManager.removePastSession(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case 'new_thread': {
        threadStore.createThread(msg.sessionId, {
          messageId: msg.messageId,
          selectedText: msg.selectedText,
        });
        broadcast({
          type: 'thread_update',
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case 'thread_reply_batch': {
        // replies: Array<{ threadId, text }>
        const replies = Array.isArray(msg.replies) ? msg.replies : [];
        const accepted = [];
        for (const r of replies) {
          const text = typeof r?.text === 'string' ? r.text.trim() : '';
          if (!text || !r?.threadId) continue;
          const added = threadStore.addReply(msg.sessionId, r.threadId, {
            role: 'human',
            text,
          });
          if (added) accepted.push({ threadId: r.threadId, text });
        }

        if (accepted.length > 0) {
          const session = findSession(msg.sessionId);
          if (session) {
            const allThreads = threadStore.getThreadsForSession(msg.sessionId);
            const sections = accepted.map(({ threadId, text }) => {
              const t = allThreads.find((x) => x.id === threadId);
              const head = t ? t.selectedText : '(不明)';
              return `## "${head}" への返信\n${text}`;
            });
            const prompt =
              accepted.length === 1
                ? `[スレッド: "${
                    allThreads.find((x) => x.id === accepted[0].threadId)?.selectedText ?? ''
                  }" への返信]\n${accepted[0].text}`
                : `[スレッド返信 ${accepted.length}件]\n\n${sections.join('\n\n')}`;
            session.write(prompt + '\r');
          }
        }

        broadcast({
          type: 'thread_update',
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case 'resolve_thread': {
        threadStore.resolveThread(msg.sessionId, msg.threadId);
        broadcast({
          type: 'thread_update',
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case 'delete_thread': {
        threadStore.deleteThread(msg.sessionId, msg.threadId);
        broadcast({
          type: 'thread_update',
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case 'get_threads': {
        ws.send(
          JSON.stringify({
            type: 'thread_update',
            sessionId: msg.sessionId,
            threads: threadStore.getThreadsForSession(msg.sessionId),
          }),
        );
        break;
      }

      case 'save_comment': {
        // コメントは「送信しない・後で参照するだけ」で、セッションに対して残す。
        // 保存キーは claudeSessionId を優先し（new/resume/tmux/readonly いずれの
        // 見え方でも安定する ID）、再オープンをまたいで参照できるようにする。
        // ファイル名に使うためトラバーサル対策で形式を検証する。
        const key = sessionKeyOf(msg);
        if (!key) break;
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) break;
        const comments = storage.loadComments(key);
        comments.push({
          id: `comment-${Date.now()}`,
          text,
          // どの箇所に対するコメントか（メッセージ/ファイル＋引用）。無ければセッション全体メモ。
          anchor: msg.anchor && typeof msg.anchor === 'object' ? msg.anchor : null,
          timestamp: new Date().toISOString(),
        });
        storage.saveComments(key, comments);
        ws.send(
          JSON.stringify({
            type: 'comments_update',
            // active 照合はブリッジ ID で行うため echo は従来どおり sessionId
            sessionId: msg.sessionId,
            comments,
          }),
        );
        break;
      }

      case 'get_comments': {
        const key = sessionKeyOf(msg);
        ws.send(
          JSON.stringify({
            type: 'comments_update',
            sessionId: msg.sessionId,
            comments: key ? storage.loadComments(key) : [],
          }),
        );
        break;
      }

      case 'delete_comment': {
        const key = sessionKeyOf(msg);
        if (!key) break;
        const comments = storage.loadComments(key).filter((c) => c.id !== msg.commentId);
        storage.saveComments(key, comments);
        ws.send(
          JSON.stringify({
            type: 'comments_update',
            sessionId: msg.sessionId,
            comments,
          }),
        );
        break;
      }

      // --- レビュー（セッション横断の pending review → Submit で一括送信）---
      case 'get_review': {
        const key = sessionKeyOf(msg);
        ws.send(
          JSON.stringify({
            type: 'review_update',
            sessionId: msg.sessionId,
            items: key ? storage.loadReviewDraft(key).items : [],
          }),
        );
        break;
      }

      case 'save_review': {
        // 送信前の下書きを保存（追加/編集/削除のたびに items 全体で上書き）。
        const key = sessionKeyOf(msg);
        if (!key) break;
        const items = (Array.isArray(msg.items) ? msg.items : []).map((it) => ({
          id: it?.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text: typeof it?.text === 'string' ? it.text : '',
          // レビュー項目が指す対象（引用＋位置）。無ければ位置なしの指摘。
          anchor: it?.anchor && typeof it.anchor === 'object' ? it.anchor : null,
        }));
        storage.saveReviewDraft(key, { items, updatedAt: new Date().toISOString() });
        ws.send(JSON.stringify({ type: 'review_update', sessionId: msg.sessionId, items }));
        break;
      }

      case 'submit_review': {
        // pending review を一括送信。送信先はサーバーが対象セッション種別で出し分ける:
        // readonly → inbox（agent 側フックが取り込む） / それ以外（PTY あり）→ session.write。
        const key = sessionKeyOf(msg);
        if (!key) {
          ws.send(JSON.stringify({ type: 'submit_review_result', ok: false }));
          break;
        }
        // 各項目を「対象（引用）について: 指摘本文」に整形する。anchor があれば引用を前置。
        const items = (Array.isArray(msg.items) ? msg.items : [])
          .map((it) => {
            const note = typeof it?.text === 'string' ? it.text.trim() : '';
            if (!note) return null;
            const quote = it?.anchor?.quote ? String(it.anchor.quote).trim() : '';
            return quote ? `「${quote}」について:\n${note}` : note;
          })
          .filter(Boolean);
        if (items.length === 0) {
          ws.send(JSON.stringify({ type: 'submit_review_result', ok: false }));
          break;
        }
        const body =
          items.length === 1
            ? `[レビュー] ${items[0]}`
            : `[レビュー ${items.length}件]\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;

        const session = findSession(msg.sessionId);
        let ok = false;
        try {
          if (session?.type === 'readonly') {
            // readonly は PTY を持たないため inbox 経由（宛先は claudeSessionId）
            storage.appendInbox(session.claudeSessionId || key, { text: body });
            ok = true;
          } else if (session) {
            session.write(body + '\r');
            ok = true;
          }
        } catch (e) {
          console.error('submit_review failed:', e.message);
        }

        if (ok) {
          // 送信できたら下書きをクリアして同期
          storage.saveReviewDraft(key, { items: [], updatedAt: new Date().toISOString() });
          ws.send(JSON.stringify({ type: 'review_update', sessionId: msg.sessionId, items: [] }));
        }
        ws.send(
          JSON.stringify({
            type: 'submit_review_result',
            ok,
            via: session?.type === 'readonly' ? 'inbox' : 'pty',
            count: items.length,
          }),
        );
        break;
      }

      case 'list_claude_sessions': {
        listClaudeSessions({ limit: msg.limit || 30 }).then((claudeSessions) => {
          ws.send(
            JSON.stringify({
              type: 'claude_sessions',
              sessions: claudeSessions,
            }),
          );
        });
        break;
      }

      case 'load_session_history': {
        loadSessionHistory(msg.claudeSessionId, msg.projectDir).then((history) => {
          ws.send(
            JSON.stringify({
              type: 'session_history',
              // どのタブ宛の履歴かをクライアントが判別できるよう bridge 側 ID も返す
              bridgeSessionId: msg.sessionId,
              claudeSessionId: msg.claudeSessionId,
              messages: history,
            }),
          );
        });
        break;
      }

      case 'resume_session': {
        const resumeCwd = msg.cwd || process.env.HOME;
        const session = sessionManager.createSessionWithArgs({
          name: msg.name || `Resume: ${msg.claudeSessionId.slice(0, 8)}`,
          cwd: resumeCwd,
          args: ['--resume', msg.claudeSessionId],
        });

        session.onOutput((data) => {
          broadcast({
            type: 'output',
            sessionId: session.id,
            data,
          });
        });

        session.onExit((code) => {
          jsonlWatcher.stopWatching(session.id);
          broadcast({
            type: 'session_exited',
            sessionId: session.id,
            code,
          });
        });

        // JSONL 監視開始（resume なのでセッション ID 既知）
        jsonlWatcher.startWatching({
          bridgeSessionId: session.id,
          cwd: resumeCwd,
          resumeSessionId: msg.claudeSessionId,
          onMessage: (chatMsg) => broadcast(chatMsg),
        });

        ws.send(JSON.stringify({ type: 'session_opened', bridgeSessionId: session.id }));
        broadcastSessionList();
        break;
      }

      case 'get_buffer': {
        const session = findSession(msg.sessionId);
        if (session) {
          Promise.resolve(session.getOutputBuffer()).then((data) => {
            ws.send(
              JSON.stringify({
                type: 'output_buffer',
                sessionId: msg.sessionId,
                data,
              }),
            );
          });
        }
        break;
      }

      case 'list_tmux_panes': {
        listClaudeTmuxPanes()
          .then((panes) => enrichPanesWithSessionMeta(panes))
          .then((panes) => {
            ws.send(
              JSON.stringify({
                type: 'tmux_panes',
                panes,
              }),
            );
          });
        break;
      }

      case 'list_running_sessions': {
        // ホーム画面用: 今マシン上で起動している Claude セッション一覧
        // （~/.claude/sessions/*.json ＋ 生存 PID）。ブリッジのタブとは独立した情報で、
        // どれがタブとして開かれているかの突合はクライアント側で行う。
        listRunningSessions().then((running) => {
          ws.send(JSON.stringify({ type: 'running_sessions', sessions: running }));
        });
        break;
      }

      case 'list_recent_sessions': {
        // ホーム画面用: 直近 days 日に更新された Claude セッション（終了済みも含む）。
        // 起動中セッションとの重複除去はクライアント側で行う。
        const days = clampDays(msg.days);
        const starred = sanitizeSessionIds(msg.starred);
        listRecentSessions({ days, limit: recentSessionLimit(days), includeSessionIds: starred })
          .then((recent) => {
            ws.send(JSON.stringify({ type: 'recent_sessions', days, sessions: recent }));
          })
          .catch((err) => {
            ws.send(
              JSON.stringify({ type: 'home_error', message: `直近セッションの取得に失敗しました: ${err.message}` }),
            );
          });
        break;
      }

      case 'list_activity_heatmap': {
        // ホーム画面の草。初回は JSONL を全走査するので数秒かかるが、
        // 以降はファイル単位キャッシュの差分だけ読む（activity-heatmap.js）。
        getActivityHeatmap({ days: clampHeatmapDays(msg.days) })
          .then((heatmap) => {
            ws.send(JSON.stringify({ type: 'activity_heatmap', ...heatmap }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: 'home_error', message: `活動量の集計に失敗しました: ${err.message}` }));
          });
        break;
      }

      case 'list_agents': {
        listClaudeAgents().then((agents) => {
          ws.send(JSON.stringify({ type: 'agents', agents }));
        });
        break;
      }

      case 'attach_tmux_pane': {
        attachTmuxPaneAsSession(ws, {
          paneId: msg.paneId,
          name: msg.name,
          cwd: msg.cwd,
          target: msg.target,
          claudePid: msg.claudePid,
          claudeSessionId: msg.claudeSessionId,
          status: msg.status,
          waitingFor: msg.waitingFor,
        });
        break;
      }

      case 'resume_in_tmux': {
        // 起動していないセッションを tmux 側で起こす。PTY 直起動（resume_session）と違い
        // ブリッジを落としても生き残り、ターミナルからも操作できる。
        resumeInTmuxWindow({
          claudeSessionId: msg.claudeSessionId,
          cwd: msg.cwd,
        })
          .then((pane) => {
            attachTmuxPaneAsSession(ws, {
              paneId: pane.paneId,
              name: msg.name || pane.windowName,
              cwd: msg.cwd,
              target: pane.target,
              // claude はシェル経由で起動するので pid はまだ分からない。
              // 起動中一覧のポーリングで拾えるので null のままにする。
              claudePid: null,
              claudeSessionId: msg.claudeSessionId,
              status: null,
            });
          })
          .catch((e) => {
            console.error('resume_in_tmux failed:', e.message);
            sendTo(ws, {
              type: 'home_error',
              message: `tmux で再開できませんでした: ${e.message}`,
            });
          });
        break;
      }

      case 'detach_tmux_pane': {
        jsonlWatcher.stopWatching(msg.sessionId);
        tmuxSessionManager.detachSession(msg.sessionId);
        lastChoicePrompts.delete(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case 'open_readonly_session': {
        // claude プロセスを起動せず、既存セッションの JSONL を読むだけのビュー
        // projectDir 未指定（agent 一覧由来など）なら cwd から導出する
        const roProjectDir = msg.projectDir || cwdToProjectDir(msg.cwd || '');
        const session = readonlySessionManager.create({
          name: msg.name || `閲覧: ${(msg.claudeSessionId || '').slice(0, 8)}`,
          cwd: msg.cwd,
          claudeSessionId: msg.claudeSessionId,
          projectDir: roProjectDir,
        });

        // 履歴を読み込んで送る（プロセスは起動しない）
        loadSessionHistory(msg.claudeSessionId, roProjectDir)
          .then((history) => {
            ws.send(
              JSON.stringify({
                type: 'session_history',
                bridgeSessionId: session.id,
                messages: history,
              }),
            );
          })
          .catch((e) => {
            console.error('readonly history load failed:', e.message);
          });

        // 既存 JSONL の新着のみ監視（attachExisting）。プロセス起動はしない
        jsonlWatcher.startWatching({
          bridgeSessionId: session.id,
          cwd: msg.cwd,
          resumeSessionId: msg.claudeSessionId,
          attachExisting: true,
          onMessage: (chatMsg) => broadcast(chatMsg),
        });

        ws.send(JSON.stringify({ type: 'session_opened', bridgeSessionId: session.id }));
        broadcastSessionList();
        break;
      }

      case 'close_readonly_session': {
        jsonlWatcher.stopWatching(msg.sessionId);
        readonlySessionManager.remove(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case 'send_to_agent': {
        // フックベース送信: 対象セッションの inbox に書くだけ（agent 側フックが取り込む）
        const items = (Array.isArray(msg.comments) ? msg.comments : [])
          .map((c) => (typeof c === 'string' ? c.trim() : ''))
          .filter(Boolean);
        if (!msg.claudeSessionId || items.length === 0) {
          ws.send(JSON.stringify({ type: 'send_to_agent_result', ok: false }));
          break;
        }
        const text = items.length === 1 ? items[0] : items.map((t, i) => `[コメント${i + 1}] ${t}`).join('\n');
        try {
          storage.appendInbox(msg.claudeSessionId, { text });
          ws.send(JSON.stringify({ type: 'send_to_agent_result', ok: true }));
        } catch (e) {
          console.error('send_to_agent failed:', e.message);
          ws.send(
            JSON.stringify({
              type: 'send_to_agent_result',
              ok: false,
              error: e.message,
            }),
          );
        }
        break;
      }

      // セッションが起動したサブエージェント（Agent ツール）の一覧。
      // 情報源は <projectDir>/<claudeSessionId>/subagents/ なので readonly でも動く。
      case 'list_subagent_tasks': {
        try {
          const target = resolveClaudeTarget(findSession(msg.sessionId));
          const tasks = target ? await listSubagentTasks(target) : [];
          sendTo(ws, { type: 'subagent_tasks', sessionId: msg.sessionId, tasks });
        } catch (e) {
          console.error('list_subagent_tasks failed:', e.message);
          sendTo(ws, { type: 'subagent_tasks', sessionId: msg.sessionId, tasks: [] });
        }
        break;
      }

      case 'get_subagent_transcript': {
        try {
          const target = resolveClaudeTarget(findSession(msg.sessionId));
          const messages = target ? await readSubagentTranscript({ ...target, agentId: msg.agentId }) : null;
          if (!messages) {
            sendTo(ws, {
              type: 'subagent_transcript',
              sessionId: msg.sessionId,
              agentId: msg.agentId,
              status: null,
              messages: [],
              error: 'サブエージェントの会話を読み込めませんでした。',
            });
            break;
          }
          const tasks = await listSubagentTasks(target);
          sendTo(ws, {
            type: 'subagent_transcript',
            sessionId: msg.sessionId,
            agentId: msg.agentId,
            status: tasks.find((t) => t.agentId === msg.agentId)?.status ?? null,
            messages,
          });
        } catch (e) {
          console.error('get_subagent_transcript failed:', e.message);
          sendTo(ws, {
            type: 'subagent_transcript',
            sessionId: msg.sessionId,
            agentId: msg.agentId,
            status: null,
            messages: [],
            error: `サブエージェントの会話を読み込めませんでした: ${e.message}`,
          });
        }
        break;
      }

      // 実行中／終了済みの Bash 出力の一覧。情報源は tmp 配下の tasks/*.output なので
      // subagent と同じく readonly でも動く。
      case 'list_shell_tasks': {
        try {
          const target = resolveClaudeTarget(findSession(msg.sessionId));
          const tasks = target ? await listShellTasks(target) : [];
          sendTo(ws, { type: 'shell_tasks', sessionId: msg.sessionId, tasks });
        } catch (e) {
          console.error('list_shell_tasks failed:', e.message);
          sendTo(ws, { type: 'shell_tasks', sessionId: msg.sessionId, tasks: [] });
        }
        break;
      }

      case 'get_shell_task_output': {
        try {
          const target = resolveClaudeTarget(findSession(msg.sessionId));
          const output = target ? await readShellTaskOutput({ ...target, taskId: msg.taskId }) : null;
          if (!output) {
            sendTo(ws, {
              type: 'shell_task_output',
              sessionId: msg.sessionId,
              taskId: msg.taskId,
              status: null,
              exitCode: null,
              text: '',
              truncated: false,
              size: 0,
              error: 'シェル出力を読み込めませんでした。',
            });
            break;
          }
          sendTo(ws, {
            type: 'shell_task_output',
            sessionId: msg.sessionId,
            taskId: output.taskId,
            status: output.status,
            exitCode: output.exitCode,
            text: output.text,
            truncated: output.truncated,
            size: output.size,
          });
        } catch (e) {
          console.error('get_shell_task_output failed:', e.message);
          sendTo(ws, {
            type: 'shell_task_output',
            sessionId: msg.sessionId,
            taskId: msg.taskId,
            status: null,
            exitCode: null,
            text: '',
            truncated: false,
            size: 0,
            error: `シェル出力を読み込めませんでした: ${e.message}`,
          });
        }
        break;
      }

      // 入力欄のスラッシュコマンド補完の候補。cwd はクライアントからは受け取らず、
      // セッションが持っているものだけを使う（任意パスを走査させないため）。
      // セッションが見つからなくてもユーザー側（~/.claude）の候補は返す。
      case 'list_slash_commands': {
        try {
          const session = findSession(msg.sessionId);
          const commands = await listSlashCommands({ cwd: session?.cwd });
          sendTo(ws, { type: 'slash_commands', sessionId: msg.sessionId, commands });
        } catch (e) {
          console.error('list_slash_commands failed:', e.message);
          sendTo(ws, { type: 'slash_commands', sessionId: msg.sessionId, commands: [] });
        }
        break;
      }

      case 'switch_session':
        break;
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Claude Bridge server listening on http://localhost:${PORT}`);
});
