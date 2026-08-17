import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync, statSync, lstatSync, readdirSync } from "fs";
import { extname, join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { SessionManager, ReadonlySessionManager } from "./session.js";
import { Storage } from "./storage.js";
import { ThreadStore } from "./thread-store.js";
import {
  listClaudeSessions,
  listRecentSessions,
  loadSessionHistory,
} from "./claude-sessions.js";
import { JsonlWatcher } from "./jsonl-watcher.js";
import { cwdToProjectDir } from "./jsonl-utils.js";
import {
  listClaudeTmuxPanes,
  resolveTmuxJsonlTarget,
  TmuxSessionManager,
} from "./tmux-session.js";
import { listClaudeAgents } from "./claude-agents.js";
import { enrichPanesWithSessionMeta } from "./claude-session-meta.js";
import { listRunningSessions } from "./running-sessions.js";

const PORT = process.env.PORT || 3000;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ローカルファイルプレビュー用エンドポイント
// /preview?path=/home/user/file.html
const MIME_MAP = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".sql": "text/plain; charset=utf-8",
  ".sqlx": "text/plain; charset=utf-8",
};

// パスのサンドボックスチェック（home/tmp 配下のみ許可）
function validateSafePath(filePath) {
  if (!filePath) return { status: 400, error: "path parameter required" };

  // セキュリティ: パス正規化でトラバーサル攻撃を防止
  const canonical = resolve(filePath);
  const home = resolve(process.env.HOME || "/home");
  const tmp = resolve("/tmp");
  if (!canonical.startsWith(home + "/") && canonical !== home &&
      !canonical.startsWith(tmp + "/") && canonical !== tmp) {
    return { status: 403, error: "Access denied: path must be under home or /tmp" };
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
      return { status: 403, error: "Access denied: symlinks not allowed" };
    }
    if (!lstat.isFile()) {
      return { status: 400, error: "Not a file" };
    }
    // 100MB 上限
    if (lstat.size > 100 * 1024 * 1024) {
      return { status: 413, error: "File too large" };
    }
    return { status: 200, canonical: safe.canonical, lstat };
  } catch {
    return { status: 404, error: "File not found" };
  }
}

// ファイラで常に除外するディレクトリ名
const EXCLUDED_DIRS = new Set(["node_modules"]);

app.get("/preview", (req, res) => {
  const result = validatePreviewPath(req.query.path);
  if (result.error) {
    return res.status(result.status).send(result.error);
  }

  const ext = extname(result.canonical).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.sendFile(result.canonical);
});

// ファイル存在確認 (プレビューボタンを出すべきかの判定用)
// プレビュー可能条件 (homeもしくは/tmp配下の実ファイル, 100MB以下, 非シンボリックリンク) を満たす場合のみ ok
app.get("/file-exists", (req, res) => {
  const result = validatePreviewPath(req.query.path);
  res.setHeader("Cache-Control", "no-cache");
  res.json({ exists: result.status === 200 });
});

// ファイラ用ディレクトリ一覧
// /ls?path=/home/user/project
// 隠しファイル・node_modules 等は除外する
app.get("/ls", (req, res) => {
  const safe = validateSafePath(req.query.path);
  if (safe.error) {
    return res.status(safe.status).send(safe.error);
  }

  try {
    const lstat = lstatSync(safe.canonical);
    if (lstat.isSymbolicLink()) {
      return res.status(403).send("Access denied: symlinks not allowed");
    }
    if (!lstat.isDirectory()) {
      return res.status(400).send("Not a directory");
    }
  } catch {
    return res.status(404).send("Directory not found");
  }

  let dirents;
  try {
    dirents = readdirSync(safe.canonical, { withFileTypes: true });
  } catch (err) {
    return res.status(500).send(`Failed to read directory: ${err.code || err.message}`);
  }

  const entries = dirents
    // 隠しファイル・除外ディレクトリは表示しない
    .filter((e) => !e.name.startsWith(".") && !EXCLUDED_DIRS.has(e.name))
    // シンボリックリンク・特殊ファイルは除外（プレビュー方針と揃える）
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }))
    // ディレクトリを先頭にしてアルファベット順
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  res.setHeader("Cache-Control", "no-cache");
  res.json({ path: safe.canonical, entries });
});

