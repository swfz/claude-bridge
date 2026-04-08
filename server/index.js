import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync, statSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { SessionManager } from "./session.js";
import { Storage } from "./storage.js";
import { ThreadStore } from "./thread-store.js";
import { listClaudeSessions, loadSessionHistory } from "./claude-sessions.js";
import { JsonlWatcher } from "./jsonl-watcher.js";

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

app.get("/preview", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send("path parameter required");
  }

  // セキュリティ: ホームディレクトリ配下のみ許可
  const home = process.env.HOME || "/home";
  if (!filePath.startsWith(home) && !filePath.startsWith("/tmp")) {
    return res.status(403).send("Access denied: path must be under home or /tmp");
  }

  if (!existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).send("Not a file");
    }
    // 100MB 上限
    if (stat.size > 100 * 1024 * 1024) {
      return res.status(413).send("File too large");
    }
  } catch {
    return res.status(500).send("Cannot stat file");
  }

  const ext = extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.sendFile(filePath);
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
const threadStore = new ThreadStore(storage);
const jsonlWatcher = new JsonlWatcher();

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.send(
    JSON.stringify({
      type: "session_list",
      sessions: sessionManager.listSessions(),
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

        broadcast({
          type: "session_list",
          sessions: sessionManager.listSessions(),
        });
        break;
      }

      case "input": {
        const session = sessionManager.getSession(msg.sessionId);
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
        const session = sessionManager.getSession(msg.sessionId);
        if (session) {
          session.resize(msg.cols, msg.rows);
        }
        break;
      }

      case "kill_session": {
        jsonlWatcher.stopWatching(msg.sessionId);
        sessionManager.killSession(msg.sessionId);
        broadcast({
          type: "session_list",
          sessions: sessionManager.listSessions(),
        });
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
        broadcast({
          type: "session_list",
          sessions: sessionManager.listSessions(),
        });
        break;
      }

      case "remove_past_session": {
        sessionManager.removePastSession(msg.sessionId);
        broadcast({
          type: "session_list",
          sessions: sessionManager.listSessions(),
        });
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
        const session = sessionManager.getSession(msg.sessionId);
        if (session) {
          const thread = threadStore
            .getThreadsForSession(msg.sessionId)
            .find((t) => t.id === msg.threadId);
          const context = thread
            ? `[スレッド: "${thread.selectedText}" への返信]\n${msg.text}`
            : msg.text;
          session.write(context + "\n");
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
        const s = sessionManager.getSession(msg.sessionId);
        if (s) {
          s.write(msg.text + "\n");
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

        broadcast({
          type: "session_list",
          sessions: sessionManager.listSessions(),
        });
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
