import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import SessionTabs from "./components/SessionTabs.jsx";
import TerminalView from "./components/TerminalView.jsx";
import ChatView from "./components/ChatView.jsx";
import ThreadPanel from "./components/ThreadPanel.jsx";
import CommentPanel from "./components/CommentPanel.jsx";
import ReviewDraftPanel from "./components/ReviewDraftPanel.jsx";
import InputBar from "./components/InputBar.jsx";
import ChoicePrompt from "./components/ChoicePrompt.jsx";
import TaskStrip from "./components/TaskStrip.jsx";
import SubagentDrawer from "./components/SubagentDrawer.jsx";
import NewSessionDialog from "./components/NewSessionDialog.jsx";
import PreviewDrawer from "./components/PreviewDrawer.jsx";
import FileExplorer from "./components/FileExplorer.jsx";
import AgentSidePanel from "./components/AgentSidePanel.jsx";
import HomeView from "./components/HomeView.jsx";
import RateLimitMeter from "./components/RateLimitMeter.jsx";
import {
  loadStarred,
  saveStarred,
  toggleStarred,
} from "./utils/starredSessions.js";
import { statusMapOf, updateAttention } from "./utils/attention.js";
import { pickNotifyTargets } from "./utils/notifications.js";
import "./App.css";

// ホーム表示中に起動中セッション一覧を取り直す間隔（status/新規起動の反映用）
const RUNNING_POLL_INTERVAL = 5000;
// 作業中タブでサブエージェントのタスク一覧を取り直す間隔
const SUBAGENT_POLL_INTERVAL = 5000;