// ファイラ用の再帰ファイル名検索
// /search?path=<dir>&q=<term>
// cwd 配下を walk し、ファイル名に q を含むものを返す。隠し/node_modules は除外、
// シンボリックリンクは辿らない。暴走防止に件数・訪問数の上限を設ける。
app.get("/search", (req, res) => {
  const safe = validateSafePath(req.query.path);
  if (safe.error) {
    return res.status(safe.status).send(safe.error);
  }
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) {
    return res.json({ matches: [], truncated: false });
  }

  try {
    const st = lstatSync(safe.canonical);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return res.status(400).send("Not a directory");
    }
  } catch {
    return res.status(404).send("Directory not found");
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
      if (e.name.startsWith(".") || EXCLUDED_DIRS.has(e.name)) continue;
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
  res.setHeader("Cache-Control", "no-cache");
  res.json({ matches, truncated: matches.length >= MAX_MATCHES });
});

// クライアントのビルド成果物を配信
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "..", "client", "dist");
// HTML はキャッシュ禁止、JS/CSS はハッシュ付きなので長期キャッシュOK
app.use(express.static(clientDist, {
  setHeaders: (res, path) => {
    if (path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));
// SPA フォールバック
app.get("*", (req, res) => {
  const indexPath = join(clientDist, "index.html");
  if (existsSync(indexPath)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Client not built. Run: cd client && npm run build");
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
  return ids
    .filter((id) => typeof id === "string" && /^[\w-]+$/.test(id))
    .slice(0, 200);
}

// ホーム画面の「直近のセッション」の期間。クライアント指定を 1〜365 日に丸める
function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return 7;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

function findSession(id) {
  return (
    sessionManager.getSession(id) ||
    tmuxSessionManager.getSession(id) ||
    readonlySessionManager.getSession(id)
  );
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
  broadcast({ type: "session_list", sessions: allSessions() });
}

// コメント/レビューの保存キーを解決する。claudeSessionId を優先し、無ければ
// ブリッジ sessionId にフォールバック。ファイル名に使うため形式を検証して不正なら null。
// クライアントは sessionKey（旧 commentKey）で渡す。
function sessionKeyOf(msg) {
  const key = msg.sessionKey || msg.commentKey || msg.sessionId || "";
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

wss.on("close", () => clearInterval(pingInterval));

// tmux セッションの busy/idle を定期的に最新化し、変化があればタブへ反映
const STATUS_INTERVAL = 4_000;
const statusInterval = setInterval(async () => {
  const changed = await tmuxSessionManager.refreshStatuses();
  if (changed) broadcastSessionList();
}, STATUS_INTERVAL);
wss.on("close", () => clearInterval(statusInterval));

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.send(
    JSON.stringify({
      type: "session_list",
      sessions: allSessions(),
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "new_session": {
        const sessionCwd = msg.cwd || process.env.HOME;
        const session = sessionManager.createSession({
          name: msg.name || "New Session",
          cwd: sessionCwd,
        });

        session.onOutput((data) => {
          broadcast({
            type: "output",
            sessionId: session.id,
            data,
          });
        });

        session.onExit((code) => {
          jsonlWatcher.stopWatching(session.id);
          broadcast({
            type: "session_exited",
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

        ws.send(
          JSON.stringify({ type: "session_opened", bridgeSessionId: session.id })
        );
        broadcastSessionList();
        break;
      }

      case "input": {
        const session = findSession(msg.sessionId);
        if (session) {
          session.write(msg.text);
        } else {
          console.warn(`input: session ${msg.sessionId} not found or dead`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "セッションが見つかりません。新しいセッションを作成してください。",
              sessionId: msg.sessionId,
            })
          );
        }
        break;
      }

      case "resize": {
        const session = findSession(msg.sessionId);
        if (session) {
          session.resize(msg.cols, msg.rows);
        }
        break;
      }

      case "kill_session": {
        jsonlWatcher.stopWatching(msg.sessionId);
        sessionManager.killSession(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case "restart_session": {
        const restarted = sessionManager.restartSession(msg.sessionId);
        if (restarted) {
          restarted.onOutput((data) => {
            broadcast({
              type: "output",
              sessionId: restarted.id,
              data,
            });
          });
          restarted.onExit((code) => {
            broadcast({
              type: "session_exited",
              sessionId: restarted.id,
              code,
            });
          });
        }
        broadcastSessionList();
        break;
      }

      case "remove_past_session": {
        sessionManager.removePastSession(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case "new_thread": {
        const thread = threadStore.createThread(msg.sessionId, {
          messageId: msg.messageId,
          selectedText: msg.selectedText,
        });
        broadcast({
          type: "thread_update",
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case "thread_reply_batch": {
        // replies: Array<{ threadId, text }>
        const replies = Array.isArray(msg.replies) ? msg.replies : [];
        const accepted = [];
        for (const r of replies) {
          const text = typeof r?.text === "string" ? r.text.trim() : "";
          if (!text || !r?.threadId) continue;
          const added = threadStore.addReply(msg.sessionId, r.threadId, {
            role: "human",
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
              const head = t ? t.selectedText : "(不明)";
              return `## "${head}" への返信\n${text}`;
            });
            const prompt =
              accepted.length === 1
                ? `[スレッド: "${
                    allThreads.find((x) => x.id === accepted[0].threadId)
                      ?.selectedText ?? ""
                  }" への返信]\n${accepted[0].text}`
                : `[スレッド返信 ${accepted.length}件]\n\n${sections.join("\n\n")}`;
            session.write(prompt + "\r");
          }
        }

        broadcast({
          type: "thread_update",
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case "resolve_thread": {
        threadStore.resolveThread(msg.sessionId, msg.threadId);
        broadcast({
          type: "thread_update",
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case "delete_thread": {
        threadStore.deleteThread(msg.sessionId, msg.threadId);
        broadcast({
          type: "thread_update",
          sessionId: msg.sessionId,
          threads: threadStore.getThreadsForSession(msg.sessionId),
        });
        break;
      }

      case "get_threads": {
        ws.send(
          JSON.stringify({
            type: "thread_update",
            sessionId: msg.sessionId,
            threads: threadStore.getThreadsForSession(msg.sessionId),
          })
        );
        break;
      }

      case "save_comment": {
        // コメントは「送信しない・後で参照するだけ」で、セッションに対して残す。
        // 保存キーは claudeSessionId を優先し（new/resume/tmux/readonly いずれの
        // 見え方でも安定する ID）、再オープンをまたいで参照できるようにする。
        // ファイル名に使うためトラバーサル対策で形式を検証する。
        const key = sessionKeyOf(msg);
        if (!key) break;
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) break;
        const comments = storage.loadComments(key);
        comments.push({
          id: `comment-${Date.now()}`,
          text,
          // どの箇所に対するコメントか（メッセージ/ファイル＋引用）。無ければセッション全体メモ。
          anchor: msg.anchor && typeof msg.anchor === "object" ? msg.anchor : null,
          timestamp: new Date().toISOString(),
        });
        storage.saveComments(key, comments);
        ws.send(
          JSON.stringify({
            type: "comments_update",
            // active 照合はブリッジ ID で行うため echo は従来どおり sessionId
            sessionId: msg.sessionId,
            comments,
          })
        );
        break;
      }

      case "get_comments": {
        const key = sessionKeyOf(msg);
        ws.send(
          JSON.stringify({
            type: "comments_update",
            sessionId: msg.sessionId,
            comments: key ? storage.loadComments(key) : [],
          })
        );
        break;
      }

      case "delete_comment": {
        const key = sessionKeyOf(msg);
        if (!key) break;
        const comments = storage
          .loadComments(key)
          .filter((c) => c.id !== msg.commentId);
        storage.saveComments(key, comments);
        ws.send(
          JSON.stringify({
            type: "comments_update",
            sessionId: msg.sessionId,
            comments,
          })
        );
        break;
      }

      // --- レビュー（セッション横断の pending review → Submit で一括送信）---
      case "get_review": {
        const key = sessionKeyOf(msg);
        ws.send(
          JSON.stringify({
            type: "review_update",
            sessionId: msg.sessionId,
            items: key ? storage.loadReviewDraft(key).items : [],
          })
        );
        break;
      }

      case "save_review": {
        // 送信前の下書きを保存（追加/編集/削除のたびに items 全体で上書き）。
        const key = sessionKeyOf(msg);
        if (!key) break;
        const items = (Array.isArray(msg.items) ? msg.items : [])
          .map((it) => ({
            id: it?.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text: typeof it?.text === "string" ? it.text : "",
            // レビュー項目が指す対象（引用＋位置）。無ければ位置なしの指摘。
            anchor: it?.anchor && typeof it.anchor === "object" ? it.anchor : null,
          }));
        storage.saveReviewDraft(key, { items, updatedAt: new Date().toISOString() });
        ws.send(
          JSON.stringify({ type: "review_update", sessionId: msg.sessionId, items })
        );
        break;
      }

      case "submit_review": {
        // pending review を一括送信。送信先はサーバーが対象セッション種別で出し分ける:
        // readonly → inbox（agent 側フックが取り込む） / それ以外（PTY あり）→ session.write。
        const key = sessionKeyOf(msg);
        if (!key) {
          ws.send(JSON.stringify({ type: "submit_review_result", ok: false }));
          break;
        }
        // 各項目を「対象（引用）について: 指摘本文」に整形する。anchor があれば引用を前置。
        const items = (Array.isArray(msg.items) ? msg.items : [])
          .map((it) => {
            const note = typeof it?.text === "string" ? it.text.trim() : "";
            if (!note) return null;
            const quote = it?.anchor?.quote ? String(it.anchor.quote).trim() : "";
            return quote ? `「${quote}」について:\n${note}` : note;
          })
          .filter(Boolean);
        if (items.length === 0) {
          ws.send(JSON.stringify({ type: "submit_review_result", ok: false }));
          break;
        }
        const body =
          items.length === 1
            ? `[レビュー] ${items[0]}`
            : `[レビュー ${items.length}件]\n${items
                .map((t, i) => `${i + 1}. ${t}`)
                .join("\n")}`;

        const session = findSession(msg.sessionId);
        let ok = false;
        try {
          if (session?.type === "readonly") {
            // readonly は PTY を持たないため inbox 経由（宛先は claudeSessionId）
            storage.appendInbox(session.claudeSessionId || key, { text: body });
            ok = true;
          } else if (session) {
            session.write(body + "\r");
            ok = true;
          }
        } catch (e) {
          console.error("submit_review failed:", e.message);
        }

        if (ok) {
          // 送信できたら下書きをクリアして同期
          storage.saveReviewDraft(key, { items: [], updatedAt: new Date().toISOString() });
          ws.send(
            JSON.stringify({ type: "review_update", sessionId: msg.sessionId, items: [] })
          );
        }
        ws.send(
          JSON.stringify({
            type: "submit_review_result",
            ok,
            via: session?.type === "readonly" ? "inbox" : "pty",
            count: items.length,
          })
        );
        break;
      }

      case "list_claude_sessions": {
        listClaudeSessions({ limit: msg.limit || 30 }).then((claudeSessions) => {
          ws.send(
            JSON.stringify({
              type: "claude_sessions",
              sessions: claudeSessions,
            })
          );
        });
        break;
      }

      case "load_session_history": {
        loadSessionHistory(msg.claudeSessionId, msg.projectDir).then(
          (history) => {
            ws.send(
              JSON.stringify({
                type: "session_history",
                // どのタブ宛の履歴かをクライアントが判別できるよう bridge 側 ID も返す
                bridgeSessionId: msg.sessionId,
                claudeSessionId: msg.claudeSessionId,
                messages: history,
              })
            );
          }
        );
        break;
      }

      case "resume_session": {
        const resumeCwd = msg.cwd || process.env.HOME;
        const session = sessionManager.createSessionWithArgs({
          name: msg.name || `Resume: ${msg.claudeSessionId.slice(0, 8)}`,
          cwd: resumeCwd,
          args: ["--resume", msg.claudeSessionId],
        });

        session.onOutput((data) => {
          broadcast({
            type: "output",
            sessionId: session.id,
            data,
          });
        });

        session.onExit((code) => {
          jsonlWatcher.stopWatching(session.id);
          broadcast({
            type: "session_exited",
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

        ws.send(
          JSON.stringify({ type: "session_opened", bridgeSessionId: session.id })
        );
        broadcastSessionList();
        break;
      }

      case "get_buffer": {
        const session = findSession(msg.sessionId);
        if (session) {
          Promise.resolve(session.getOutputBuffer()).then((data) => {
            ws.send(
              JSON.stringify({
                type: "output_buffer",
                sessionId: msg.sessionId,
                data,
              })
            );
          });
        }
        break;
      }

      case "list_tmux_panes": {
        listClaudeTmuxPanes()
          .then((panes) => enrichPanesWithSessionMeta(panes))
          .then((panes) => {
            ws.send(
              JSON.stringify({
                type: "tmux_panes",
                panes,
              })
            );
          });
        break;
      }

      case "list_running_sessions": {
        // ホーム画面用: 今マシン上で起動している Claude セッション一覧
        // （~/.claude/sessions/*.json ＋ 生存 PID）。ブリッジのタブとは独立した情報で、
        // どれがタブとして開かれているかの突合はクライアント側で行う。
        listRunningSessions().then((running) => {
          ws.send(JSON.stringify({ type: "running_sessions", sessions: running }));
        });
        break;
      }

      case "list_recent_sessions": {
        // ホーム画面用: 直近 days 日に更新された Claude セッション（終了済みも含む）。
        // 起動中セッションとの重複除去はクライアント側で行う。
        const days = clampDays(msg.days);
        const starred = sanitizeSessionIds(msg.starred);
        listRecentSessions({ days, limit: 50, includeSessionIds: starred }).then((recent) => {
          ws.send(
            JSON.stringify({ type: "recent_sessions", days, sessions: recent })
          );
        });
        break;
      }

      case "list_agents": {
        listClaudeAgents().then((agents) => {
          ws.send(JSON.stringify({ type: "agents", agents }));
        });
        break;
      }

      case "attach_tmux_pane": {
        const session = tmuxSessionManager.attachPane({
          paneId: msg.paneId,
          name: msg.name || `tmux: ${msg.target}`,
          cwd: msg.cwd,
          target: msg.target,
          claudePid: msg.claudePid,
          status: msg.status,
        });

        // ペインごとに解決済みの sessionId がある場合だけ JSONL に紐づける。
        // cwd の最新 JSONL 推定は、複数 tmux セッション/同一 cwd で取り違えるため使わない。
        const resolved = resolveTmuxJsonlTarget({
          claudeSessionId: msg.claudeSessionId,
          cwd: msg.cwd,
        });
        if (resolved) {
          loadSessionHistory(resolved.sessionId, resolved.projectDir).then(
            (history) => {
              ws.send(
                JSON.stringify({
                  type: "session_history",
                  bridgeSessionId: session.id,
                  messages: history,
                })
              );
            }
          );

          // JSONL 監視開始（新規メッセージのみ配信）
          jsonlWatcher.startWatching({
            bridgeSessionId: session.id,
            cwd: msg.cwd,
            sessionId: resolved.sessionId,
            attachExisting: true,
            onMessage: (chatMsg) => broadcast(chatMsg),
          });
        }

        ws.send(
          JSON.stringify({ type: "session_opened", bridgeSessionId: session.id })
        );
        broadcastSessionList();
        break;
      }

      case "detach_tmux_pane": {
        jsonlWatcher.stopWatching(msg.sessionId);
        tmuxSessionManager.detachSession(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case "open_readonly_session": {
        // claude プロセスを起動せず、既存セッションの JSONL を読むだけのビュー
        // projectDir 未指定（agent 一覧由来など）なら cwd から導出する
        const roProjectDir = msg.projectDir || cwdToProjectDir(msg.cwd || "");
        const session = readonlySessionManager.create({
          name: msg.name || `閲覧: ${(msg.claudeSessionId || "").slice(0, 8)}`,
          cwd: msg.cwd,
          claudeSessionId: msg.claudeSessionId,
          projectDir: roProjectDir,
        });

        // 履歴を読み込んで送る（プロセスは起動しない）
        loadSessionHistory(msg.claudeSessionId, roProjectDir)
          .then((history) => {
            ws.send(
              JSON.stringify({
                type: "session_history",
                bridgeSessionId: session.id,
                messages: history,
              })
            );
          })
          .catch((e) => {
            console.error("readonly history load failed:", e.message);
          });

        // 既存 JSONL の新着のみ監視（attachExisting）。プロセス起動はしない
        jsonlWatcher.startWatching({
          bridgeSessionId: session.id,
          cwd: msg.cwd,
          resumeSessionId: msg.claudeSessionId,
          attachExisting: true,
          onMessage: (chatMsg) => broadcast(chatMsg),
        });

        ws.send(
          JSON.stringify({ type: "session_opened", bridgeSessionId: session.id })
        );
        broadcastSessionList();
        break;
      }

      case "close_readonly_session": {
        jsonlWatcher.stopWatching(msg.sessionId);
        readonlySessionManager.remove(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case "send_to_agent": {
        // フックベース送信: 対象セッションの inbox に書くだけ（agent 側フックが取り込む）
        const items = (Array.isArray(msg.comments) ? msg.comments : [])
          .map((c) => (typeof c === "string" ? c.trim() : ""))
          .filter(Boolean);
        if (!msg.claudeSessionId || items.length === 0) {
          ws.send(JSON.stringify({ type: "send_to_agent_result", ok: false }));
          break;
        }
        const text =
          items.length === 1
            ? items[0]
            : items.map((t, i) => `[コメント${i + 1}] ${t}`).join("\n");
        try {
          storage.appendInbox(msg.claudeSessionId, { text });
          ws.send(JSON.stringify({ type: "send_to_agent_result", ok: true }));
        } catch (e) {
          console.error("send_to_agent failed:", e.message);
          ws.send(
            JSON.stringify({
              type: "send_to_agent_result",
              ok: false,
              error: e.message,
            })
          );
        }
        break;
      }

      case "switch_session":
        break;
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
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
