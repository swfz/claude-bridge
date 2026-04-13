import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync, statSync, lstatSync, readdirSync } from "fs";
import { extname, join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { SessionManager } from "./session.js";
import { Storage } from "./storage.js";
import { ThreadStore } from "./thread-store.js";
import { listClaudeSessions, loadSessionHistory } from "./claude-sessions.js";
import { JsonlWatcher } from "./jsonl-watcher.js";
import { listClaudeTmuxPanes, TmuxSessionManager } from "./tmux-session.js";

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
const threadStore = new ThreadStore(storage);
const jsonlWatcher = new JsonlWatcher();

function findSession(id) {
  return sessionManager.getSession(id) || tmuxSessionManager.getSession(id);
}

function allSessions() {
  return [...sessionManager.listSessions(), ...tmuxSessionManager.listSessions()];
}

function broadcastSessionList() {
  broadcast({ type: "session_list", sessions: allSessions() });
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

      case "thread_reply": {
        threadStore.addReply(msg.sessionId, msg.threadId, {
          role: "human",
          text: msg.text,
        });

        // スレッドの返信内容を Claude Code に送信
        const session = findSession(msg.sessionId);
        if (session) {
          const thread = threadStore
            .getThreadsForSession(msg.sessionId)
            .find((t) => t.id === msg.threadId);
          const context = thread
            ? `[スレッド: "${thread.selectedText}" への返信]\n${msg.text}`
            : msg.text;
          session.write(context + "\r");
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
        const comments = storage.loadComments(msg.sessionId);
        comments.push({
          id: `comment-${Date.now()}`,
          messageId: msg.messageId,
          text: msg.text,
          timestamp: new Date().toISOString(),
        });
        storage.saveComments(msg.sessionId, comments);
        ws.send(
          JSON.stringify({
            type: "comments_update",
            sessionId: msg.sessionId,
            comments,
          })
        );
        break;
      }

      case "get_comments": {
        ws.send(
          JSON.stringify({
            type: "comments_update",
            sessionId: msg.sessionId,
            comments: storage.loadComments(msg.sessionId),
          })
        );
        break;
      }

      case "send_comment_to_claude": {
        const s = findSession(msg.sessionId);
        if (s) {
          s.write(msg.text + "\r");
        }
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
        listClaudeTmuxPanes().then((panes) => {
          ws.send(
            JSON.stringify({
              type: "tmux_panes",
              panes,
            })
          );
        });
        break;
      }

      case "attach_tmux_pane": {
        const session = tmuxSessionManager.attachPane({
          paneId: msg.paneId,
          name: msg.name || `tmux: ${msg.target}`,
          cwd: msg.cwd,
          target: msg.target,
        });

        // 既存セッションの履歴を読み込んで返す
        const found = jsonlWatcher.findSessionForCwd(msg.cwd);
        if (found) {
          loadSessionHistory(found.sessionId, found.projectDir).then(
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
        }

        // JSONL 監視開始（新規メッセージのみ配信）
        jsonlWatcher.startWatching({
          bridgeSessionId: session.id,
          cwd: msg.cwd,
          attachExisting: true,
          onMessage: (chatMsg) => broadcast(chatMsg),
        });

        broadcastSessionList();
        break;
      }

      case "detach_tmux_pane": {
        jsonlWatcher.stopWatching(msg.sessionId);
        tmuxSessionManager.detachSession(msg.sessionId);
        broadcastSessionList();
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