export default function App() {
  const { send, on, connected } = useWebSocket();
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  const [activeSessionId, setActiveSessionId] = useState(
    () => localStorage.getItem("activeSessionId") || null
  );
  const [showNewSession, setShowNewSession] = useState(false);
  const [viewMode, setViewMode] = useState("chat");
  // ホーム画面（起動中の Claude セッション一覧）。タブとは独立した表示モードで、
  // activeSessionId は保持したまま切り替える（Home ⇄ 作業中タブを行き来できる）。
  const [showHome, setShowHome] = useState(
    () => localStorage.getItem("showHome") !== "false"
  );
  // ターン完了時のデスクトップ通知（Notification API）の ON/OFF。localStorage で記憶。
  const [notifyEnabled, setNotifyEnabled] = useState(
    () => localStorage.getItem("desktopNotify") === "true"
  );
  // サーバーが返す「今このマシンで起動中の Claude セッション」。null = 未取得
  const [runningSessions, setRunningSessions] = useState(null);
  // ホームの「直近のセッション」（終了済みを含む JSONL 由来）。null = 未取得
  const [recentSessions, setRecentSessions] = useState(null);
  const [recentDays, setRecentDays] = useState(
    () => Number(localStorage.getItem("homeRecentDays")) || 7
  );
  // ホーム画面の操作エラー（tmux 再開の失敗など）。チャット欄には出せないのでバナーで見せる
  const [homeError, setHomeError] = useState(null);
  // セッションごとの選択肢プロンプト（id -> {prompt, waitingFor}）。
  // JSONL には回答後にしか出ないので、サーバーが画面から読んだものをそのまま持つ。
  const [choicePrompts, setChoicePrompts] = useState({});
  const [choiceError, setChoiceError] = useState(null);
  // セッションが起動したサブエージェントのタスク一覧（bridgeSessionId -> tasks）
  const [subagentTasks, setSubagentTasks] = useState({});
  // トランスクリプトを表示中のサブエージェント（null なら閉じている）
  const [subagentDrawer, setSubagentDrawer] = useState(null);
  // 「未解決／続きをやる」印を付けた claudeSessionId（localStorage のみ）
  const [starredSessions, setStarredSessions] = useState(loadStarred);
  // 一覧取得時に添えるだけなので、star の変更で再取得は走らせない（JSONL 走査を避ける）
  const starredRef = useRef(starredSessions);
  starredRef.current = starredSessions;
  // 「ターン完了（未確認）」印を付けたタブの id（tmux のベル通知相当）。サーバーには持たせない。
  const [attentionIds, setAttentionIds] = useState(() => new Set());
  // 直近の session_list の status スナップショット（busy -> 非busy の遷移検出に使う）
  const prevStatusRef = useRef(new Map());
  // 「未確認」を解除する（タブを選んだ／実際に見た）
  const clearAttention = useCallback((sessionId) => {
    if (!sessionId) return;
    setAttentionIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);
  // アプリ全体のテーマ（背景/UI）。localStorage で記憶。プレビュー本文の独自トグルとは独立。
  const [appTheme, setAppTheme] = useState(
    () => localStorage.getItem("appTheme") || "dark"
  );
  // セッションごとのメッセージを一元管理する唯一の真実（id -> message[]）。
  // 表示用の messages はここから activeSessionId で派生させる（単一 messages state や
  // messageCache の二重管理をやめ、active と表示内容のズレ＝混線を構造的に防ぐ）。
  const [messagesBySession, setMessagesBySession] = useState({});
  const [threads, setThreads] = useState([]);
  // セッションに対して残すコメント（送信しない・参照専用）
  const [comments, setComments] = useState([]);
  // セッション横断の pending review（Submit するまで溜める下書き）
  const [reviewItems, setReviewItems] = useState([]);
  const activeSessionIdRef = useRef(null);
  // attention 判定の isViewingActive で使う（session_list ハンドラは on 依存のみで stale closure になるため）
  const showHomeRef = useRef(showHome);
  useEffect(() => {
    showHomeRef.current = showHome;
  }, [showHome]);
  // session_list ハンドラの effect は [on] 依存のみで stale closure になるため
  const notifyEnabledRef = useRef(notifyEnabled);
  useEffect(() => {
    notifyEnabledRef.current = notifyEnabled;
  }, [notifyEnabled]);
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
  const [showCommentPanel, setShowCommentPanel] = useState(false);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  // コメント一覧から本文へスクロールする際の対象メッセージ uuid
  const [jumpToUuid, setJumpToUuid] = useState(null);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [claudeSessions, setClaudeSessions] = useState(null);
  const [tmuxPanes, setTmuxPanes] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [drawerOpenedAt, setDrawerOpenedAt] = useState(null);
  // agent view 連携パネル（一覧）。選択するとメインタブに readonly で開く
  const [agents, setAgents] = useState([]);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [syncNotice, setSyncNotice] = useState(null);
  // Claude のレート制限（5h/7d ウィンドウの使用率）。サーバーが 3 分間隔で配ってくる
  const [rateLimits, setRateLimits] = useState(null);

  // コメント/レビューの保存・取得キー。claudeSessionId を優先し（再オープン/resume/閲覧
  // をまたいで同じ Claude セッションを参照するため）、無ければブリッジ ID。
  const sessionKey =
    sessions.find((s) => s.id === activeSessionId)?.claudeSessionId ||
    activeSessionId;

  // アプリ全体テーマを body のクラスに反映し localStorage に記憶する。
  // light のとき body.light-mode が付き、index.css の var() がライト配色へ切り替わる。
  useEffect(() => {
    document.body.classList.toggle("light-mode", appTheme === "light");
    localStorage.setItem("appTheme", appTheme);
  }, [appTheme]);

  useEffect(() => {
    return on("session_list", (msg) => {
      setSessions(msg.sessions);
      sessionsRef.current = msg.sessions;
      // busy -> 非busy に遷移した alive セッションを「未確認」に追加する（見ている最中のアクティブタブは除く）。
      // setAttentionIds の更新関数は遅延実行されるため、prevStatusRef はローカルに退避してから差し替える
      const prevStatuses = prevStatusRef.current;
      prevStatusRef.current = statusMapOf(msg.sessions);
      setAttentionIds((prev) =>
        updateAttention({
          prev: prevStatuses,
          current: prev,
          sessions: msg.sessions,
          activeSessionId: activeSessionIdRef.current,
          isViewingActive: !showHomeRef.current && !document.hidden,
        })
      );
      // デスクトップ通知: タブが見えていないときだけ（見えていればタブ装飾で分かる）
      if (
        notifyEnabledRef.current &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        document.hidden
      ) {
        for (const s of pickNotifyTargets({
          prev: prevStatuses,
          sessions: msg.sessions,
        })) {
          const n = new Notification(s.name || "Claude Bridge", {
            body: "ターンが完了しました",
            tag: `bridge-attention-${s.id}`, // 同一セッションの通知は上書きして溜めない
          });
          n.onclick = () => {
            window.focus();
            handleSwitchSessionRef.current?.(s.id);
            n.close();
          };
        }
      }
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
      if (msg.bridgeSessionId) {
        setActiveSessionId(msg.bridgeSessionId);
        // 開いたセッションを見せたいのでホームからは抜ける
        setShowHome(false);
        clearAttention(msg.bridgeSessionId);
      }
    });
  }, [on, clearAttention]);

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

  // ホーム画面の操作エラー（tmux window 作成の失敗など）
  useEffect(() => {
    return on("home_error", (msg) => setHomeError(msg.message));
  }, [on]);

  // TUI に出ている選択肢プロンプト（AskUserQuestion / ツール許可 / trust 確認）。
  // サーバーが待ち状態のセッションの画面を読んで送ってくる。prompt が null なら待ちではない。
  useEffect(() => {
    return on("choice_prompt", (msg) => {
      setChoicePrompts((prev) => ({
        ...prev,
        [msg.sessionId]: { prompt: msg.prompt, waitingFor: msg.waitingFor },
      }));
      setChoiceError(null);
    });
  }, [on]);

  useEffect(() => {
    return on("choice_prompt_error", (msg) => setChoiceError(msg.message));
  }, [on]);

  // サブエージェント（Agent ツール）の一覧。JSONL のファイル読みなので readonly でも来る
  useEffect(() => {
    return on("subagent_tasks", (msg) => {
      setSubagentTasks((prev) => ({ ...prev, [msg.sessionId]: msg.tasks || [] }));
    });
  }, [on]);

  // ドロワーで開いているサブエージェントの会話。別の agent のものは捨てる
  useEffect(() => {
    return on("subagent_transcript", (msg) => {
      setSubagentDrawer((prev) =>
        prev && prev.agentId === msg.agentId
          ? { ...prev, messages: msg.messages || [], status: msg.status ?? prev.status }
          : prev
      );
    });
  }, [on]);

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
        // JSONL の uuid を安定アンカーとして保持（コメント/レビューの位置紐付け用）
        uuid: msg.uuid || null,
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
    return on("review_update", (msg) => {
      if (msg.sessionId === activeSessionId) {
        setReviewItems(msg.items || []);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on("submit_review_result", (msg) => {
      setSyncNotice(
        msg.ok
          ? `レビュー ${msg.count} 件を送信しました（${msg.via === "inbox" ? "inbox 経由" : "PTY"}）。`
          : "レビューの送信に失敗しました。"
      );
    });
  }, [on]);

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
    return on("running_sessions", (msg) => {
      setRunningSessions(msg.sessions || []);
    });
  }, [on]);

  useEffect(() => {
    return on("recent_sessions", (msg) => {
      setRecentSessions(msg.sessions || []);
    });
  }, [on]);

  useEffect(() => {
    return on("rate_limits", (msg) => setRateLimits({ usage: msg.usage, fetchedAt: msg.fetchedAt }));
  }, [on]);

  // ホーム表示中だけポーリングする（裏では取りに行かない）
  useEffect(() => {
    if (!showHome || !connected) return;
    send({ type: "list_running_sessions" });
    const timer = setInterval(
      () => send({ type: "list_running_sessions" }),
      RUNNING_POLL_INTERVAL
    );
    return () => clearInterval(timer);
  }, [showHome, connected, send]);

  // 作業中タブを見ている間だけサブエージェントの一覧を取り直す（タブ切替時は即時 1 回）
  useEffect(() => {
    if (showHome || !activeSessionId || !connected) return;
    const request = () =>
      send({ type: "list_subagent_tasks", sessionId: activeSessionId });
    request();
    const timer = setInterval(request, SUBAGENT_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [showHome, activeSessionId, connected, send]);

  // 別セッションのタスクを見せ続けないよう、タブ切替・ホーム表示でドロワーを閉じる
  useEffect(() => {
    setSubagentDrawer(null);
  }, [activeSessionId, showHome]);

  const handleOpenSubagentTask = useCallback((task) => {
    setSubagentDrawer({
      agentId: task.agentId,
      description: task.description,
      agentType: task.agentType,
      status: task.status,
      messages: [],
    });
  }, []);

  // ドロワーからの取得要求（初回＋実行中のポーリング）
  const handleRequestTranscript = useCallback(
    (agentId) => {
      if (!activeSessionId || !agentId) return;
      send({ type: "get_subagent_transcript", sessionId: activeSessionId, agentId });
    },
    [send, activeSessionId]
  );

  // 直近セッションは JSONL 全走査になるので、ホームを開いた時と日数変更時だけ取る。
  // starred は「期間外でも一覧に含める対象」としてサーバーに渡す
  useEffect(() => {
    if (!showHome || !connected) return;
    send({
      type: "list_recent_sessions",
      days: recentDays,
      starred: starredRef.current,
    });
  }, [showHome, connected, recentDays, send]);

  useEffect(() => {
    localStorage.setItem("homeRecentDays", String(recentDays));
  }, [recentDays]);

  useEffect(() => {
    saveStarred(starredSessions);
  }, [starredSessions]);

  const handleToggleStar = useCallback((sessionId) => {
    setStarredSessions((prev) => toggleStarred(prev, sessionId));
  }, []);

  useEffect(() => {
    localStorage.setItem("showHome", String(showHome));
  }, [showHome]);

  useEffect(() => {
    localStorage.setItem("desktopNotify", String(notifyEnabled));
  }, [notifyEnabled]);

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
        uuid: m.uuid || null,
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

  // セッション切り替え時にスレッド・コメント・レビュー下書きを取得。
  // コメント/レビューは sessionKey 依存にして、claudeSessionId が後から埋まった場合も再取得する。
  useEffect(() => {
    if (activeSessionId) {
      send({ type: "get_threads", sessionId: activeSessionId });
      send({ type: "get_comments", sessionId: activeSessionId, sessionKey });
      send({ type: "get_review", sessionId: activeSessionId, sessionKey });
    }
  }, [activeSessionId, sessionKey, send]);

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

  // tmux に新しい window を作って `claude --resume` で起こす。
  // PTY 直起動（handleResumeSession）と違い、ブリッジを落としても生き残る。
  const handleResumeInTmux = useCallback(
    ({ claudeSessionId, name, cwd }) => {
      setHomeError(null);
      send({ type: "resume_in_tmux", claudeSessionId, name, cwd });
      setShowNewSession(false);
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

  // 選択肢プロンプトへの回答。keys は数字キー（選択/トグル）や Tab / Escape。
  // text は "Type something" の自由入力（サーバーが 番号 → テキスト → Enter の順で送る）。
  const handleAnswerChoice = useCallback(
    ({ keys, text }) => {
      if (!activeSessionId) return;
      send({ type: "answer_choice_prompt", sessionId: activeSessionId, keys, text });
    },
    [send, activeSessionId]
  );

  const handleRefreshChoice = useCallback(() => {
    if (!activeSessionId) return;
    send({ type: "get_choice_prompt", sessionId: activeSessionId });
  }, [send, activeSessionId]);

  // タブを切り替えた/再接続した直後は、その場で画面を読んでカードの内容を合わせる
  // （定期ポーリングを待たずに出したいため）
  useEffect(() => {
    if (!activeSessionId || showHome || !connected) return;
    send({ type: "get_choice_prompt", sessionId: activeSessionId });
  }, [send, activeSessionId, showHome, connected]);

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
      // 表示は messagesBySession[activeSessionId] の派生なので active を変えるだけでよい
      // （cache 保存・復元やレース対策は不要になった）
      setShowHome(false);
      setActiveSessionId(sessionId);
      setThreads([]);
      setComments([]);
      setReviewItems([]);
      clearAttention(sessionId);
    },
    [clearAttention]
  );

  // 通知クリック時に最新の handleSwitchSession を呼ぶため（session_list ハンドラの
  // effect は [on] 依存のみで stale closure になる）
  const handleSwitchSessionRef = useRef(handleSwitchSession);
  useEffect(() => {
    handleSwitchSessionRef.current = handleSwitchSession;
  }, [handleSwitchSession]);

  const handleToggleNotify = useCallback(async () => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      return;
    }
    if (Notification.permission === "granted") {
      setNotifyEnabled(true);
      return;
    }
    if (Notification.permission === "denied") {
      alert(
        "ブラウザの通知権限がブロックされています。サイト設定から許可してください。"
      );
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setNotifyEnabled(true);
    }
  }, [notifyEnabled]);

  // 別タブ／別ウィンドウから戻ってきたときに、今見ているアクティブタブの「未確認」を解除する
  // （busy -> idle の遷移が起きても、そのとき見ていなければ点いたままにしたいので session_list 側では消さない）
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (showHomeRef.current) return;
      clearAttention(activeSessionIdRef.current);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [clearAttention]);

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

  // コメント＝送信しない・参照専用。anchor があれば「この箇所」に紐付く、無ければセッション全体メモ。
  const handleAddComment = useCallback(
    (text, anchor = null) => {
      const t = (text || "").trim();
      if (activeSessionId && t) {
        send({ type: "save_comment", sessionId: activeSessionId, sessionKey, text: t, anchor });
      }
    },
    [send, activeSessionId, sessionKey]
  );

  const handleDeleteComment = useCallback(
    (commentId) => {
      if (activeSessionId) {
        send({ type: "delete_comment", sessionId: activeSessionId, sessionKey, commentId });
      }
    },
    [send, activeSessionId, sessionKey]
  );

  // レビュー＝pending review を保存（下書き、送信はしない）
  const handleSaveReview = useCallback(
    (items) => {
      if (activeSessionId) {
        send({ type: "save_review", sessionId: activeSessionId, sessionKey, items });
      }
    },
    [send, activeSessionId, sessionKey]
  );

  // レビュー Submit＝溜めた指摘を一括送信。送信先（PTY/inbox）はサーバーが種別で出し分ける。
  const handleSubmitReview = useCallback(
    (items) => {
      const list = (items ?? reviewItems).filter((it) => (it.text || "").trim());
      if (!activeSessionId || list.length === 0) return;
      send({ type: "submit_review", sessionId: activeSessionId, sessionKey, items: list });
    },
    [send, activeSessionId, sessionKey, reviewItems]
  );

  // 範囲選択 → レビューに追加。選択箇所を anchor（対象）に、本文（指摘）は別に書いて渡す。
  const handleAddAnchoredReview = useCallback(
    ({ anchor, text }) => {
      const t = (text || "").trim();
      if (!activeSessionId || !t) return;
      const next = [...reviewItems, { id: `r-${Date.now()}`, text: t, anchor: anchor || null }];
      setReviewItems(next);
      send({ type: "save_review", sessionId: activeSessionId, sessionKey, items: next });
      setShowReviewPanel(true);
    },
    [send, activeSessionId, sessionKey, reviewItems]
  );

  // 範囲選択 → コメントに残す。選択箇所を anchor に、本文は別に書いて保存（送信しない）。
  const handleAddAnchoredComment = useCallback(
    ({ anchor, text }) => {
      handleAddComment(text, anchor || null);
      setShowCommentPanel(true);
    },
    [handleAddComment]
  );

  // コメント一覧 → コメントした箇所へ移動。メッセージ＝該当メッセージへスクロール、
  // ファイル＝そのファイルのプレビューを開く。
  const handleJumpToAnchor = useCallback((anchor) => {
    if (!anchor) return;
    if (anchor.type === "message" && anchor.messageUuid) {
      setJumpToUuid(anchor.messageUuid);
    } else if (anchor.type === "file" && anchor.filePath) {
      setPreviewData({ filePath: anchor.filePath });
      setDrawerOpenedAt((messagesBySession[activeSessionId] || []).length);
    }
  }, [messagesBySession, activeSessionId]);

  const unresolvedCount = threads.filter((t) => !t.resolved).length;

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // 表示メッセージは唯一の真実 messagesBySession から activeSessionId で派生させる
  const messages = (activeSessionId && messagesBySession[activeSessionId]) || [];
  // 閲覧専用セッションは JSONL を読むだけ。chat 固定でコメントは付けられるが送信はしない
  const isReadonly = activeSession?.type === "readonly";
  const effectiveViewMode = isReadonly ? "chat" : viewMode;
  // ホーム表示中はセッション固有の UI（ビュー切替・スレッド/レビュー/メモ・入力欄）を出さない
  const sessionUiVisible = !showHome && !!activeSessionId;
  const chatPanelsVisible = sessionUiVisible && effectiveViewMode === "chat";
  // 選択肢カードは今見ているセッションのものだけ。readonly は PTY が無いので操作できない
  const activeChoice =
    sessionUiVisible && !isReadonly ? choicePrompts[activeSessionId] : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Claude Bridge</h1>
        <div className="header-controls">
          {sessionUiVisible && !isReadonly && (
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
          {chatPanelsVisible && (
            <>
              <button
                className={`toggle-btn thread-toggle ${showReviewPanel ? "active" : ""}`}
                onClick={() => setShowReviewPanel(!showReviewPanel)}
                title="レビュー（指摘を溜めて Submit で一括送信）"
              >
                Review
                {reviewItems.filter((it) => (it.text || "").trim()).length > 0 && (
                  <span className="thread-count-badge">
                    {reviewItems.filter((it) => (it.text || "").trim()).length}
                  </span>
                )}
              </button>
              <button
                className={`toggle-btn thread-toggle ${showCommentPanel ? "active" : ""}`}
                onClick={() => setShowCommentPanel(!showCommentPanel)}
                title="コメント（送信せずセッションに残す・参照専用）"
              >
                Memo
                {comments.length > 0 && (
                  <span className="thread-count-badge">{comments.length}</span>
                )}
              </button>
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
          <button
            className="toggle-btn thread-toggle"
            onClick={() =>
              setAppTheme((t) => (t === "light" ? "dark" : "light"))
            }
            title="アプリ全体のテーマを切り替え（ライト/ダーク）"
          >
            {appTheme === "light" ? "Dark" : "Light"}
          </button>
          {"Notification" in window && (
            <button
              className={`toggle-btn thread-toggle ${notifyEnabled ? "active" : ""}`}
              onClick={handleToggleNotify}
              title="ターン完了時のデスクトップ通知を ON/OFF"
            >
              {notifyEnabled ? "🔔" : "🔕"}
            </button>
          )}
          <RateLimitMeter rateLimits={rateLimits} />
          <div className="connection-status">
            <span
              className={`status-dot ${connected ? "connected" : "disconnected"}`}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </header>

      <div className="app-body">
        <SessionTabs
          sessions={sessions}
          activeSessionId={showHome ? null : activeSessionId}
          homeActive={showHome}
          attentionIds={attentionIds}
          onHome={() => setShowHome(true)}
          onSelect={handleSwitchSession}
          onKill={handleKillSession}
          onRestart={handleRestartSession}
          onRemovePast={handleRemovePastSession}
          onDetachTmux={handleDetachTmux}
          onCloseReadonly={handleCloseReadonly}
          onNew={() => setShowNewSession(true)}
        />

        <div className="app-workspace">
          <div className="app-content">
            {showFileExplorer && sessionUiVisible && (
              <FileExplorer
                cwd={sessions.find((s) => s.id === activeSessionId)?.cwd}
                onOpenPreview={(path) => {
                  setPreviewData({ filePath: path });
                  setDrawerOpenedAt(messages.length);
                }}
              />
            )}
            <main className="app-main">
              {showHome ? (
                <HomeView
                  runningSessions={runningSessions}
                  recentSessions={recentSessions}
                  recentDays={recentDays}
                  onChangeRecentDays={setRecentDays}
                  starred={starredSessions}
                  onToggleStar={handleToggleStar}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  loading={runningSessions === null}
                  recentLoading={recentSessions === null}
                  error={homeError}
                  onDismissError={() => setHomeError(null)}
                  onRefresh={() => {
                    setHomeError(null);
                    send({ type: "list_running_sessions" });
                    send({
                      type: "list_recent_sessions",
                      days: recentDays,
                      starred: starredSessions,
                    });
                  }}
                  onSelectTab={handleSwitchSession}
                  onAttachTmux={handleAttachTmux}
                  onOpenReadonly={handleOpenReadonly}
                  onResume={handleResumeSession}
                  onResumeInTmux={handleResumeInTmux}
                  onNew={() => setShowNewSession(true)}
                />
              ) : activeSessionId ? (
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
                    onAddAnchoredReview={handleAddAnchoredReview}
                    onAddAnchoredComment={handleAddAnchoredComment}
                    onDeleteComment={handleDeleteComment}
                    jumpToUuid={jumpToUuid}
                    onJumpDone={() => setJumpToUuid(null)}
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

            {showThreadPanel && chatPanelsVisible && (
              <ThreadPanel
                threads={threads}
                onReplyBatch={handleThreadReplyBatch}
                onResolve={handleResolveThread}
                onDelete={handleDeleteThread}
              />
            )}
            {showReviewPanel && chatPanelsVisible && (
              <ReviewDraftPanel
                items={reviewItems}
                readonly={isReadonly}
                onSave={handleSaveReview}
                onSubmit={handleSubmitReview}
                onClose={() => setShowReviewPanel(false)}
              />
            )}
            {showCommentPanel && chatPanelsVisible && (
              <CommentPanel
                comments={comments}
                onAdd={handleAddComment}
                onDelete={handleDeleteComment}
                onJump={handleJumpToAnchor}
                onClose={() => setShowCommentPanel(false)}
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

          {sessionUiVisible && (
            <TaskStrip
              tasks={subagentTasks[activeSessionId] || []}
              onOpenTask={handleOpenSubagentTask}
            />
          )}

          {activeChoice && (
            <ChoicePrompt
              prompt={activeChoice.prompt}
              waitingFor={activeChoice.waitingFor}
              error={choiceError}
              onAnswer={handleAnswerChoice}
              onRefresh={handleRefreshChoice}
            />
          )}

          {showHome ? null : isReadonly ? (
            <InputBar
              key={activeSessionId}
              draftKey={activeSessionId}
              onSubmit={handleSendToReadonly}
              disabled={!activeSession?.claudeSessionId}
              placeholder="このセッションに送信（claude-bridge → inbox 経由）..."
            />
          ) : (
            <InputBar
              key={activeSessionId}
              draftKey={activeSessionId}
              onSubmit={handleInput}
              disabled={!activeSessionId}
            />
          )}
        </div>
      </div>

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

      {subagentDrawer && (
        <SubagentDrawer
          agentId={subagentDrawer.agentId}
          description={subagentDrawer.description}
          agentType={subagentDrawer.agentType}
          status={subagentDrawer.status}
          messages={subagentDrawer.messages}
          onRequestTranscript={handleRequestTranscript}
          onOpenPreview={(path) => {
            setPreviewData({ filePath: path });
            setDrawerOpenedAt(messages.length);
          }}
          onClose={() => setSubagentDrawer(null)}
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
            // ファイルレビューもセッションのレビューと同じ submit_review 経由で送る。
            // サーバーが対象セッション種別で PTY/inbox を出し分けるため readonly でも届く。
            // 各項目にファイル名を前置して文脈を残す。
            const fileName = target.split("/").pop();
            const labeled = items
              .map((t) => (t || "").trim())
              .filter(Boolean)
              .map((t) => ({ text: `${fileName}: ${t}` }));
            if (labeled.length === 0) return;
            send({
              type: "submit_review",
              sessionId: activeSessionId,
              sessionKey,
              items: labeled,
            });
          }}
          onSaveComment={(note, location) => {
            // プレビューで「コメントに残す」: 送信せずセッションのコメントに保存（ファイルアンカー付き）
            if (!activeSessionId) return;
            const t = (note || "").trim();
            if (!t) return;
            handleAddComment(t, {
              type: "file",
              filePath: previewData.filePath || null,
              quote: location?.selectedText || "",
              label: location?.label || null,
              line: location?.line ?? null,
            });
          }}
          onDeleteComment={handleDeleteComment}
          fileComments={
            previewData.filePath
              ? comments.filter(
                  (c) =>
                    c.anchor?.type === "file" &&
                    c.anchor.filePath === previewData.filePath
                )
              : []
          }
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
