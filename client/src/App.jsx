import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import SessionTabs from "./components/SessionTabs.jsx";
import TerminalView from "./components/TerminalView.jsx";
import ChatView from "./components/ChatView.jsx";
import ThreadPanel from "./components/ThreadPanel.jsx";
import InputBar from "./components/InputBar.jsx";
import NewSessionDialog from "./components/NewSessionDialog.jsx";
import PreviewDrawer from "./components/PreviewDrawer.jsx";
import "./App.css";

export default function App() {
  const { send, on, connected } = useWebSocket();
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [viewMode, setViewMode] = useState("chat");
  const [messages, setMessages] = useState([]);
  const [threads, setThreads] = useState([]);
  const [comments, setComments] = useState([]);
  const messageCache = useRef(new Map());
  const [showThreadPanel, setShowThreadPanel] = useState(false);
  const [claudeSessions, setClaudeSessions] = useState(null);
  const [tmuxPanes, setTmuxPanes] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [drawerOpenedAt, setDrawerOpenedAt] = useState(null);
  const pendingTmuxAttach = useRef(false);

  useEffect(() => {
    return on("session_list", (msg) => {
      setSessions(msg.sessions);
      sessionsRef.current = msg.sessions;
      const aliveSessions = msg.sessions.filter((s) => s.alive);
      if (aliveSessions.length > 0) {
        if (pendingTmuxAttach.current) {
          // tmux 接続直後: 最新セッションに切り替え
          pendingTmuxAttach.current = false;
          const newest = aliveSessions[aliveSessions.length - 1];
          setActiveSessionId(newest.id);
          setMessages([]);
        } else {
          // 今のactiveがaliveでなければ、最新のaliveセッションに切り替え
          const currentAlive = aliveSessions.find((s) => s.id === activeSessionId);
          if (!currentAlive) {
            setActiveSessionId(aliveSessions[aliveSessions.length - 1].id);
          }
        }
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on("session_exited", (msg) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === msg.sessionId ? { ...s, alive: false } : s
        )
      );
    });
  }, [on]);

  // エラー通知
  useEffect(() => {
    return on("error", (msg) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: msg.message,
          timestamp: new Date().toISOString(),
        },
      ]);
    });
  }, [on]);

  // JSONL ベースの chat_message を受信
  // human メッセージは addUserMessage で即座に追加済みの場合があるため重複チェック
  useEffect(() => {
    return on("chat_message", (msg) => {
      const session = sessionsRef.current.find((s) => s.id === msg.bridgeSessionId);
      const isTmux = session?.type === "tmux";
      if (!(msg.role === "assistant" || (isTmux && msg.role === "human"))) return;

      const newMsg = {
        id: `jsonl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: msg.role,
        content: msg.content,
        toolUses: msg.toolUses,
        timestamp: msg.timestamp || new Date().toISOString(),
      };

      if (msg.bridgeSessionId === activeSessionId) {
        setMessages((prev) => {
          if (msg.role === "human") {
            const dup = prev.some((m) => m.role === "human" && m.content === msg.content);
            if (dup) return prev;
          }
          return [...prev, newMsg];
        });
      } else {
        // バックグラウンドセッションのメッセージはキャッシュに追加
        const cached = messageCache.current.get(msg.bridgeSessionId) || [];
        if (msg.role === "human" && cached.some((m) => m.role === "human" && m.content === msg.content)) {
          return;
        }
        messageCache.current.set(msg.bridgeSessionId, [...cached, newMsg]);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on("thread_update", (msg) => {
      if (msg.sessionId === activeSessionId) {
        setThreads(msg.threads);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on("comments_update", (msg) => {
      if (msg.sessionId === activeSessionId) {
        setComments(msg.comments);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on("claude_sessions", (msg) => {
      setClaudeSessions(msg.sessions);
    });
  }, [on]);

  useEffect(() => {
    return on("tmux_panes", (msg) => {
      setTmuxPanes(msg.panes);
    });
  }, [on]);

  useEffect(() => {
    return on("session_history", (msg) => {
      if (msg.messages && msg.messages.length > 0) {
        const loaded = msg.messages.map((m, i) => ({
          id: `history-${i}-${Date.now()}`,
          role: m.role,
          content: m.content,
          toolUses: m.toolUses,
          timestamp: m.timestamp || new Date().toISOString(),
          isHistory: true,
        }));
        setMessages(loaded);
      }
    });
  }, [on]);

  // メッセージをキャッシュに同期
  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      messageCache.current.set(activeSessionId, messages);
    }
  }, [messages, activeSessionId]);

  // セッション切り替え時にスレッドとコメントを取得
  useEffect(() => {
    if (activeSessionId) {
      send({ type: "get_threads", sessionId: activeSessionId });
      send({ type: "get_comments", sessionId: activeSessionId });
    }
  }, [activeSessionId, send]);

  const handleCreateSession = useCallback(
    ({ name, cwd }) => {
      send({ type: "new_session", name, cwd });
      setShowNewSession(false);
    },
    [send]
  );

  const handleKillSession = useCallback(
    (sessionId) => {
      send({ type: "kill_session", sessionId });
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [send, sessions, activeSessionId]
  );

  const handleRestartSession = useCallback(
    (sessionId) => {
      send({ type: "restart_session", sessionId });
    },
    [send]
  );

  const handleRemovePastSession = useCallback(
    (sessionId) => {
      send({ type: "remove_past_session", sessionId });
    },
    [send]
  );

  const handleDetachTmux = useCallback(
    (sessionId) => {
      send({ type: "detach_tmux_pane", sessionId });
    },
    [send]
  );

  const handleResumeSession = useCallback(
    ({ claudeSessionId, name, cwd, projectDir }) => {
      // 履歴を先に取得
      send({
        type: "load_session_history",
        claudeSessionId,
        projectDir,
      });
      // セッションを resume で起動
      send({ type: "resume_session", claudeSessionId, name, cwd });
      setShowNewSession(false);
      setClaudeSessions(null);
    },
    [send]
  );

  const handleRequestClaudeSessions = useCallback(() => {
    send({ type: "list_claude_sessions" });
  }, [send]);

  const handleAttachTmux = useCallback(
    ({ paneId, name, cwd, target }) => {
      // pendingTmuxAttach を使って、session_list 更新後に履歴をリクエスト
      pendingTmuxAttach.current = true;
      send({ type: "attach_tmux_pane", paneId, name, cwd, target });
      setShowNewSession(false);
      setTmuxPanes(null);
    },
    [send]
  );

  const handleRequestTmuxPanes = useCallback(() => {
    send({ type: "list_tmux_panes" });
  }, [send]);

  const addUserMessage = useCallback((text) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "human",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  const handleInput = useCallback(
    (text) => {
      if (activeSessionId) {
        addUserMessage(text);
        send({ type: "input", sessionId: activeSessionId, text: text + "\r" });
      }
    },
    [send, activeSessionId, addUserMessage]
  );

  const handleResize = useCallback(
    (cols, rows) => {
      if (activeSessionId) {
        send({ type: "resize", sessionId: activeSessionId, cols, rows });
      }
    },
    [send, activeSessionId]
  );

  const handleSwitchSession = useCallback(
    (sessionId) => {
      setActiveSessionId(sessionId);
      setMessages(messageCache.current.get(sessionId) || []);
      setThreads([]);
      setComments([]);
    },
    []
  );

  const handleStartThread = useCallback(
    (messageId, selectedText) => {
      if (activeSessionId) {
        send({
          type: "new_thread",
          sessionId: activeSessionId,
          messageId,
          selectedText: selectedText || "(メッセージ全体)",
        });
        setShowThreadPanel(true);
      }
    },
    [send, activeSessionId]
  );

  const handleThreadReply = useCallback(
    (threadId, text) => {
      if (activeSessionId) {
        send({
          type: "thread_reply",
          sessionId: activeSessionId,
          threadId,
          text,
        });
      }
    },
    [send, activeSessionId]
  );

  const handleResolveThread = useCallback(
    (threadId) => {
      if (activeSessionId) {
        send({
          type: "resolve_thread",
          sessionId: activeSessionId,
          threadId,
        });
      }
    },
    [send, activeSessionId]
  );

  const handleDeleteThread = useCallback(
    (threadId) => {
      if (activeSessionId) {
        send({
          type: "delete_thread",
          sessionId: activeSessionId,
          threadId,
        });
      }
    },
    [send, activeSessionId]
  );

  const handleAddComment = useCallback(
    (messageId, text) => {
      if (activeSessionId) {
        send({
          type: "save_comment",
          sessionId: activeSessionId,
          messageId,
          text,
        });
      }
    },
    [send, activeSessionId]
  );

  const handleReviewSubmit = useCallback(
    (messageId, items) => {
      if (!activeSessionId || items.length === 0) return;
      // 1行形式で送信
      const prompt = items.length === 1
        ? `[レビュー] ${items[0]}`
        : `[レビュー ${items.length}件] ${items.join(" / ")}`;
      addUserMessage(prompt);
      send({
        type: "input",
        sessionId: activeSessionId,
        text: prompt + "\r",
      });
    },
    [send, activeSessionId, addUserMessage]
  );

  const handleSendCommentToClaude = useCallback(
    (text) => {
      if (activeSessionId) {
        addUserMessage(`[コメントから送信] ${text}`);
        send({
          type: "send_comment_to_claude",
          sessionId: activeSessionId,
          text,
        });
      }
    },
    [send, activeSessionId, addUserMessage]
  );

  const unresolvedCount = threads.filter((t) => !t.resolved).length;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Claude Bridge</h1>
        <div className="header-controls">
          {activeSessionId && (
            <>
              <div className="view-toggle">
                <button
                  className={`toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                  onClick={() => setViewMode("raw")}
                >
                  Raw
                </button>
                <button
                  className={`toggle-btn ${viewMode === "chat" ? "active" : ""}`}
                  onClick={() => setViewMode("chat")}
                >
                  Chat
                </button>
              </div>
              {viewMode === "chat" && (
                <button
                  className={`toggle-btn thread-toggle ${showThreadPanel ? "active" : ""}`}
                  onClick={() => setShowThreadPanel(!showThreadPanel)}
                >
                  Threads
                  {unresolvedCount > 0 && (
                    <span className="thread-count-badge">
                      {unresolvedCount}
                    </span>
                  )}
                </button>
              )}
            </>
          )}
          <div className="connection-status">
            <span
              className={`status-dot ${connected ? "connected" : "disconnected"}`}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </header>

      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={handleSwitchSession}
        onKill={handleKillSession}
        onRestart={handleRestartSession}
        onRemovePast={handleRemovePastSession}
        onDetachTmux={handleDetachTmux}
        onNew={() => setShowNewSession(true)}
      />

      <div className="app-content">
        <main className="app-main">
          {activeSessionId ? (
            viewMode === "raw" ? (
              <TerminalView
                sessionId={activeSessionId}
                on={on}
                onResize={handleResize}
                send={send}
              />
            ) : (
              <ChatView
                messages={messages}
                threads={threads}
                comments={comments}
                onStartThread={handleStartThread}
                onAddComment={handleAddComment}
                onSendCommentToClaude={handleSendCommentToClaude}
                onReviewSubmit={handleReviewSubmit}
                onOpenPreview={(path) => { setPreviewData({ filePath: path }); setDrawerOpenedAt(messages.length); }}
                onPreviewMarkdown={(markdown, title) => { setPreviewData({ markdown, title }); setDrawerOpenedAt(messages.length); }}
                onOpenFileReview={(path) => { setPreviewData({ filePath: path, reviewMode: true }); setDrawerOpenedAt(messages.length); }}
              />
            )
          ) : (
            <div className="empty-state">
              <p>セッションがありません</p>
              <button
                className="btn btn-primary"
                onClick={() => setShowNewSession(true)}
              >
                新しいセッションを作成
              </button>
            </div>
          )}
        </main>

        {showThreadPanel && viewMode === "chat" && (
          <ThreadPanel
            threads={threads}
            onReply={handleThreadReply}
            onResolve={handleResolveThread}
            onDelete={handleDeleteThread}
          />
        )}
      </div>

      <InputBar onSubmit={handleInput} disabled={!activeSessionId} />

      {showNewSession && (
        <NewSessionDialog
          onClose={() => {
            setShowNewSession(false);
            setClaudeSessions(null);
            setTmuxPanes(null);
          }}
          onCreate={handleCreateSession}
          onResume={handleResumeSession}
          onAttachTmux={handleAttachTmux}
          onRequestClaudeSessions={handleRequestClaudeSessions}
          onRequestTmuxPanes={handleRequestTmuxPanes}
          claudeSessions={claudeSessions}
          tmuxPanes={tmuxPanes}
        />
      )}

      {previewData && (
        <PreviewDrawer
          filePath={previewData.filePath}
          markdown={previewData.markdown}
          title={previewData.title}
          reviewMode={previewData.reviewMode}
          onClose={() => { setPreviewData(null); setDrawerOpenedAt(null); }}
          onReviewSubmit={(target, items) => {
            if (!activeSessionId) {
              console.warn("No active session for review submit");
              return;
            }
            const fileName = target.split("/").pop();
            // 改行なしの1行形式で送信（PTYが複数行を扱えないため）
            const prompt = items.length === 1
              ? `[レビュー: ${fileName}] ${items[0].replace(/\n/g, " ")}`
              : `[レビュー: ${fileName} ${items.length}件] ${items.map((t) => t.replace(/\n/g, " ")).join(" / ")}`;
            addUserMessage(prompt);
            send({ type: "input", sessionId: activeSessionId, text: prompt + "\r" });
          }}
          responses={
            drawerOpenedAt != null
              ? messages.slice(drawerOpenedAt).filter((m) => m.role === "assistant")
              : []
          }
        />
      )}
    </div>
  );
}
