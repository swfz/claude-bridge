import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import SessionTabs from "./components/SessionTabs.jsx";
import TerminalView from "./components/TerminalView.jsx";
import ChatView from "./components/ChatView.jsx";
import ThreadPanel from "./components/ThreadPanel.jsx";
import InputBar from "./components/InputBar.jsx";
import NewSessionDialog from "./components/NewSessionDialog.jsx";
import PreviewDrawer from "./components/PreviewDrawer.jsx";
import FileExplorer from "./components/FileExplorer.jsx";
import AgentSidePanel from "./components/AgentSidePanel.jsx";
import "./App.css";

export default function App() {
  const { send, on, connected } = useWebSocket();
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  const [activeSessionId, setActiveSessionId] = useState(
    () => localStorage.getItem("activeSessionId") || null
  );
  const [showNewSession, setShowNewSession] = useState(false);
  const [viewMode, setViewMode] = useState("chat");
  // セッションごとのメッセージを一元管理する唯一の真実（id -> message[]）。
  // 表示用の messages はここから activeSessionId で派生させる（単一 messages state や
  // messageCache の二重管理をやめ、active と表示内容のズレ＝混線を構造的に防ぐ）。
  const [messagesBySession, setMessagesBySession] = useState({});
  const [threads, setThreads] = useState([]);
  const [comments, setComments] = useState([]);
  const activeSessionIdRef = useRef(null);
  // 指定セッションのメッセージだけを更新する（active かどうかは見ない）。
  // updater は配列、または (prev[]) => next[] の関数。
  const updateSessionMessages = useCallback((sessionId, updater) => {
    if (!sessionId) return;
    setMessagesBySession((prev) => {
      const cur = prev[sessionId] || [];
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...prev, [sessionId]: next };
    });
  }, []);
  const [showThreadPanel, setShowThreadPanel] = useState(false);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [claudeSessions, setClaudeSessions] = useState(null);
  const [tmuxPanes, setTmuxPanes] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [drawerOpenedAt, setDrawerOpenedAt] = useState(null);
  // agent view 連携パネル（一覧）。選択するとメインタブに readonly で開く
  const [agents, setAgents] = useState([]);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [syncNotice, setSyncNotice] = useState(null);

  useEffect(() => {
    return on("session_list", (msg) => {
      setSessions(msg.sessions);
      sessionsRef.current = msg.sessions;
      const aliveSessions = msg.sessions.filter((s) => s.alive);
      if (aliveSessions.length === 0) return;
      // 「開いたセッションを active にする」のは session_opened が担う（末尾推定はしない）。
      // ここは active が未設定 or 死んでいるときだけ fallback で最新へ寄せる。
      const currentAlive = aliveSessions.find(
        (s) => s.id === activeSessionIdRef.current
      );
      if (!currentAlive) {
        setActiveSessionId(aliveSessions[aliveSessions.length - 1].id);
      }
    });
  }, [on]);

  // サーバーが「今開いた/接続したセッション」を通知する。末尾推定をやめ、
  // これを唯一の active 切り替えトリガーにすることで取り違えを防ぐ。
  useEffect(() => {
    return on("session_opened", (msg) => {
      if (msg.bridgeSessionId) setActiveSessionId(msg.bridgeSessionId);
    });
  }, [on]);

  useEffect(() => {
    return on("session_exited", (msg) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === msg.sessionId ? { ...s, alive: false } : s
        )
      );
    });
  }, [on]);

  // エラー通知（現在アクティブなセッションのメッセージ列に system として追加）
  useEffect(() => {
    return on("error", (msg) => {
      updateSessionMessages(activeSessionIdRef.current, (prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: msg.message,
          timestamp: new Date().toISOString(),
        },
      ]);
    });
  }, [on, updateSessionMessages]);

  // JSONL ベースの chat_message を受信。
  // active かどうかは見ず、必ず bridgeSessionId のメッセージ列に積む（混線防止）。
  // human は addUserMessage で先行追加されている場合があるため重複チェック。
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

      updateSessionMessages(msg.bridgeSessionId, (prev) => {
        if (
          msg.role === "human" &&
          prev.some((m) => m.role === "human" && m.content === msg.content)
        ) {
          return prev;
        }
        return [...prev, newMsg];
      });
    });
  }, [on, updateSessionMessages]);

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
    return on("agents", (msg) => {
      setAgents(msg.agents || []);
    });
  }, [on]);

  useEffect(() => {
    return on("session_history", (msg) => {
      if (!msg.messages || msg.messages.length === 0) return;

      // 境界 timestamp: attach/resume 時点での履歴末尾の時刻を localStorage に保存し、
      // 再読込後に「境界以前 = 履歴（薄く表示）／境界より後 = 新規（通常表示）」を再現する。
      const bridgeId = msg.bridgeSessionId;
      const boundaryKey = bridgeId ? `historyBoundary:${bridgeId}` : null;
      let boundary = boundaryKey ? localStorage.getItem(boundaryKey) : null;
      if (boundaryKey && !boundary) {
        // 初回受信: 履歴末尾の timestamp を境界として記録
        const lastTs = msg.messages[msg.messages.length - 1].timestamp;
        if (lastTs) {
          localStorage.setItem(boundaryKey, lastTs);
          boundary = lastTs;
        }
      }

      const loaded = msg.messages.map((m, i) => ({
        id: `history-${i}-${Date.now()}`,
        role: m.role,
        content: m.content,
        toolUses: m.toolUses,
        timestamp: m.timestamp || new Date().toISOString(),
        // 境界がある: timestamp が境界以下 / 不在を履歴扱い、境界より新しければ通常表示
        // 境界がない: 従来通り全件履歴扱い（bridgeId 不明な resume 即時ロード等）
        isHistory: boundary ? !m.timestamp || m.timestamp <= boundary : true,
      }));

      // active かどうかに関係なく bridgeSessionId のメッセージ列へ格納する。
      // 表示は messagesBySession[activeSessionId] の派生なので、active なら自動反映。
      if (bridgeId) updateSessionMessages(bridgeId, loaded);
    });
  }, [on, updateSessionMessages]);

  // activeSessionIdRef を同期し、リロード後に同じタブへ戻せるよう永続化
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (activeSessionId) {
      localStorage.setItem("activeSessionId", activeSessionId);
    } else {
      localStorage.removeItem("activeSessionId");
    }
  }, [activeSessionId]);

  // セッション切り替え時にスレッドとコメントを取得
  useEffect(() => {
    if (activeSessionId) {
      send({ type: "get_threads", sessionId: activeSessionId });
      send({ type: "get_comments", sessionId: activeSessionId });
    }
  }, [activeSessionId, send]);

  // アクティブセッションのメッセージが未取得なら JSONL から復元する
  // （リロード後など messagesBySession に無い場合の復旧経路）。
  useEffect(() => {
    if (!activeSessionId) return;
    const cur = messagesBySession[activeSessionId];
    if (cur && cur.length > 0) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.claudeSessionId) {
      send({
        type: "load_session_history",
        sessionId: activeSessionId,
        claudeSessionId: session.claudeSessionId,
        projectDir: session.projectDir,
      });
    }
  }, [activeSessionId, sessions, send, messagesBySession]);

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
      // 境界情報は kill されたセッションには無意味なのでクリーンアップ
      localStorage.removeItem(`historyBoundary:${sessionId}`);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
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
      localStorage.removeItem(`historyBoundary:${sessionId}`);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
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
    ({ paneId, name, cwd, target, claudePid, claudeSessionId, status }) => {
      send({
        type: "attach_tmux_pane",
        paneId,
        name,
        cwd,
        target,
        claudePid,
        claudeSessionId,
        status,
      });
      setShowNewSession(false);
      setTmuxPanes(null);
    },
    [send]
  );

  // claude を起動せず、既存セッションの JSONL を読むだけの閲覧（コメント可）ビューを開く
  const handleOpenReadonly = useCallback(
    ({ claudeSessionId, name, cwd, projectDir }) => {
      send({ type: "open_readonly_session", claudeSessionId, name, cwd, projectDir });
      setShowNewSession(false);
      setClaudeSessions(null);
    },
    [send]
  );

  const handleCloseReadonly = useCallback(
    (sessionId) => {
      send({ type: "close_readonly_session", sessionId });
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [send, sessions, activeSessionId]
  );

  // --- agent view 連携パネル ---
  const handleRefreshAgents = useCallback(() => {
    send({ type: "list_agents" });
  }, [send]);

  // 一覧で選んだ agent を、メインタブに readonly セッションとして開く
  // （閲覧で開くのと同じ経路。会話はメインの大画面で表示し、送信欄から inbox へ送る）
  const handleOpenAgent = useCallback(
    (agent) => {
      if (!agent?.sessionId) return;
      handleOpenReadonly({
        claudeSessionId: agent.sessionId,
        name: agent.name || agent.sessionId.slice(0, 8),
        cwd: agent.cwd,
      });
    },
    [handleOpenReadonly]
  );

  // readonly セッション（メインタブ）から、その claudeSessionId へフックベース送信
  const handleSendToReadonly = useCallback(
    (text) => {
      const t = (text || "").trim();
      const s = sessionsRef.current.find((x) => x.id === activeSessionId);
      const sid = s?.claudeSessionId;
      if (!t || !sid) return;
      send({ type: "send_to_agent", claudeSessionId: sid, comments: [t] });
    },
    [send, activeSessionId]
  );

  // コメント送信（inbox 書き込み）の結果
  useEffect(() => {
    return on("send_to_agent_result", (msg) => {
      setSyncNotice(
        msg.ok
          ? "コメントを送信しました（対象セッションのフックが取り込みます）。"
          : "送信に失敗しました。"
      );
    });
  }, [on]);

  const handleRequestTmuxPanes = useCallback(() => {
    send({ type: "list_tmux_panes" });
  }, [send]);

  const addUserMessage = useCallback(
    (text) => {
      updateSessionMessages(activeSessionIdRef.current, (prev) => [
        ...prev,
        {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "human",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
    [updateSessionMessages]
  );

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

  const handleSwitchSession = useCallback((sessionId) => {
    // 表示は messagesBySession[activeSessionId] の派生なので active を変えるだけでよい
    // （cache 保存・復元やレース対策は不要になった）
    setActiveSessionId(sessionId);
    setThreads([]);
    setComments([]);
  }, []);

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

  const handleThreadReplyBatch = useCallback(
    (replies) => {
      if (!activeSessionId || replies.length === 0) return;
      send({
        type: "thread_reply_batch",
        sessionId: activeSessionId,
        replies,
      });
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

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // 表示メッセージは唯一の真実 messagesBySession から activeSessionId で派生させる
  const messages = (activeSessionId && messagesBySession[activeSessionId]) || [];
  // 閲覧専用セッションは JSONL を読むだけ。chat 固定でコメントは付けられるが送信はしない
  const isReadonly = activeSession?.type === "readonly";
  const effectiveViewMode = isReadonly ? "chat" : viewMode;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Claude Bridge</h1>
        <div className="header-controls">
          {activeSessionId && !isReadonly && (
            <>
              <button
                className={`toggle-btn thread-toggle ${showFileExplorer ? "active" : ""}`}
                onClick={() => setShowFileExplorer(!showFileExplorer)}
                title="ファイラを表示/非表示"
              >
                Files
              </button>
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
          <button
            className={`toggle-btn thread-toggle ${showAgentPanel ? "active" : ""}`}
            onClick={() => {
              const next = !showAgentPanel;
              setShowAgentPanel(next);
              if (next) handleRefreshAgents();
            }}
            title="agent view のセッション一覧とコメント"
          >
            Agents
          </button>
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
        onCloseReadonly={handleCloseReadonly}
        onNew={() => setShowNewSession(true)}
      />

      <div className="app-content">
        {showFileExplorer && (
          <FileExplorer
            cwd={sessions.find((s) => s.id === activeSessionId)?.cwd}
            onOpenPreview={(path) => {
              setPreviewData({ filePath: path });
              setDrawerOpenedAt(messages.length);
            }}
          />
        )}
        <main className="app-main">
          {activeSessionId ? (
            effectiveViewMode === "raw" ? (
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
                sessionCwd={sessions.find((s) => s.id === activeSessionId)?.cwd}
                onStartThread={handleStartThread}
                onAddComment={handleAddComment}
                onSendCommentToClaude={handleSendCommentToClaude}
                onReviewSubmit={handleReviewSubmit}
                onOpenPreview={(path) => { setPreviewData({ filePath: path }); setDrawerOpenedAt(messages.length); }}
                onPreviewMarkdown={(markdown, title) => { setPreviewData({ markdown, title }); setDrawerOpenedAt(messages.length); }}
                onOpenFileReview={(path) => { setPreviewData({ filePath: path, reviewMode: true }); setDrawerOpenedAt(messages.length); }}
                readonly={isReadonly}
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

        {showThreadPanel && effectiveViewMode === "chat" && (
          <ThreadPanel
            threads={threads}
            onReplyBatch={handleThreadReplyBatch}
            onResolve={handleResolveThread}
            onDelete={handleDeleteThread}
          />
        )}
        {showAgentPanel && (
          <AgentSidePanel
            agents={agents}
            activeClaudeSessionId={activeSession?.claudeSessionId}
            syncNotice={syncNotice}
            onSelectAgent={handleOpenAgent}
            onRefreshAgents={handleRefreshAgents}
          />
        )}
      </div>

      {activeSessionId && isReadonly ? (
        <InputBar
          onSubmit={handleSendToReadonly}
          disabled={!activeSession?.claudeSessionId}
          placeholder="このセッションに送信（claude-bridge → inbox 経由）..."
        />
      ) : (
        <InputBar onSubmit={handleInput} disabled={!activeSessionId} />
      )}

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
          onOpenReadonly={handleOpenReadonly}
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
