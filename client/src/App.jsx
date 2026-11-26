import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useGlobalKeys } from './hooks/useGlobalKeys.js';
import SessionTabs from './components/SessionTabs.jsx';
import TerminalView from './components/TerminalView.jsx';
import ChatView from './components/ChatView.jsx';
import ReviewDraftPanel from './components/ReviewDraftPanel.jsx';
import InputBar from './components/InputBar.jsx';
import ChoicePrompt from './components/ChoicePrompt.jsx';
import TaskStrip from './components/TaskStrip.jsx';
import WorkingIndicator from './components/WorkingIndicator.jsx';
import { activeChoiceOf, clearObservedPending } from './utils/working.js';
import SubagentDrawer from './components/SubagentDrawer.jsx';
import ShellOutputDrawer from './components/ShellOutputDrawer.jsx';
import DiffDrawer from './components/DiffDrawer.jsx';
import DiffPip from './components/DiffPip.jsx';
import {
  DIFF_SCOPE_STORAGE_KEY,
  isDiffCommand,
  isRefScope,
  isSameDiffRequest,
  normalizeDiffRef,
  normalizeDiffScope,
} from './utils/diffView.js';
import { diffCommentStore } from './utils/diffComments.js';
import { loadReviewed, migrateReviewed, saveReviewed } from './utils/diffReviewed.js';
import RefDrawer from './components/RefDrawer.jsx';
import NewSessionDialog from './components/NewSessionDialog.jsx';
import PreviewDrawer from './components/PreviewDrawer.jsx';
import PreviewPip, { isDocumentPipSupported, openPreviewPipWindow } from './components/PreviewPip.jsx';
import FileExplorer from './components/FileExplorer.jsx';
import HomeView from './components/HomeView.jsx';
import TopBar from './components/TopBar.jsx';
import { loadStarred, saveStarred, toggleStarred } from './utils/starredSessions.js';
import { applyTabOrder, loadTabOrder, moveTab, saveTabOrder } from './utils/tabOrder.js';
import {
  assignTabToGroup,
  buildTabGroups,
  createGroup,
  deleteGroup,
  dirColorOf,
  flattenTabGroups,
  groupColorMap,
  setGroupColor,
  loadTabGroups,
  renameGroup,
  saveTabGroups,
  shownTabGroups,
  toggleGroupCollapsed,
  visibleTabsOf,
} from './utils/tabGroups.js';
import { periodEquals } from './utils/heatmap.js';
import {
  loadSensitive,
  saveSensitive,
  toggleSensitive,
  loadShareMode,
  saveShareMode,
  countHiddenSensitive,
} from './utils/sensitiveSessions.js';
import { statusMapOf, updateAttention } from './utils/attention.js';
import { pickNotifyTargets } from './utils/notifications.js';
import { latestContextUsage } from './utils/contextUsage.js';
import { collectLinks } from './utils/links.js';
import { collectSessionFiles } from './utils/sessionFiles.js';
import { pinExcerpt } from './utils/pins.js';
import { humanSenderLabel } from './utils/messageSender.js';
import { TbBookmarks, TbChecklist, TbFiles } from 'react-icons/tb';
import './App.css';
import { readonlyDeliveryState, terminateConfirmMessage } from './utils/runningSessions.js';

// ホーム表示中に起動中セッション一覧を取り直す間隔（status/新規起動の反映用）
const RUNNING_POLL_INTERVAL = 5000;
// 作業中タブでサブエージェントのタスク一覧を取り直す間隔
const SUBAGENT_POLL_INTERVAL = 5000;
// 作業中タブで実行中シェル（Bash 出力）の一覧を取り直す間隔
const SHELL_POLL_INTERVAL = 3000;
// 一覧が空のときに毎レンダー新しい [] を渡すと子の memo 比較が外れるので共有の空配列を使う
const EMPTY_TASKS = [];

// ポーリングで届いた一覧が前回と同じ内容なら、state の参照を変えずに返す。
// 参照が変わると App が再描画され、ChatView の memo 化されたメッセージまで作り直されてチラつく。
// 一覧は数十件のフラットな配列なので JSON.stringify の比較で十分安い。
function keepIfUnchanged(prev, sessionId, tasks) {
  const next = tasks || EMPTY_TASKS;
  const current = prev[sessionId];
  if (current && JSON.stringify(current) === JSON.stringify(next)) return prev;
  return { ...prev, [sessionId]: next };
}

// 差分ドロワーの範囲（保存値）
function storedDiffScope() {
  try {
    return normalizeDiffScope(localStorage.getItem(DIFF_SCOPE_STORAGE_KEY));
  } catch {
    // localStorage が使えない環境は既定の範囲
    return 'all';
  }
}

export default function App() {
  const { send, on, connected } = useWebSocket();
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  const [activeSessionId, setActiveSessionId] = useState(() => localStorage.getItem('activeSessionId') || null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [viewMode, setViewMode] = useState('chat');
  // ホーム画面（起動中の Claude セッション一覧）。タブとは独立した表示モードで、
  // activeSessionId は保持したまま切り替える（Home ⇄ 作業中タブを行き来できる）。
  const [showHome, setShowHome] = useState(() => localStorage.getItem('showHome') !== 'false');
  // ターン完了時のデスクトップ通知（Notification API）の ON/OFF。localStorage で記憶。
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem('desktopNotify') === 'true');
  // サーバーが返す「今このマシンで起動中の Claude セッション」。null = 未取得
  const [runningSessions, setRunningSessions] = useState(null);
  // ホームの「直近のセッション」（終了済みを含む JSONL 由来）。null = 未取得
  const [recentSessions, setRecentSessions] = useState(null);
  const [recentDays, setRecentDays] = useState(() => Number(localStorage.getItem('homeRecentDays')) || 7);
  // `claude -p`（スケジュール実行など）のセッションを直近一覧に含めるか。既定は含めない
  const [includeHeadless, setIncludeHeadless] = useState(() => localStorage.getItem('homeIncludeHeadless') === '1');
  const includeHeadlessRef = useRef(includeHeadless);
  includeHeadlessRef.current = includeHeadless;
  // 活動グラフの棒・升目で選んだ期間 {from, to, label}。その場限りの絞り込みなので保存しない
  const [recentPeriod, setRecentPeriod] = useState(null);
  const recentPeriodRef = useRef(recentPeriod);
  recentPeriodRef.current = recentPeriod;
  // ホームの活動ヒートマップ（草）。null = 未取得
  const [heatmap, setHeatmap] = useState(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [calendar, setCalendar] = useState(null);
  // ホームの「セッション詳細」に出すターン詳細（開いている 1 件分だけ持つ）
  const [sessionTurns, setSessionTurns] = useState(null);
  // ホームの行の「直近のやりとり」。{[sessionId]: {exchanges, error, updatedAt}}。エントリが無い＝読み込み中
  const [recentExchanges, setRecentExchanges] = useState({});
  const recentExchangesRef = useRef(recentExchanges);
  recentExchangesRef.current = recentExchanges;
  // 取得中のリクエスト。sessionId -> 要求したときの updatedAt（応答には載らないのでここで覚える）
  const recentPendingRef = useRef(new Map());
  const [calendarLoading, setCalendarLoading] = useState(false);
  // 最後に要求した週。週送りを連打したとき、古い週の応答で上書きしないために使う
  const calendarRequestRef = useRef(null);
  // ホーム画面の操作エラー（tmux 再開の失敗など）。チャット欄には出せないのでバナーで見せる
  const [homeError, setHomeError] = useState(null);
  // ホーム画面への情報（worktree が消えていたので元リポジトリで再開した、など）。エラーではない
  const [homeNotice, setHomeNotice] = useState(null);
  // 前回 tmux で動いていたのに今は停止しているセッション（サーバーの restorable_tabs）。{tabs, resuming}
  const [restorable, setRestorable] = useState(null);
  // 接続先サーバーの起動 ID。再接続時に変わっていたら（＝ブリッジが再起動した）手元の会話を捨てて取り直す
  const bootIdRef = useRef(null);
  // JSONL から履歴を取りに行ったタブ（ブリッジ ID）。サーバー再起動で取り直す
  const historyRequestedRef = useRef(new Set());
  // セッションごとの選択肢プロンプト（id -> {prompt, waitingFor}）。
  // JSONL には回答後にしか出ないので、サーバーが画面から読んだものをそのまま持つ。
  const [choicePrompts, setChoicePrompts] = useState({});
  // 送信した時刻（sessionId -> ms）。status が busy になるまでの数秒、推論中表示を先回りで出すため
  const [pendingTurns, setPendingTurns] = useState({});
  const [choiceError, setChoiceError] = useState(null);
  // セッションが起動したサブエージェントのタスク一覧（bridgeSessionId -> tasks）
  const [subagentTasks, setSubagentTasks] = useState({});
  // 実行中／終了済みの Bash 出力の一覧（bridgeSessionId -> tasks）
  const [shellTasks, setShellTasks] = useState({});
  // 入力欄のスラッシュコマンド補完の候補（bridgeSessionId -> commands）。
  // セッションの cwd に依存するのでタブごとに 1 度だけ取る
  const [slashCommands, setSlashCommands] = useState({});
  // トランスクリプトを表示中のサブエージェント（null なら閉じている）
  const [subagentDrawer, setSubagentDrawer] = useState(null);
  // 出力を表示中のシェルタスク（null なら閉じている）
  const [shellDrawer, setShellDrawer] = useState(null);
  // 入力欄の /diff で開く差分ドロワー:
  //   { sessionId, scope, requestedRef, ref, focus, data: {loading} | session_diff の中身, sources }
  // requestedRef は要求したときの ref（null＝最新。応答の照合に使う）、ref は今見ている ref（最新を要求したときは
  // 応答の resolvedRef で埋める）。sources はコミット・ターンの候補（diff_sources）
  const [diffDrawer, setDiffDrawer] = useState(null);
  const diffDrawerRef = useRef(diffDrawer);
  diffDrawerRef.current = diffDrawer;
  // セッション内でやり取りしたリンク・ファイルの一覧のドロワー（Refs）
  const [showRefDrawer, setShowRefDrawer] = useState(false);
  // 「未解決／続きをやる」印を付けた claudeSessionId（localStorage のみ）
  const [starredSessions, setStarredSessions] = useState(loadStarred);
  // 一覧取得時に添えるだけなので、star の変更で再取得は走らせない（JSONL 走査を避ける）
  const starredRef = useRef(starredSessions);
  starredRef.current = starredSessions;
  // 「画面共有中は見せない」印を付けた claudeSessionId（localStorage のみ）
  const [sensitiveSessions, setSensitiveSessions] = useState(loadSensitive);
  // 共有モード。ON の間だけセンシティブ指定を隠す（指定自体は残す）
  const [shareMode, setShareMode] = useState(loadShareMode);
  // タブ側は「隠すかどうか」の判定だけなので Set にして毎タブの includes を避ける
  const sensitiveIds = useMemo(() => new Set(sensitiveSessions), [sensitiveSessions]);
  // Star も同じ理由で Set 化してタブリストに渡す（表示専用。付け外しはホームで行う）
  const starredIds = useMemo(() => new Set(starredSessions), [starredSessions]);
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
  const [appTheme, setAppTheme] = useState(() => localStorage.getItem('appTheme') || 'dark');
  // セッションごとのメッセージを一元管理する唯一の真実（id -> message[]）。
  // 表示用の messages はここから activeSessionId で派生させる（単一 messages state や
  // messageCache の二重管理をやめ、active と表示内容のズレ＝混線を構造的に防ぐ）。
  const [messagesBySession, setMessagesBySession] = useState({});
  // ピン留めしたメッセージ（サーバーの pins-<sessionKey>.json）
  const [pins, setPins] = useState([]);
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
  // 通知を伏せるかの判定用（session_list のハンドラは初回に 1 度だけ登録されるので ref で最新を読む）
  const shareModeRef = useRef(shareMode);
  shareModeRef.current = shareMode;
  const sensitiveIdsRef = useRef(sensitiveIds);
  sensitiveIdsRef.current = sensitiveIds;
  useEffect(() => {
    notifyEnabledRef.current = notifyEnabled;
  }, [notifyEnabled]);
  // 指定セッションのメッセージだけを更新する（active かどうかは見ない）。
  // updater は配列、または (prev[]) => next[] の関数。
  const updateSessionMessages = useCallback((sessionId, updater) => {
    if (!sessionId) return;
    setMessagesBySession((prev) => {
      const cur = prev[sessionId] || [];
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...prev, [sessionId]: next };
    });
  }, []);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  // 数字キーで選んだメッセージを、レビューパネルの下書きに引用として渡すための箱
  // （同じメッセージを続けて選べるよう nonce で更新を伝える）
  const [incomingAnchor, setIncomingAnchor] = useState(null);
  // Refs ドロワーなどから本文へスクロールする際の対象メッセージ uuid
  const [jumpToUuid, setJumpToUuid] = useState(null);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [claudeSessions, setClaudeSessions] = useState(null);
  // 新規作成ダイアログで session ID を打ったときの検索結果（{query, sessions}）
  const [foundClaudeSessions, setFoundClaudeSessions] = useState(null);
  const [tmuxPanes, setTmuxPanes] = useState(null);
  // 新規作成ダイアログの作業ディレクトリ候補（直近 90 日のセッションの cwd）
  const [recentDirs, setRecentDirs] = useState(null);
  const [newSessionError, setNewSessionError] = useState(null);
  // 検証で弾かれて開き直すときに入力を戻すため、最後に送った値を持つ
  const [newSessionDraft, setNewSessionDraft] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [drawerOpenedAt, setDrawerOpenedAt] = useState(null);
  // Document Picture-in-Picture に出したプレビュー { pipWindow, filePath, markdown, title }。
  // previewData とは別に持ち、activeSessionId / showHome に依存させない（他セッションへ移っても残す）
  const [pipPreview, setPipPreview] = useState(null);
  // 差分ドロワーを小窓に移したもの: { id, pipWindow, sessionId, openedKey, scope, data }。
  // diffDrawer とは別に持ち、タブ切替・ホーム表示でも閉じない。小窓はタブにつき 1 つなので pipPreview とは同時に存在しない
  // （後から開いた方が残り、前の窓の pagehide で自分の state だけを消す）
  const [pipDiff, setPipDiff] = useState(null);
  // Claude のレート制限（5h/7d ウィンドウの使用率）。サーバーが 3 分間隔で配ってくる
  const [rateLimits, setRateLimits] = useState(null);

  // ピン/レビューの保存・取得キー。claudeSessionId を優先し（再オープン/resume/閲覧
  // をまたいで同じ Claude セッションを参照するため）、無ければブリッジ ID。
  const sessionKey = sessions.find((s) => s.id === activeSessionId)?.claudeSessionId || activeSessionId;

  // アプリ全体テーマを body のクラスに反映し localStorage に記憶する。
  // light のとき body.light-mode が付き、index.css の var() がライト配色へ切り替わる。
  useEffect(() => {
    document.body.classList.toggle('light-mode', appTheme === 'light');
    localStorage.setItem('appTheme', appTheme);
  }, [appTheme]);

  useEffect(() => {
    return on('session_list', (msg) => {
      setSessions(msg.sessions);
      sessionsRef.current = msg.sessions;
      // busy（か待ち）を観測したら先回り表示を消し、以後は status に任せる
      setPendingTurns((prev) => clearObservedPending(prev, msg.sessions));
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
        }),
      );
      // デスクトップ通知: タブが見えていないときだけ（見えていればタブ装飾で分かる）
      if (
        notifyEnabledRef.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.hidden
      ) {
        for (const s of pickNotifyTargets({
          prev: prevStatuses,
          sessions: msg.sessions,
        })) {
          // 通知は OS の画面端に出て画面共有の相手にも見えるので、共有モード中のセンシティブ指定は名前を伏せる
          const masked = shareModeRef.current && s.claudeSessionId && sensitiveIdsRef.current.has(s.claudeSessionId);
          const n = new Notification(masked ? 'Claude Bridge' : s.name || 'Claude Bridge', {
            body: masked ? 'セッションの応答が完了しました' : 'ターンが完了しました',
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
      const currentAlive = aliveSessions.find((s) => s.id === activeSessionIdRef.current);
      if (!currentAlive) {
        setActiveSessionId(aliveSessions[aliveSessions.length - 1].id);
      }
    });
  }, [on]);

  // サーバーが「今開いた/接続したセッション」を通知する。末尾推定をやめ、
  // これを唯一の active 切り替えトリガーにすることで取り違えを防ぐ。
  useEffect(() => {
    return on('session_opened', (msg) => {
      if (msg.bridgeSessionId) {
        setActiveSessionId(msg.bridgeSessionId);
        // 開いたセッションを見せたいのでホームからは抜ける
        setShowHome(false);
        clearAttention(msg.bridgeSessionId);
      }
    });
  }, [on, clearAttention]);

  useEffect(() => {
    return on('session_exited', (msg) => {
      setSessions((prev) => prev.map((s) => (s.id === msg.sessionId ? { ...s, alive: false } : s)));
    });
  }, [on]);

  // エラー通知（現在アクティブなセッションのメッセージ列に system として追加）
  useEffect(() => {
    return on('error', (msg) => {
      updateSessionMessages(activeSessionIdRef.current, (prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: 'system',
          content: msg.message,
          timestamp: new Date().toISOString(),
        },
      ]);
    });
  }, [on, updateSessionMessages]);

  // ホーム画面の操作エラー（tmux window 作成の失敗など）
  useEffect(() => {
    return on('home_error', (msg) => setHomeError(msg.message));
  }, [on]);

  useEffect(() => {
    return on('home_notice', (msg) => setHomeNotice(msg.message));
  }, [on]);

  useEffect(() => {
    return on('restorable_tabs', (msg) => setRestorable({ tabs: msg.tabs || [], resuming: Boolean(msg.resuming) }));
  }, [on]);

  // ブリッジが再起動していたら、停止中に進んだ分は JSONL 監視（新着のみ）では届かないので会話を取り直す。
  // messagesBySession を空にすれば、アクティブタブは既存の「未取得なら JSONL から復元」の経路で読み直される
  useEffect(() => {
    return on('server_hello', (msg) => {
      const prev = bootIdRef.current;
      bootIdRef.current = msg.bootId;
      if (prev && prev !== msg.bootId) {
        historyRequestedRef.current.clear();
        setMessagesBySession({});
      }
    });
  }, [on]);

  // TUI に出ている選択肢プロンプト（AskUserQuestion / ツール許可 / trust 確認）。
  // サーバーが待ち状態のセッションの画面を読んで送ってくる。prompt が null なら待ちではない。
  useEffect(() => {
    return on('choice_prompt', (msg) => {
      setChoicePrompts((prev) => ({
        ...prev,
        [msg.sessionId]: { prompt: msg.prompt, waitingFor: msg.waitingFor },
      }));
      setChoiceError(null);
    });
  }, [on]);

  useEffect(() => {
    return on('choice_prompt_error', (msg) => setChoiceError(msg.message));
  }, [on]);

  // サブエージェント（Agent ツール）の一覧。JSONL のファイル読みなので readonly でも来る。
  // 数秒ごとのポーリングで毎回新しい配列を state に入れると App 全体が再描画され、
  // ChatView の memo が崩れて本文がチラつくので、内容が同じなら前の参照を保つ
  useEffect(() => {
    return on('subagent_tasks', (msg) => {
      setSubagentTasks((prev) => keepIfUnchanged(prev, msg.sessionId, msg.tasks));
    });
  }, [on]);

  // 実行中／終了済みの Bash 出力の一覧。こちらもファイル読みなので readonly でも来る
  useEffect(() => {
    return on('shell_tasks', (msg) => {
      setShellTasks((prev) => keepIfUnchanged(prev, msg.sessionId, msg.tasks));
    });
  }, [on]);

  // ドロワーで開いているシェルの出力。別の taskId のものは捨てる。
  // 前景の Bash は終了すると出力ファイルごと消える（status: null + error で返る）ので、
  // そのときは最後に読めた本文を残したまま 'gone' にしてポーリングを止める
  useEffect(() => {
    return on('shell_task_output', (msg) => {
      setShellDrawer((prev) => {
        if (!prev || prev.taskId !== msg.taskId) return prev;
        if (msg.status === null || msg.status === undefined) {
          return prev.status === 'running' ? { ...prev, status: 'gone' } : prev;
        }
        return {
          ...prev,
          text: msg.text || '',
          truncated: !!msg.truncated,
          status: msg.status,
          exitCode: msg.exitCode ?? prev.exitCode,
        };
      });
    });
  }, [on]);

  // 差分ドロワー（メインと小窓）の中身。それぞれ開いているセッション・範囲と違う応答（範囲の切り替え直後の古い応答・
  // もう片方が要求したもの）は捨てる。両方が同じセッション・範囲を開いていれば両方に入るが、中身は同じなので構わない
  // 照合は (sessionId, scope, 要求した ref)。コミット・ターンの連続切り替えで古い応答が後から届いても捨てる
  useEffect(() => {
    const apply = (prev, msg) =>
      !isSameDiffRequest(prev, msg) ? prev : { ...prev, ref: prev.ref ?? msg.resolvedRef ?? null, data: msg };
    return on('session_diff', (msg) => {
      setDiffDrawer((prev) => apply(prev, msg));
      setPipDiff((prev) => apply(prev, msg));
    });
  }, [on]);

  // コミット・ターンの候補。開いているセッションのものだけ入れる
  useEffect(() => {
    const apply = (prev, msg) => (!prev || prev.sessionId !== msg.sessionId ? prev : { ...prev, sources: msg });
    return on('diff_sources', (msg) => {
      setDiffDrawer((prev) => apply(prev, msg));
      setPipDiff((prev) => apply(prev, msg));
    });
  }, [on]);

  // 入力欄の補完候補（スキル・コマンド・組み込み）
  useEffect(() => {
    return on('slash_commands', (msg) => {
      setSlashCommands((prev) => ({ ...prev, [msg.sessionId]: msg.commands || [] }));
    });
  }, [on]);

  // ドロワーで開いているサブエージェントの会話。別の agent のものは捨てる
  useEffect(() => {
    return on('subagent_transcript', (msg) => {
      setSubagentDrawer((prev) =>
        prev && prev.agentId === msg.agentId
          ? { ...prev, messages: msg.messages || [], status: msg.status ?? prev.status }
          : prev,
      );
    });
  }, [on]);

  // JSONL ベースの chat_message を受信。
  // active かどうかは見ず、必ず bridgeSessionId のメッセージ列に積む（混線防止）。
  // human は addUserMessage で先行追加されている場合があるため重複チェック。
  useEffect(() => {
    return on('chat_message', (msg) => {
      const session = sessionsRef.current.find((s) => s.id === msg.bridgeSessionId);
      const isTmux = session?.type === 'tmux';
      // artifact（公開リンク）と webfetch（WebFetch の結果。リンク一覧のタイトル用）はセッション種別を問わず受ける
      // toolresult（ツールの失敗・新規作成。チャットのツール行の印用）も同じく種別を問わず受ける
      const isLinkRecord = msg.role === 'artifact' || msg.role === 'webfetch' || msg.role === 'toolresult';
      // thinking は Claude の途中経過（TUI で「· summary」付きで薄く出るもの）、hookerror はツールに紐づかないフックの失敗
      // recap は離席から戻ったときの要約（TUI の「※ recap」）
      const isNote = msg.role === 'thinking' || msg.role === 'hookerror' || msg.role === 'task' || msg.role === 'recap';
      if (!(msg.role === 'assistant' || isNote || isLinkRecord || (isTmux && msg.role === 'human'))) return;

      const newMsg = {
        id: `jsonl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        // JSONL の uuid を安定アンカーとして保持（ピン/レビューの位置紐付け用）
        uuid: msg.uuid || null,
        role: msg.role,
        content: msg.content,
        toolUses: msg.toolUses,
        // コンテキスト使用量（usage のある assistant にだけ入る）
        contextUsage: msg.contextUsage,
        // Artifact の公開先（role: 'artifact'）と WebFetch で読んだ URL（role: 'webfetch'）
        url: msg.url,
        title: msg.title,
        path: msg.path,
        // WebFetch の HTTP ステータス（role: 'webfetch' のときだけ入る）
        code: msg.code,
        // ツールの結果の印 [{id, error?, created?, hookError?}]（role: 'toolresult' のときだけ入る）
        results: msg.results,
        // フックの失敗 {name, exitCode, command, detail}（role: 'hookerror' のときだけ入る）
        hook: msg.hook,
        // タスク通知の中身 [{taskId, status, summary, …}]（role: 'task' のときだけ入る）
        tasks: msg.tasks,
        // タグ注入・isMeta の user レコード（人が打っていない）。リンク一覧の origin 判定用
        injected: msg.injected,
        // 人が打っていない human の送り手（サブエージェントの報告・タスク通知など）。チャットの見出し用
        sender: msg.sender,
        timestamp: msg.timestamp || new Date().toISOString(),
      };

      updateSessionMessages(msg.bridgeSessionId, (prev) => {
        if (msg.role === 'human' && prev.some((m) => m.role === 'human' && m.content === msg.content)) {
          return prev;
        }
        return [...prev, newMsg];
      });
    });
  }, [on, updateSessionMessages]);

  useEffect(() => {
    return on('pins_update', (msg) => {
      if (msg.sessionId === activeSessionId) {
        setPins(msg.pins);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on('review_update', (msg) => {
      if (msg.sessionId === activeSessionId) {
        setReviewItems(msg.items || []);
      }
    });
  }, [on, activeSessionId]);

  useEffect(() => {
    return on('claude_sessions', (msg) => {
      setClaudeSessions(msg.sessions);
    });
  }, [on]);

  useEffect(() => {
    return on('claude_sessions_found', (msg) => {
      setFoundClaudeSessions({ query: msg.query, sessions: msg.sessions || [] });
    });
  }, [on]);

  useEffect(() => {
    return on('tmux_panes', (msg) => {
      setTmuxPanes(msg.panes);
    });
  }, [on]);

  useEffect(() => {
    return on('recent_dirs', (msg) => {
      setRecentDirs({ home: msg.home || '', dirs: msg.dirs || [] });
    });
  }, [on]);

  useEffect(() => {
    return on('new_session_error', (msg) => {
      // 起動前の検証で弾かれた。ダイアログを開き直して理由を見せる
      setNewSessionError(msg.message);
      setShowNewSession(true);
    });
  }, [on]);

  useEffect(() => {
    return on('running_sessions', (msg) => {
      // 閲覧タブを見ている間も 5 秒ごとに届くので、同じ内容なら前の参照を保って App の再描画を避ける
      const next = msg.sessions || [];
      setRunningSessions((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    });
  }, [on]);

  useEffect(() => {
    return on('recent_sessions', (msg) => {
      // 期間付きの応答は listActiveSessionIds の走査を待つぶん遅く、その間に × や
      // プリセットで解除された「期間なし」の応答に追い越されることがある。
      // サーバーがエコーする period と今の選択が食い違う応答は捨てる
      const current = recentPeriodRef.current;
      const echoed = msg.period || null;
      if (!!echoed !== !!current || (echoed && !periodEquals(echoed, current))) return;
      // `claude -p` を除外する要求は先頭行の読み込みを待つぶん遅く、トグル直後の
      // 「含める」応答を追い越して上書きし得るので、こちらも食い違う応答は捨てる
      if (!!msg.includeHeadless !== includeHeadlessRef.current) return;
      setRecentSessions(msg.sessions || []);
    });
  }, [on]);

  useEffect(() => {
    return on('activity_heatmap', (msg) => {
      setHeatmap({ days: msg.days || [], total: msg.total, generatedAt: msg.generatedAt });
      setHeatmapLoading(false);
    });
  }, [on]);

  useEffect(() => {
    return on('session_turns', (msg) => {
      setSessionTurns({ sessionId: msg.sessionId, turns: msg.turns, totals: msg.totals, error: msg.error });
    });
  }, [on]);

  useEffect(() => {
    return on('session_recent', (msg) => {
      if (!msg.sessionId) return;
      const pending = recentPendingRef.current;
      const updatedAt = pending.get(msg.sessionId);
      pending.delete(msg.sessionId);
      setRecentExchanges((prev) => ({
        ...prev,
        [msg.sessionId]: { exchanges: msg.exchanges || [], error: msg.error, updatedAt },
      }));
    });
  }, [on]);

  useEffect(() => {
    return on('activity_calendar', (msg) => {
      if (msg.fromMs !== calendarRequestRef.current) return;
      setCalendar({ fromMs: msg.fromMs, toMs: msg.toMs, slotMs: msg.slotMs, sessions: msg.sessions || [] });
      setCalendarLoading(false);
    });
  }, [on]);

  // 集計に失敗しても loading を出しっぱなしにしない
  useEffect(() => {
    return on('home_error', () => {
      setHeatmapLoading(false);
      setCalendarLoading(false);
    });
  }, [on]);

  useEffect(() => {
    return on('rate_limits', (msg) => setRateLimits({ usage: msg.usage, fetchedAt: msg.fetchedAt }));
  }, [on]);

  // ホーム表示中と、閲覧タブを見ている間だけポーリングする（裏では取りに行かない）。
  // 閲覧タブでは「tmux ペインで起動中か」を送信欄の注意書きに使う
  const watchingReadonly = !showHome && sessions.some((s) => s.id === activeSessionId && s.type === 'readonly');
  useEffect(() => {
    if ((!showHome && !watchingReadonly) || !connected) return;
    send({ type: 'list_running_sessions' });
    const timer = setInterval(() => send({ type: 'list_running_sessions' }), RUNNING_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [showHome, watchingReadonly, connected, send]);

  // 作業中タブを見ている間だけサブエージェントの一覧を取り直す（タブ切替時は即時 1 回）
  useEffect(() => {
    if (showHome || !activeSessionId || !connected) return;
    const request = () => send({ type: 'list_subagent_tasks', sessionId: activeSessionId });
    request();
    const timer = setInterval(request, SUBAGENT_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [showHome, activeSessionId, connected, send]);

  // 実行中シェルの一覧も作業中タブを見ている間だけ取り直す（TUI のライブ表示に相当）
  useEffect(() => {
    if (showHome || !activeSessionId || !connected) return;
    const request = () => send({ type: 'list_shell_tasks', sessionId: activeSessionId });
    request();
    const timer = setInterval(request, SHELL_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [showHome, activeSessionId, connected, send]);

  // 補完候補はセッションごとに 1 度だけ取る（サーバー側で 30 秒キャッシュされる）。
  // 取得済みかは ref で見て、候補の到着で effect が回らないようにする
  const slashRequestedRef = useRef(new Set());
  // 切断時に取得済みの印を捨てる（応答が届く前に切れたセッションを取り直すため）
  useEffect(() => {
    if (!connected) slashRequestedRef.current.clear();
  }, [connected]);
  useEffect(() => {
    if (showHome || !activeSessionId || !connected) return;
    if (slashRequestedRef.current.has(activeSessionId)) return;
    slashRequestedRef.current.add(activeSessionId);
    send({ type: 'list_slash_commands', sessionId: activeSessionId });
  }, [showHome, activeSessionId, connected, send]);

  // 別セッションのタスクを見せ続けないよう、タブ切替・ホーム表示でドロワーを閉じる
  useEffect(() => {
    setSubagentDrawer(null);
    setShellDrawer(null);
    setDiffDrawer(null);
    setShowRefDrawer(false);
  }, [activeSessionId, showHome]);

  // focus: 差分が届いた後にスクロールして見せる行（{path, side, line, nonce}）。openDiffAt から渡す。
  // ref: コミット・ターンの対象（null＝最新）。コミット・ターンの候補は、同じセッションで取得済みなら使い回し、
  // refreshSources（取り直す）なら取り直す
  const requestDiff = useCallback(
    (sessionId, scope, focus = null, ref = null, { refreshSources = false } = {}) => {
      const r = normalizeDiffRef(scope, ref);
      const prev = diffDrawerRef.current;
      const keep = prev?.sessionId === sessionId && prev.sources && !refreshSources ? prev.sources : null;
      const needSources = isRefScope(scope) && (!keep || keep.error);
      setDiffDrawer({
        sessionId,
        scope,
        requestedRef: r,
        ref: r,
        focus,
        data: { loading: true },
        sources: needSources ? { loading: true } : keep,
      });
      send({ type: 'get_session_diff', sessionId, scope, ref: r });
      if (needSources) send({ type: 'get_diff_sources', sessionId });
    },
    [send],
  );

  // ブリッジが横取りするコマンド（Claude には送らない）。処理したら true
  const handleLocalCommand = useCallback(
    (text) => {
      if (!isDiffCommand(text) || !activeSessionId) return false;
      requestDiff(activeSessionId, storedDiffScope());
      return true;
    },
    [activeSessionId, requestDiff],
  );

  // 指定したファイル・行（側つき）で差分ドロワーを開き、届いたらそこへスクロールする。
  // path はリポジトリ相対、side は 'new'（追加・文脈行の新しい行番号）| 'old'（削除行の旧行番号）。
  // 今は UI から呼ばず、window.claudeBridge.openDiffAt として出しておく（Claude から差分へ誘導する段階で使う）
  // scope が 'commit' / 'turn' のときは ref（ハッシュ／ターン番号。省けば最新）で対象を選ぶ
  const openDiffAt = useCallback(
    ({ path, side = 'new', line, scope, ref } = {}) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !path || !Number.isInteger(line)) return false;
      const s = scope ? normalizeDiffScope(scope) : storedDiffScope();
      requestDiff(
        sessionId,
        s,
        {
          path,
          side: side === 'old' ? 'old' : 'new',
          line,
          nonce: Date.now(),
        },
        ref,
      );
      return true;
    },
    [requestDiff],
  );
  useEffect(() => {
    window.claudeBridge = { ...window.claudeBridge, openDiffAt };
  }, [openDiffAt]);

  // 差分ドロワーの行への指摘を一括送信。Review パネルの下書きとは別物なので keepDraft で消させず、
  // requestId で結果を突き合わせて成功した分だけ store から消す（失敗・無応答なら残す）
  const diffRequestSeq = useRef(0);
  const submitDiffReview = useCallback(
    (sessionId, key, items, keys) => {
      if (!sessionId || items.length === 0) return;
      diffRequestSeq.current += 1;
      const requestId = `diff-${Date.now()}-${diffRequestSeq.current}`;
      diffCommentStore.markSending(key, keys, requestId);
      send({ type: 'submit_review', sessionId, sessionKey: key, items, requestId, keepDraft: true });
      // 切断などで結果が来なければ送信中を解いて残す（二重送信より取りこぼしを避ける）
      setTimeout(() => diffCommentStore.resolveSending(requestId, false), 15000);
    },
    [send],
  );

  const handleChangeDiffScope = useCallback(
    (scope) => {
      try {
        localStorage.setItem(DIFF_SCOPE_STORAGE_KEY, scope);
      } catch {
        // 保存できなくても切り替えはする
      }
      if (diffDrawer) requestDiff(diffDrawer.sessionId, scope);
    },
    [diffDrawer, requestDiff],
  );
  const handleChangeDiffRef = useCallback(
    (ref) => {
      if (diffDrawer) requestDiff(diffDrawer.sessionId, diffDrawer.scope, null, ref);
    },
    [diffDrawer, requestDiff],
  );

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
      send({ type: 'get_subagent_transcript', sessionId: activeSessionId, agentId });
    },
    [send, activeSessionId],
  );

  const handleOpenShellTask = useCallback((task) => {
    setShellDrawer({
      taskId: task.taskId,
      label: task.label || task.preview || task.taskId,
      status: task.status,
      exitCode: task.exitCode,
      text: '',
      truncated: false,
    });
  }, []);

  // チャットのタスク通知（role: 'task'）から開く。task-id はサブエージェントなら agentId、シェルなら taskId と同じ。
  // 一覧（ポーリングで取っているもの）にあればそちらの情報を使い、無ければ通知の中身で開く（ドロワーが取り直す）。
  // 一覧は ref で読み、ChatMessage（memo）に渡すハンドラの参照をポーリングで変えない
  const subagentTasksRef = useRef(subagentTasks);
  subagentTasksRef.current = subagentTasks;
  const shellTasksRef = useRef(shellTasks);
  shellTasksRef.current = shellTasks;
  const handleOpenTaskNotice = useCallback(
    (kind, notice) => {
      if (!notice?.taskId) return;
      if (kind === 'agent') {
        const known = (subagentTasksRef.current[activeSessionId] || []).find((t) => t.agentId === notice.taskId);
        handleOpenSubagentTask(
          known || {
            agentId: notice.taskId,
            description: notice.summary?.match(/^Agent "(.*)"/)?.[1] || notice.summary,
            status: notice.status === 'completed' ? 'completed' : 'running',
          },
        );
      } else if (kind === 'shell') {
        const known = (shellTasksRef.current[activeSessionId] || []).find((t) => t.taskId === notice.taskId);
        const exitCode = notice.summary?.match(/exit code (\d+)/)?.[1];
        handleOpenShellTask(
          known || {
            taskId: notice.taskId,
            label: notice.summary?.match(/"(.*)"/)?.[1] || notice.summary,
            status: 'exited',
            exitCode: exitCode != null ? Number(exitCode) : null,
          },
        );
      }
    },
    [activeSessionId, handleOpenSubagentTask, handleOpenShellTask],
  );

  // ドロワーからの取得要求（初回＋実行中のポーリング）
  const handleRequestShellOutput = useCallback(
    (taskId) => {
      if (!activeSessionId || !taskId) return;
      send({ type: 'get_shell_task_output', sessionId: activeSessionId, taskId });
    },
    [send, activeSessionId],
  );

  // 日数・期間が変わったときだけ古い一覧を消す（Home ⇄ タブの往復や再接続では残す。
  // 取得の effect に混ぜると往復のたびに「読み込み中」に戻り、送信が失敗すると復帰できない）
  useEffect(() => {
    setRecentSessions(null);
  }, [recentDays, recentPeriod, includeHeadless]);

  // 直近セッションは JSONL 全走査になるので、ホームを開いた時と日数・期間の変更時だけ取る。
  // starred は「期間外でも一覧に含める対象」としてサーバーに渡す
  useEffect(() => {
    if (!showHome || !connected) return;
    send({
      type: 'list_recent_sessions',
      days: recentDays,
      starred: starredRef.current,
      includeHeadless,
      ...(recentPeriod ? { period: { from: recentPeriod.from, to: recentPeriod.to } } : {}),
    });
  }, [showHome, connected, recentDays, recentPeriod, includeHeadless, send]);

  // 活動ヒートマップも JSONL 由来なので、ホームを開いた時と「更新」時だけ取る。
  // サーバー側はファイル単位のキャッシュを持つので 2 回目以降は差分だけ読む
  const requestHeatmap = useCallback(() => {
    setHeatmapLoading(true);
    send({ type: 'list_activity_heatmap', days: 365 });
  }, [send]);

  useEffect(() => {
    if (!showHome || !connected) return;
    requestHeatmap();
  }, [showHome, connected, requestHeatmap]);

  // セッション詳細は JSONL を全文読むので、パネルを開いたときだけ取る（ポーリングしない）
  const requestSessionTurns = useCallback(
    ({ sessionId, projectDir }) => {
      setSessionTurns(null);
      send({ type: 'get_session_turns', sessionId, projectDir });
    },
    [send],
  );

  // ホームの行の「直近のやりとり」。ホバーで開いたときだけ取る。同じ updatedAt で取得済み・取得中なら
  // 送らない（JSONL が更新されていなければ中身は変わらない）。取り直すときはエントリを消して読み込み中にする
  const requestRecentExchanges = useCallback(
    ({ sessionId, projectDir, updatedAt }) => {
      if (!sessionId || !projectDir) return;
      const cached = recentExchangesRef.current[sessionId];
      if (cached && !cached.error && cached.updatedAt === updatedAt) return;
      const pending = recentPendingRef.current;
      if (pending.has(sessionId) && pending.get(sessionId) === updatedAt) return;
      pending.set(sessionId, updatedAt);
      if (cached) {
        setRecentExchanges((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
      send({ type: 'get_session_recent', sessionId, projectDir });
    },
    [send],
  );

  // 切断中に送った要求は応答が返らないので、取得中の印を残さない（再接続後にまた取れるように）
  useEffect(() => {
    if (!connected) recentPendingRef.current.clear();
  }, [connected]);

  // 週間カレンダーは活動パネルが「表示中の週」を持ち、週が変わるたびに呼ぶ
  const requestCalendar = useCallback(
    ({ fromMs, toMs }) => {
      if (!connected) return;
      calendarRequestRef.current = fromMs;
      setCalendarLoading(true);
      send({ type: 'list_activity_calendar', fromMs, toMs });
    },
    [send, connected],
  );

  useEffect(() => {
    localStorage.setItem('homeRecentDays', String(recentDays));
  }, [recentDays]);

  useEffect(() => {
    localStorage.setItem('homeIncludeHeadless', includeHeadless ? '1' : '0');
  }, [includeHeadless]);

  useEffect(() => {
    saveStarred(starredSessions);
  }, [starredSessions]);

  const handleToggleStar = useCallback((sessionId) => {
    setStarredSessions((prev) => toggleStarred(prev, sessionId));
  }, []);

  useEffect(() => {
    saveSensitive(sensitiveSessions);
  }, [sensitiveSessions]);

  useEffect(() => {
    saveShareMode(shareMode);
  }, [shareMode]);

  const handleToggleSensitive = useCallback((sessionId) => {
    setSensitiveSessions((prev) => toggleSensitive(prev, sessionId));
  }, []);

  // 共有モード中のセンシティブ指定はタブ自体が消えるので、そのセッションを表示したままだと
  // 本文だけ残って戻る手段も無くなる。アクティブが隠し対象ならホームへ退避する
  useEffect(() => {
    if (!shareMode || showHome) return;
    const active = sessions.find((s) => s.id === activeSessionId);
    if (active?.claudeSessionId && sensitiveIds.has(active.claudeSessionId)) {
      setShowHome(true);
    }
  }, [shareMode, showHome, sensitiveIds, sessions, activeSessionId]);

  useEffect(() => {
    localStorage.setItem('showHome', String(showHome));
  }, [showHome]);

  useEffect(() => {
    localStorage.setItem('desktopNotify', String(notifyEnabled));
  }, [notifyEnabled]);

  useEffect(() => {
    return on('session_history', (msg) => {
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
        // コンテキスト使用量（usage のある assistant にだけ入る）
        contextUsage: m.contextUsage,
        // Artifact の公開先（role: 'artifact'）と WebFetch で読んだ URL（role: 'webfetch'）
        url: m.url,
        title: m.title,
        path: m.path,
        // WebFetch の HTTP ステータス（role: 'webfetch' のときだけ入る）
        code: m.code,
        // ツールの結果の印 [{id, error?, created?, hookError?}]（role: 'toolresult' のときだけ入る）
        results: m.results,
        // フックの失敗 {name, exitCode, command, detail}（role: 'hookerror' のときだけ入る）
        hook: m.hook,
        // タスク通知の中身 [{taskId, status, summary, …}]（role: 'task' のときだけ入る）
        tasks: m.tasks,
        // タグ注入・isMeta の user レコード（人が打っていない）。リンク一覧の origin 判定用
        injected: m.injected,
        // 人が打っていない human の送り手（サブエージェントの報告・タスク通知など）。チャットの見出し用
        sender: m.sender,
        timestamp: m.timestamp || new Date().toISOString(),
        // 境界がある: timestamp が境界以下 / 不在を履歴扱い、境界より新しければ通常表示
        // 境界がない: 従来通り全件履歴扱い（bridgeId 不明な resume 即時ロード等）
        isHistory: boundary ? !m.timestamp || m.timestamp <= boundary : true,
      }));

      // active かどうかに関係なく bridgeSessionId のメッセージ列へ格納する。
      // 表示は messagesBySession[activeSessionId] の派生なので、active なら自動反映。
      // 読み込み中に JSONL 監視で届いた新着が履歴に含まれていなければ後ろに残す
      if (bridgeId) {
        updateSessionMessages(bridgeId, (prev) => {
          const loadedUuids = new Set(loaded.map((m) => m.uuid).filter(Boolean));
          const pending = prev.filter((m) => !m.isHistory && m.uuid && !loadedUuids.has(m.uuid));
          return [...loaded, ...pending];
        });
      }
    });
  }, [on, updateSessionMessages]);

  // activeSessionIdRef を同期し、リロード後に同じタブへ戻せるよう永続化
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (activeSessionId) {
      localStorage.setItem('activeSessionId', activeSessionId);
    } else {
      localStorage.removeItem('activeSessionId');
    }
  }, [activeSessionId]);

  // セッション切り替え時にピン・レビュー下書きを取得。
  // sessionKey 依存にして、claudeSessionId が後から埋まった場合も再取得する。
  useEffect(() => {
    if (activeSessionId) {
      send({ type: 'get_pins', sessionId: activeSessionId, sessionKey });
      send({ type: 'get_review', sessionId: activeSessionId, sessionKey });
    }
  }, [activeSessionId, sessionKey, send]);

  // アクティブセッションのメッセージが未取得なら JSONL から復元する
  // （リロード後など messagesBySession に無い場合の復旧経路）。
  useEffect(() => {
    if (!activeSessionId) return;
    // 空かどうかでは判断しない: 開く前のタブにも JSONL 監視の新着が届くので、
    // 「新着だけ入っている」状態で履歴の読み込みを飛ばしてしまう
    if (historyRequestedRef.current.has(activeSessionId) && messagesBySession[activeSessionId]) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session?.claudeSessionId) {
      historyRequestedRef.current.add(activeSessionId);
      send({
        type: 'load_session_history',
        sessionId: activeSessionId,
        claudeSessionId: session.claudeSessionId,
        projectDir: session.projectDir,
      });
    }
  }, [activeSessionId, sessions, send, messagesBySession]);

  const handleCreateSession = useCallback(
    (options) => {
      send({ type: 'new_session', ...options });
      setNewSessionDraft(options);
      setNewSessionError(null);
      setShowNewSession(false);
    },
    [send],
  );

  const handleKillSession = useCallback(
    (sessionId) => {
      send({ type: 'kill_session', sessionId });
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
    [send, sessions, activeSessionId],
  );

  const handleRestartSession = useCallback(
    (sessionId) => {
      send({ type: 'restart_session', sessionId });
    },
    [send],
  );

  const handleRemovePastSession = useCallback(
    (sessionId) => {
      send({ type: 'remove_past_session', sessionId });
    },
    [send],
  );

  const handleDetachTmux = useCallback(
    (sessionId) => {
      send({ type: 'detach_tmux_pane', sessionId });
      localStorage.removeItem(`historyBoundary:${sessionId}`);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    [send],
  );

  // tmux 上の claude を終了してペインを閉じる。タブからは sessionId（paneId 等はサーバーが引く）、
  // ホームの起動中カードからは paneId + claudeSessionId を送る。
  // サーバーが照合で拒否し得るので、タブの後始末は tmux_session_terminated を受けてから行う
  const handleTerminateTmux = useCallback(
    ({ sessionId, paneId, claudeSessionId, name, status, target }) => {
      if (!window.confirm(terminateConfirmMessage({ name, status, target }))) return;
      if (sessionId) {
        send({ type: 'terminate_tmux_session', sessionId });
      } else {
        setHomeError(null);
        send({ type: 'terminate_tmux_session', paneId, claudeSessionId });
      }
    },
    [send],
  );

  const handleTerminateTmuxTab = useCallback(
    (session) =>
      handleTerminateTmux({
        sessionId: session.id,
        name: session.name,
        status: session.status,
        target: session.target,
      }),
    [handleTerminateTmux],
  );

  useEffect(() => {
    return on('tmux_session_terminated', (msg) => {
      const closed = msg.closedSessionIds || [];
      for (const id of closed) localStorage.removeItem(`historyBoundary:${id}`);
      if (closed.length > 0) {
        setMessagesBySession((prev) => {
          const next = { ...prev };
          for (const id of closed) delete next[id];
          return next;
        });
      }
      // kill 直後は claude の pid がまだ残っていることがあるので、少し待ってから起動中一覧を取り直す
      setTimeout(() => send({ type: 'list_running_sessions' }), 1500);
    });
  }, [on, send]);

  const handleResumeSession = useCallback(
    ({ claudeSessionId, name, cwd, projectDir }) => {
      // 履歴を先に取得
      send({
        type: 'load_session_history',
        claudeSessionId,
        projectDir,
      });
      // セッションを resume で起動
      setHomeError(null);
      setHomeNotice(null);
      send({ type: 'resume_session', claudeSessionId, name, cwd, projectDir });
      setShowNewSession(false);
      setClaudeSessions(null);
    },
    [send],
  );

  // tmux に新しい window を作って `claude --resume` で起こす。
  // PTY 直起動（handleResumeSession）と違い、ブリッジを落としても生き残る。
  const handleResumeInTmux = useCallback(
    ({ claudeSessionId, name, cwd, projectDir }) => {
      setHomeError(null);
      setHomeNotice(null);
      send({ type: 'resume_in_tmux', claudeSessionId, name, cwd, projectDir });
      setShowNewSession(false);
    },
    [send],
  );

  const handleRequestClaudeSessions = useCallback(() => {
    send({ type: 'list_claude_sessions' });
  }, [send]);

  const handleFindClaudeSessions = useCallback(
    (query) => {
      send({ type: 'find_claude_sessions', query });
    },
    [send],
  );

  const handleRequestRecentDirs = useCallback(() => {
    send({ type: 'list_recent_dirs' });
  }, [send]);

  const handleAttachTmux = useCallback(
    ({ paneId, name, cwd, target, claudePid, claudeSessionId, status }) => {
      send({
        type: 'attach_tmux_pane',
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
    [send],
  );

  // claude を起動せず、既存セッションの JSONL を読むだけの閲覧ビューを開く（送信欄は inbox 経由）
  const handleOpenReadonly = useCallback(
    ({ claudeSessionId, name, cwd, projectDir }) => {
      send({ type: 'open_readonly_session', claudeSessionId, name, cwd, projectDir });
      setShowNewSession(false);
      setClaudeSessions(null);
    },
    [send],
  );

  const handleCloseReadonly = useCallback(
    (sessionId) => {
      send({ type: 'close_readonly_session', sessionId });
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
    [send, sessions, activeSessionId],
  );

  // readonly セッション（メインタブ）から、その claudeSessionId へフックベース送信
  // 切断中の送信は届かないので、送れたように見せず false を返す
  // （InputBar が入力欄のテキストを保持し、チャットに system メッセージを出す）
  // 送信結果の失敗（inbox 書き込み・レビュー送信）も content を渡してここで出す
  const notifySendFailure = useCallback(
    (content = 'サーバーと切断中のため送信できませんでした。接続表示（ヘッダの●）が戻ってから再送してください。') => {
      updateSessionMessages(activeSessionIdRef.current, (prev) => [
        ...prev,
        { id: `senderror-${Date.now()}`, role: 'system', content, timestamp: new Date().toISOString() },
      ]);
    },
    [updateSessionMessages],
  );

  const handleSendToReadonly = useCallback(
    (text) => {
      const t = (text || '').trim();
      const s = sessionsRef.current.find((x) => x.id === activeSessionId);
      const sid = s?.claudeSessionId;
      if (!t || !sid) return false;
      const sent = send({ type: 'send_to_agent', claudeSessionId: sid, comments: [t] });
      if (!sent) {
        notifySendFailure();
        return false;
      }
      return true;
    },
    [send, activeSessionId, notifySendFailure],
  );

  useEffect(() => {
    return on('send_to_agent_result', (msg) => {
      if (!msg.ok) notifySendFailure(`送信に失敗しました${msg.error ? `: ${msg.error}` : '。'}`);
    });
  }, [on, notifySendFailure]);

  useEffect(() => {
    return on('submit_review_result', (msg) => {
      if (msg.requestId) diffCommentStore.resolveSending(msg.requestId, !!msg.ok);
      if (!msg.ok) notifySendFailure('レビューの送信に失敗しました。');
    });
  }, [on, notifySendFailure]);

  const handleRequestTmuxPanes = useCallback(() => {
    send({ type: 'list_tmux_panes' });
  }, [send]);

  const addUserMessage = useCallback(
    (text) => {
      updateSessionMessages(activeSessionIdRef.current, (prev) => [
        ...prev,
        {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'human',
          content: text,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
    [updateSessionMessages],
  );

  const handleInput = useCallback(
    (text) => {
      if (!activeSessionId) return false;
      const sent = send({ type: 'input', sessionId: activeSessionId, text: text + '\r' });
      if (!sent) {
        notifySendFailure();
        return false;
      }
      addUserMessage(text);
      // スラッシュコマンドは応答が来ないもの（/clear・モーダル型）があるので先回り表示しない。
      // 既に busy なら status で出ているので要らない（busy の観測で消す仕組みなので、残すと
      // ターンが終わったあとも猶予の間だけ出続ける）
      const currentStatus = sessionsRef.current.find((s) => s.id === activeSessionId)?.status;
      if (!text.trimStart().startsWith('/') && currentStatus !== 'busy') {
        const sentAt = Date.now();
        setPendingTurns((prev) => ({ ...prev, [activeSessionId]: sentAt }));
      }
      return true;
    },
    [send, activeSessionId, addUserMessage, notifySendFailure],
  );

  // 選択肢プロンプトへの回答。keys は数字キー（選択/トグル）や Tab / Escape。
  // text は "Type something" の自由入力（サーバーが 番号 → テキスト → Enter の順で送る）。
  const handleAnswerChoice = useCallback(
    ({ keys, text }) => {
      if (!activeSessionId) return;
      send({ type: 'answer_choice_prompt', sessionId: activeSessionId, keys, text });
    },
    [send, activeSessionId],
  );

  // TUI 内でモーダル（/model のピッカー等）を開いてしまったときの復帰手段。
  // モーダルは waitingFor が立たないので選択肢カードが出ず、ブラウザからは見えない。
  // answer_choice_prompt は waitingFor を要求せずキーを送るだけなので Escape をそのまま流す
  const handleSendEscape = useCallback(() => {
    if (!activeSessionId) return;
    send({ type: 'answer_choice_prompt', sessionId: activeSessionId, keys: ['Escape'] });
  }, [send, activeSessionId]);

  const handleRefreshChoice = useCallback(() => {
    if (!activeSessionId) return;
    send({ type: 'get_choice_prompt', sessionId: activeSessionId });
  }, [send, activeSessionId]);

  // タブを切り替えた/再接続した直後は、その場で画面を読んでカードの内容を合わせる
  // （定期ポーリングを待たずに出したいため）
  useEffect(() => {
    if (!activeSessionId || showHome || !connected) return;
    send({ type: 'get_choice_prompt', sessionId: activeSessionId });
  }, [send, activeSessionId, showHome, connected]);

  const handleResize = useCallback(
    (cols, rows) => {
      if (activeSessionId) {
        send({ type: 'resize', sessionId: activeSessionId, cols, rows });
      }
    },
    [send, activeSessionId],
  );

  const handleSwitchSession = useCallback(
    (sessionId) => {
      // 表示は messagesBySession[activeSessionId] の派生なので active を変えるだけでよい
      // （cache 保存・復元やレース対策は不要になった）
      setShowHome(false);
      setActiveSessionId(sessionId);
      setPins([]);
      setReviewItems([]);
      clearAttention(sessionId);
    },
    [clearAttention],
  );

  // 通知クリック時に最新の handleSwitchSession を呼ぶため（session_list ハンドラの
  // effect は [on] 依存のみで stale closure になる）
  const handleSwitchSessionRef = useRef(handleSwitchSession);
  useEffect(() => {
    handleSwitchSessionRef.current = handleSwitchSession;
  }, [handleSwitchSession]);

  // 画面全体のキー操作（Ctrl+D/U の半画面スクロール、Alt+Shift+J/K・Alt+数字 のタブ移動）。
  // タブの並びと絞り込みはサイドバー（SessionTabs）と同じにする（隠しているタブへ飛ばないように）
  // サイドバーのタブの並び（D&D で入れ替えたもの。localStorage だけで持つ）
  const [tabOrder, setTabOrder] = useState(loadTabOrder);
  const flatOrderedSessions = useMemo(() => applyTabOrder(sessions, tabOrder), [sessions, tabOrder]);
  // グループ分け（既定はプロジェクトで自動、D&D で手動の割り当てに上書き）。表示順＝グループ順に並べ直した列
  const [tabGroupState, setTabGroupState] = useState(loadTabGroups);
  const updateTabGroups = useCallback((fn) => {
    setTabGroupState((prev) => {
      const next = fn(prev);
      if (next !== prev) saveTabGroups(next);
      return next;
    });
  }, []);
  const tabGroups = useMemo(
    () => buildTabGroups(flatOrderedSessions, tabGroupState),
    [flatOrderedSessions, tabGroupState],
  );
  const orderedSessions = useMemo(() => flattenTabGroups(tabGroups), [tabGroups]);
  // targetGroupKey が来たら（別グループのタブ・見出しへ落とした）そのグループへ移す
  const handleReorderTab = useCallback(
    (fromId, targetId, after, targetGroupKey) => {
      if (targetId) {
        const next = moveTab(orderedSessions, fromId, targetId, after);
        setTabOrder(next);
        saveTabOrder(next);
      }
      const moved = orderedSessions.find((s) => s.id === fromId);
      if (moved && targetGroupKey) updateTabGroups((st) => assignTabToGroup(st, moved, targetGroupKey));
    },
    [orderedSessions, updateTabGroups],
  );
  const tabGroupActions = useMemo(
    () => ({
      onCreate: (name) => updateTabGroups((st) => createGroup(st, name)),
      onRename: (id, name) => updateTabGroups((st) => renameGroup(st, id, name)),
      onDelete: (id) => updateTabGroups((st) => deleteGroup(st, id)),
      onToggle: (key) => updateTabGroups((st) => toggleGroupCollapsed(st, key)),
      onColor: (key, index) => updateTabGroups((st) => setGroupColor(st, key, index)),
    }),
    [updateTabGroups],
  );
  const keyboardTabIds = useMemo(
    () =>
      tabGroups
        .flatMap((g) => visibleTabsOf(g, showHome ? null : activeSessionId))
        .filter((s) => !(shareMode && s.claudeSessionId && sensitiveIds.has(s.claudeSessionId)))
        .map((s) => s.id),
    [tabGroups, showHome, activeSessionId, shareMode, sensitiveIds],
  );
  const handleToggleShareMode = useCallback(() => setShareMode((on) => !on), []);
  useGlobalKeys({
    tabs: keyboardTabIds,
    activeId: showHome ? null : activeSessionId,
    onSelectTab: handleSwitchSession,
    onHome: () => setShowHome(true),
    onToggleShareMode: handleToggleShareMode,
  });

  // ディレクトリ色。サイドバーのグループ色（表示順で --cal-N を回す）と同じものをホーム・トップバーでも使う。
  // 共有モードで隠したタブを除いた並びで作る（SessionTabs と同じ規則）
  const dirColors = useMemo(
    () =>
      groupColorMap(
        shownTabGroups(tabGroups, (s) => shareMode && s.claudeSessionId && sensitiveIds.has(s.claudeSessionId)),
        tabGroupState.colors,
      ),
    [tabGroups, tabGroupState.colors, shareMode, sensitiveIds],
  );
  const dirColorOfCwd = useCallback((cwd) => dirColorOf(dirColors, cwd), [dirColors]);

  const handleToggleTheme = useCallback(() => setAppTheme((t) => (t === 'light' ? 'dark' : 'light')), []);
  const handleToggleNotify = useCallback(async () => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      return;
    }
    if (Notification.permission === 'granted') {
      setNotifyEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      alert('ブラウザの通知権限がブロックされています。サイト設定から許可してください。');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
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
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [clearAttention]);

  const handleTogglePin = useCallback(
    (message, pin) => {
      if (!activeSessionId || !message?.uuid) return;
      if (pin) {
        send({
          type: 'pin_message',
          sessionId: activeSessionId,
          sessionKey,
          messageUuid: message.uuid,
          role: message.role,
          label: message.role === 'human' ? humanSenderLabel(message.sender) : 'Claude',
          excerpt: pinExcerpt(message.content),
          messageTimestamp: message.timestamp || null,
        });
      } else {
        send({ type: 'unpin_message', sessionId: activeSessionId, sessionKey, messageUuid: message.uuid });
      }
    },
    [send, activeSessionId, sessionKey],
  );

  const handleUnpin = useCallback(
    (messageUuid) => {
      if (activeSessionId) send({ type: 'unpin_message', sessionId: activeSessionId, sessionKey, messageUuid });
    },
    [send, activeSessionId, sessionKey],
  );

  // レビュー＝pending review を保存（下書き、送信はしない）
  const handleSaveReview = useCallback(
    (items) => {
      if (activeSessionId) {
        send({ type: 'save_review', sessionId: activeSessionId, sessionKey, items });
      }
    },
    [send, activeSessionId, sessionKey],
  );

  // レビュー Submit＝溜めた指摘を一括送信。送信先（PTY/inbox）はサーバーが種別で出し分ける。
  const handleSubmitReview = useCallback(
    (items) => {
      const list = (items ?? reviewItems).filter((it) => (it.text || '').trim());
      if (!activeSessionId || list.length === 0) return;
      send({ type: 'submit_review', sessionId: activeSessionId, sessionKey, items: list });
    },
    [send, activeSessionId, sessionKey, reviewItems],
  );

  // 範囲選択 → レビューに追加。選択箇所を anchor（対象）に、本文（指摘）は別に書いて渡す。
  const handleAddAnchoredReview = useCallback(
    ({ anchor, text }) => {
      const t = (text || '').trim();
      if (!activeSessionId || !t) return;
      const next = [...reviewItems, { id: `r-${Date.now()}`, text: t, anchor: anchor || null }];
      setReviewItems(next);
      send({ type: 'save_review', sessionId: activeSessionId, sessionKey, items: next });
      setShowReviewPanel(true);
    },
    [send, activeSessionId, sessionKey, reviewItems],
  );

  // 数字キーでメッセージを選んだ → レビューパネルを開き、その引用を付けた指摘欄に入る。
  // 本文はまだ空なので App の reviewItems（＝サーバー保存分）には載せず、パネルの下書きに渡す。
  const handlePickMessageForReview = useCallback(({ anchor }) => {
    if (!anchor) return;
    setShowReviewPanel(true);
    setIncomingAnchor({ anchor, nonce: Date.now() });
  }, []);

  // プレビュー系ハンドラ。inline の arrow で渡すと毎レンダー別物になり、memo した ChatMessage の
  // 再描画抑止が効かないので useCallback で固定する。messagesBySession はどのセッションに 1 通届いても
  // identity が変わる（依存に入れるとストリーミング中は毎回作り直しになる）ため ref で読む
  const messagesBySessionRef = useRef(messagesBySession);
  messagesBySessionRef.current = messagesBySession;
  const currentMessageCount = () => (messagesBySessionRef.current[activeSessionIdRef.current] || []).length;
  // プレビューを PiP 窓に移す。requestWindow は user activation が要るのでクリックから直接呼ばれる前提。
  // 窓は 1 つだけ（新しく開くとブラウザが前の窓を閉じる）なので、前の窓の pagehide で
  // 新しい state を消さないよう onClose は自分の窓のときだけ片付ける
  const pipSeqRef = useRef(0);
  const handleOpenPip = useCallback(async () => {
    if (!previewData) return;
    const { filePath, markdown, title, target } = previewData;
    // レビューの送信先は「開いたときのセッション」に固定する（小窓は他のタブへ移っても残るため）。
    // 差分の小窓から開いたプレビューは、そのプレビューの送信先（差分の小窓のセッション）を引き継ぐ
    const sessionId = target ? target.sessionId : activeSessionIdRef.current;
    const key = target
      ? target.sessionKey
      : sessionsRef.current.find((s) => s.id === sessionId)?.claudeSessionId || sessionId;
    try {
      const pipWindow = await openPreviewPipWindow();
      pipSeqRef.current += 1;
      setPipPreview({
        id: pipSeqRef.current,
        pipWindow,
        filePath,
        markdown,
        title,
        sessionId,
        sessionKey: key,
        openedAt: drawerOpenedAt,
      });
      // ドロワーは閉じる（.drawer-overlay が残ると後ろの画面を操作できない）
      setPreviewData(null);
      setDrawerOpenedAt(null);
    } catch (err) {
      console.warn('[pip] requestWindow failed', err);
    }
  }, [previewData, drawerOpenedAt]);
  const handleClosePip = useCallback((pipWindow) => {
    setPipPreview((cur) => (cur && cur.pipWindow === pipWindow ? null : cur));
  }, []);

  // プレビューのファイルレビュー送信。ドロワーは今のセッション、小窓は開いたときのセッションへ送る。
  // サーバーが対象セッション種別で PTY/inbox を出し分けるため readonly でも届く。各項目にファイル名を前置して文脈を残す
  const submitFileReview = useCallback(
    (sessionId, key, target, items) => {
      if (!sessionId) {
        console.warn('No session for review submit');
        return;
      }
      const fileName = target.split('/').pop();
      const labeled = items
        .map((t) => (t || '').trim())
        .filter(Boolean)
        .map((t) => ({ text: `${fileName}: ${t}` }));
      if (labeled.length === 0) return;
      send({ type: 'submit_review', sessionId, sessionKey: key, items: labeled });
    },
    [send],
  );
  const diffSessionKey = diffDrawer
    ? sessions.find((s) => s.id === diffDrawer.sessionId)?.claudeSessionId || diffDrawer.sessionId
    : null;
  // claudeSessionId が後から決まったタブ（tmux の起動直後など）は、ブリッジ ID をキーに書いた差分の指摘を
  // claudeSessionId のキーへ移す（移さないとキーが変わった時点で見えなくなる）
  useEffect(() => {
    for (const s of sessions) {
      if (s.claudeSessionId) diffCommentStore.migrateSession(s.id, s.claudeSessionId);
    }
    // 差分ドロワーの確認済み（localStorage）も同じく付け替える
    const list = loadReviewed();
    let next = list;
    for (const s of sessions) {
      if (s.claudeSessionId) next = migrateReviewed(next, s.id, s.claudeSessionId);
    }
    if (next !== list) saveReviewed(next);
  }, [sessions]);
  const diffSessionId = diffDrawer?.sessionId;
  const handleSubmitDiffComments = useCallback(
    (items, keys) => submitDiffReview(diffSessionId, diffSessionKey, items, keys),
    [submitDiffReview, diffSessionId, diffSessionKey],
  );

  // 差分ドロワーを小窓に移す。requestWindow は user activation が要るので、クリックから直接（最初の await で）呼ぶ。
  // 送信先は開いたときのセッション（sessionId）に固定する。sessionKey は下書き・確認済みのキーで、tmux タブでは
  // 後から claudeSessionId に変わる（migrateSession で移る）ので固定せず、タブが残っている間は sessions から引く
  const handleOpenDiffPip = useCallback(async () => {
    if (!diffDrawer) return;
    const openedKey = diffSessionKey;
    try {
      const pipWindow = await openPreviewPipWindow({ width: 1000, height: 720 });
      // 窓を待つ間に差分が届いている（読み込み中に押した）ことがあるので、最新のドロワーから引き継ぐ
      const latest = diffDrawerRef.current;
      if (!latest) {
        pipWindow.close();
        return;
      }
      const { sessionId, scope, requestedRef, ref, data, sources } = latest;
      pipSeqRef.current += 1;
      setPipDiff({ id: pipSeqRef.current, pipWindow, sessionId, openedKey, scope, requestedRef, ref, data, sources });
      // メイン側のドロワーは閉じる（.diff-drawer-overlay が残ると後ろの画面を操作できない）
      setDiffDrawer(null);
    } catch (err) {
      console.warn('[pip] requestWindow failed', err);
    }
  }, [diffDrawer, diffSessionKey]);
  const handleCloseDiffPip = useCallback((pipWindow) => {
    setPipDiff((cur) => (cur && cur.pipWindow === pipWindow ? null : cur));
  }, []);
  const pipDiffSessionId = pipDiff?.sessionId;
  const pipDiffTab = pipDiff ? sessions.find((s) => s.id === pipDiff.sessionId) : null;
  // claudeSessionId を一度見たら openedKey に覚え、タブが閉じてもブリッジ ID には戻さない
  // （戻すと DiffDrawer の確認済みの付け替えが逆向きに走り、下書きも見えなくなる）
  const pipDiffClaudeId = pipDiffTab?.claudeSessionId || null;
  useEffect(() => {
    if (!pipDiffClaudeId) return;
    setPipDiff((prev) => (prev && prev.openedKey !== pipDiffClaudeId ? { ...prev, openedKey: pipDiffClaudeId } : prev));
  }, [pipDiffClaudeId]);
  const pipDiffSessionKey = pipDiff ? pipDiffClaudeId || pipDiff.openedKey : null;
  // 小窓のファイル名から開くプレビュー。メイン画面のプレビューで開くが、指摘の送信先と「開いてからの応答」は
  // 小窓のセッションにする（メイン画面で別のタブ・ホームを見ていても、小窓を開いたセッションへ送る）
  const handleOpenPreviewFromDiffPip = useCallback(
    (path) => {
      if (!pipDiffSessionId) return;
      setPreviewData({ filePath: path, target: { sessionId: pipDiffSessionId, sessionKey: pipDiffSessionKey } });
      setDrawerOpenedAt((messagesBySessionRef.current[pipDiffSessionId] || []).length);
    },
    [pipDiffSessionId, pipDiffSessionKey],
  );
  const pipDiffRef = useRef(pipDiff);
  pipDiffRef.current = pipDiff;
  const requestPipDiff = useCallback(
    (scope, ref = null, { refreshSources = false } = {}) => {
      if (!pipDiffSessionId) return;
      const r = normalizeDiffRef(scope, ref);
      const prevSources = pipDiffRef.current?.sources;
      const needSources = isRefScope(scope) && (refreshSources || !prevSources || prevSources.error);
      setPipDiff((prev) =>
        prev
          ? {
              ...prev,
              scope,
              requestedRef: r,
              ref: r,
              data: { loading: true },
              sources: needSources ? { loading: true } : prev.sources,
            }
          : prev,
      );
      send({ type: 'get_session_diff', sessionId: pipDiffSessionId, scope, ref: r });
      if (needSources) send({ type: 'get_diff_sources', sessionId: pipDiffSessionId });
    },
    [pipDiffSessionId, send],
  );
  const handleChangePipDiffScope = useCallback(
    (scope) => {
      try {
        localStorage.setItem(DIFF_SCOPE_STORAGE_KEY, scope);
      } catch {
        // 保存できなくても切り替えはする
      }
      requestPipDiff(scope);
    },
    [requestPipDiff],
  );
  const handleChangePipDiffRef = useCallback(
    (ref) => {
      const cur = pipDiffRef.current;
      if (cur) requestPipDiff(cur.scope, ref);
    },
    [requestPipDiff],
  );
  const handleSubmitPipDiffComments = useCallback(
    (items, keys) => submitDiffReview(pipDiffSessionId, pipDiffSessionKey, items, keys),
    [submitDiffReview, pipDiffSessionId, pipDiffSessionKey],
  );
  const handlePipReviewSubmit = useCallback(
    (target, items) => pipPreview && submitFileReview(pipPreview.sessionId, pipPreview.sessionKey, target, items),
    [pipPreview, submitFileReview],
  );
  // 小窓に出す「開いてからの Claude の応答」
  const pipSessionMessages = pipPreview ? messagesBySession[pipPreview.sessionId] : undefined;
  const pipResponses = useMemo(() => {
    if (!pipPreview || pipPreview.openedAt == null || !pipSessionMessages) return [];
    return pipSessionMessages.slice(pipPreview.openedAt).filter((m) => m.role === 'assistant');
  }, [pipPreview, pipSessionMessages]);

  const handleOpenPreview = useCallback((path) => {
    setPreviewData({ filePath: path });
    setDrawerOpenedAt(currentMessageCount());
  }, []);
  const handlePreviewMarkdown = useCallback((markdown, title) => {
    setPreviewData({ markdown, title });
    setDrawerOpenedAt(currentMessageCount());
  }, []);
  const handleOpenFileReview = useCallback((path) => {
    setPreviewData({ filePath: path, reviewMode: true });
    setDrawerOpenedAt(currentMessageCount());
  }, []);
  const handleJumpDone = useCallback(() => setJumpToUuid(null), []);

  // サイドバーのタブに出すコンテキスト使用率。SessionTabs は memo 対象ではないが、
  // props の参照が毎描画で変わると無駄な再描画になるので messagesBySession の変化時だけ作り直す
  const contextBySession = useMemo(() => {
    const map = new Map();
    for (const [id, msgs] of Object.entries(messagesBySession)) {
      const usage = latestContextUsage(msgs);
      if (usage) map.set(id, usage);
    }
    return map;
  }, [messagesBySession]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // 表示メッセージは唯一の真実 messagesBySession から activeSessionId で派生させる
  const messages = (activeSessionId && messagesBySession[activeSessionId]) || [];
  // ヘッダの Refs とドロワー用。チャットの messages（本文・tool_use）からクライアント側で抽出する（サーバーには取りに行かない）
  const activeMessages = activeSessionId ? messagesBySession[activeSessionId] : undefined;
  const links = useMemo(() => collectLinks(activeMessages), [activeMessages]);
  const sessionFiles = useMemo(() => collectSessionFiles(activeMessages), [activeMessages]);
  const handleCloseRefDrawer = useCallback(() => setShowRefDrawer(false), []);
  const handleJumpFromRefs = useCallback((uuid) => {
    setJumpToUuid(uuid);
    setShowRefDrawer(false);
  }, []);
  // 閲覧専用セッションは JSONL を読むだけ。chat 固定で、送信は inbox 経由（send_to_agent）
  const isReadonly = activeSession?.type === 'readonly';
  const effectiveViewMode = isReadonly ? 'chat' : viewMode;
  // ホーム表示中はセッション固有の UI（ビュー切替・レビュー・Refs・入力欄）を出さない
  const sessionUiVisible = !showHome && !!activeSessionId;
  const chatPanelsVisible = sessionUiVisible && effectiveViewMode === 'chat';
  // 選択肢カードは今見ているセッションのものだけ。readonly は PTY が無いので操作できない
  const activeChoice = sessionUiVisible && !isReadonly ? activeChoiceOf(choicePrompts[activeSessionId]) : null;
  const showWorking = sessionUiVisible && !isReadonly && !activeChoice;
  // 推論中インジケータの「裏で実行中…」に出す件数（TaskStrip と同じ一覧から数える）
  const runningAgentCount = (subagentTasks[activeSessionId] || EMPTY_TASKS).filter(
    (t) => t.status === 'running',
  ).length;
  const runningShellCount = (shellTasks[activeSessionId] || EMPTY_TASKS).filter((t) => t.status === 'running').length;

  // 閲覧タブは inbox 経由（Stop hook が次の応答終了時に注入）なので、tmux ペインに繋がっていないと
  // 送っても届かない／いつ届くか分からない。送信前に気づけるよう入力欄の直上に出す
  const readonlyDelivery = isReadonly ? readonlyDeliveryState(activeSession, runningSessions) : null;
  let readonlyNotice = null;
  if (readonlyDelivery?.kind === 'tmux') {
    const r = readonlyDelivery.running;
    readonlyNotice = (
      <>
        <span
          className="input-notice-text"
          title="tmux に接続していません。送信は inbox に溜まり、Claude の次の応答が終わるまで届きません"
        >
          未接続
        </span>
        <span className="input-notice-sep">·</span>
        <button
          className="input-notice-action"
          onClick={() =>
            handleAttachTmux({
              paneId: r.paneId,
              name: activeSession.name,
              cwd: r.cwd,
              target: r.tmuxTarget,
              claudePid: r.pid,
              claudeSessionId: r.sessionId,
              status: r.status,
            })
          }
        >
          tmux ペインに接続
        </button>
      </>
    );
  } else if (readonlyDelivery?.kind === 'running') {
    readonlyNotice = (
      <span
        className="input-notice-text"
        title="tmux 外で起動中のため直接は送れません。送信は Claude の次の応答が終わるまで届きません"
      >
        tmux 外で起動中
      </span>
    );
  } else if (readonlyDelivery?.kind === 'stopped' && activeSession?.claudeSessionId) {
    readonlyNotice = (
      <>
        <span
          className="input-notice-text"
          title="このセッションは起動していません。送信しても再開して応答が返るまで届きません"
        >
          未接続
        </span>
        <span className="input-notice-sep">·</span>
        <button
          className="input-notice-action"
          onClick={() => {
            // window を作れない失敗（tmux 未インストール等）は home_error としてホームのバナーにしか出ないのでホームへ移る。
            // window ができれば session_opened で新しい tmux タブ（起動中の表示）に切り替わる
            setShowHome(true);
            handleResumeInTmux({
              claudeSessionId: activeSession.claudeSessionId,
              name: activeSession.name,
              cwd: activeSession.cwd,
              projectDir: activeSession.projectDir,
            });
          }}
        >
          tmux で再開
        </button>
      </>
    );
  }

  // トップバーのパネルのタブ。出す条件は従来のボタンと同じ（ホーム表示中はセッション固有のものを出さない）
  const reviewCount = reviewItems.filter((it) => (it.text || '').trim()).length;
  const headerPanels = [
    sessionUiVisible &&
      !isReadonly && {
        key: 'files',
        label: 'Files',
        icon: TbFiles,
        active: showFileExplorer,
        onClick: () => setShowFileExplorer(!showFileExplorer),
        title: 'ファイラを表示/非表示',
      },
    chatPanelsVisible && {
      key: 'review',
      label: 'Review',
      icon: TbChecklist,
      active: showReviewPanel,
      onClick: () => setShowReviewPanel(!showReviewPanel),
      count: reviewCount,
      title: 'レビュー（指摘を溜めて Submit で一括送信）',
    },
    chatPanelsVisible && {
      key: 'refs',
      label: 'Refs',
      icon: TbBookmarks,
      active: showRefDrawer,
      onClick: () => setShowRefDrawer(!showRefDrawer),
      count: links.length + sessionFiles.length + pins.length,
      title: 'このセッションでやり取りしたリンク・ファイルと、ピン留めしたメッセージ',
    },
  ].filter(Boolean);
  // トップバーの「今見ているセッション」。共有モードでセンシティブ指定のものは名前を出さない
  // （表示中なら effect がホームへ退避させるが、その 1 フレームでも出さないよう表示側でも弾く）
  const activeHidden = shareMode && activeSession?.claudeSessionId && sensitiveIds.has(activeSession.claudeSessionId);
  const currentSessionForBar =
    sessionUiVisible && activeSession && !activeHidden
      ? {
          title: activeSession.name,
          cwd: activeSession.cwd,
          color: dirColorOfCwd(activeSession.cwd),
          claudeSessionId: activeSession.claudeSessionId || null,
        }
      : null;
  const hiddenSensitiveCount = shareMode
    ? countHiddenSensitive(sensitiveSessions, { tabs: sessions, running: runningSessions, recent: recentSessions })
    : 0;

  return (
    <div className="app">
      <TopBar
        connected={connected}
        currentSession={currentSessionForBar}
        viewMode={viewMode}
        onChangeViewMode={sessionUiVisible && !isReadonly ? setViewMode : null}
        panels={headerPanels}
        contextUsage={sessionUiVisible ? latestContextUsage(messages) : null}
        rateLimits={rateLimits}
        shareMode={shareMode}
        onToggleShareMode={handleToggleShareMode}
        hiddenCount={hiddenSensitiveCount}
        notifySupported={'Notification' in window}
        notifyEnabled={notifyEnabled}
        onToggleNotify={handleToggleNotify}
        appTheme={appTheme}
        onToggleTheme={handleToggleTheme}
      />

      <div className="app-body">
        <SessionTabs
          sessions={orderedSessions}
          groups={tabGroups}
          groupActions={tabGroupActions}
          groupColors={tabGroupState.colors}
          activeSessionId={showHome ? null : activeSessionId}
          homeActive={showHome}
          attentionIds={attentionIds}
          sensitiveIds={sensitiveIds}
          starredIds={starredIds}
          pipSessionId={pipPreview?.sessionId ?? pipDiff?.sessionId}
          contextBySession={contextBySession}
          shareMode={shareMode}
          onHome={() => setShowHome(true)}
          onSelect={handleSwitchSession}
          onKill={handleKillSession}
          onRestart={handleRestartSession}
          onRemovePast={handleRemovePastSession}
          onDetachTmux={handleDetachTmux}
          onTerminateTmux={handleTerminateTmuxTab}
          onCloseReadonly={handleCloseReadonly}
          onToggleStar={handleToggleStar}
          onToggleSensitive={handleToggleSensitive}
          onNew={() => setShowNewSession(true)}
          onReorder={handleReorderTab}
        />

        <div className="app-workspace">
          <div className="app-content">
            {showFileExplorer && sessionUiVisible && (
              <FileExplorer
                cwd={sessions.find((s) => s.id === activeSessionId)?.cwd}
                onOpenPreview={handleOpenPreview}
              />
            )}
            {/* 推論中の行・タスクのチップ列・選択肢カード・入力欄は本文の列（ファイラ・右パネルの間）の直下に置く。
                ファイラや右パネルは画面の下端まで伸び、開くとその幅だけ本文の列が縮む */}
            <main className={`app-main${showHome ? '' : ' with-bottom'}`}>
              {showHome ? (
                <HomeView
                  dirColorOf={dirColorOfCwd}
                  runningSessions={runningSessions}
                  recentSessions={recentSessions}
                  recentDays={recentDays}
                  onChangeRecentDays={setRecentDays}
                  includeHeadless={includeHeadless}
                  onChangeIncludeHeadless={setIncludeHeadless}
                  recentPeriod={recentPeriod}
                  onChangeRecentPeriod={setRecentPeriod}
                  starred={starredSessions}
                  onToggleStar={handleToggleStar}
                  sensitive={sensitiveSessions}
                  shareMode={shareMode}
                  onToggleSensitive={handleToggleSensitive}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  loading={runningSessions === null}
                  recentLoading={recentSessions === null}
                  heatmap={heatmap}
                  heatmapLoading={heatmapLoading}
                  onRefreshHeatmap={requestHeatmap}
                  calendar={calendar}
                  calendarLoading={calendarLoading}
                  onRequestCalendar={requestCalendar}
                  sessionTurns={sessionTurns}
                  onRequestSessionTurns={requestSessionTurns}
                  recentExchanges={recentExchanges}
                  onRequestRecentExchanges={requestRecentExchanges}
                  error={homeError}
                  onDismissError={() => setHomeError(null)}
                  notice={homeNotice}
                  onDismissNotice={() => setHomeNotice(null)}
                  restorable={restorable}
                  onResumeRestorable={(ids) => {
                    setHomeError(null);
                    setHomeNotice(null);
                    send({ type: 'resume_restorable_tabs', ...(ids ? { claudeSessionIds: ids } : {}) });
                  }}
                  onDismissRestorable={(ids) =>
                    send({ type: 'dismiss_restorable_tabs', ...(ids ? { claudeSessionIds: ids } : {}) })
                  }
                  onRefresh={() => {
                    setHomeError(null);
                    setHomeNotice(null);
                    send({ type: 'list_running_sessions' });
                    send({
                      type: 'list_recent_sessions',
                      days: recentDays,
                      starred: starredSessions,
                      includeHeadless,
                      ...(recentPeriod ? { period: { from: recentPeriod.from, to: recentPeriod.to } } : {}),
                    });
                    requestHeatmap();
                  }}
                  onSelectTab={handleSwitchSession}
                  onAttachTmux={handleAttachTmux}
                  onTerminateTmux={handleTerminateTmux}
                  onOpenReadonly={handleOpenReadonly}
                  onResume={handleResumeSession}
                  onResumeInTmux={handleResumeInTmux}
                />
              ) : activeSessionId ? (
                effectiveViewMode === 'raw' ? (
                  <TerminalView sessionId={activeSessionId} on={on} onResize={handleResize} send={send} />
                ) : (
                  <ChatView
                    messages={messages}
                    sessionCwd={sessions.find((s) => s.id === activeSessionId)?.cwd}
                    onAddAnchoredReview={handleAddAnchoredReview}
                    jumpToUuid={jumpToUuid}
                    onJumpDone={handleJumpDone}
                    onOpenPreview={handleOpenPreview}
                    onPreviewMarkdown={handlePreviewMarkdown}
                    onOpenFileReview={handleOpenFileReview}
                    onPickMessageForReview={handlePickMessageForReview}
                    pins={pins}
                    onTogglePin={handleTogglePin}
                    onOpenTaskNotice={handleOpenTaskNotice}
                    sessionId={activeSessionId}
                  />
                )
              ) : (
                <div className="empty-state">
                  <p>セッションがありません</p>
                  <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
                    新しいセッションを作成
                  </button>
                </div>
              )}
              {!showHome && (
                <div className="app-main-bottom">
                  {showWorking && (
                    <WorkingIndicator
                      status={activeSession?.status}
                      waitingFor={activeSession?.waitingFor}
                      messages={activeMessages}
                      pendingSince={pendingTurns[activeSessionId]}
                      runningAgents={runningAgentCount}
                      runningShells={runningShellCount}
                    />
                  )}
                  {sessionUiVisible && (
                    <TaskStrip
                      tasks={subagentTasks[activeSessionId] || EMPTY_TASKS}
                      shellTasks={shellTasks[activeSessionId] || EMPTY_TASKS}
                      onOpenTask={handleOpenSubagentTask}
                      onOpenShellTask={handleOpenShellTask}
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

                  {isReadonly ? (
                    <InputBar
                      key={activeSessionId}
                      draftKey={activeSessionId}
                      onSubmit={handleSendToReadonly}
                      disabled={!activeSession?.claudeSessionId}
                      placeholder="このセッションに送信（claude-bridge → inbox 経由）..."
                      slashCommands={slashCommands[activeSessionId] || []}
                      notice={readonlyNotice}
                      onLocalCommand={handleLocalCommand}
                      sessionId={activeSessionId}
                      shareMode={shareMode}
                    />
                  ) : (
                    <InputBar
                      key={activeSessionId}
                      draftKey={activeSessionId}
                      onSubmit={handleInput}
                      disabled={!activeSessionId}
                      slashCommands={slashCommands[activeSessionId] || []}
                      onSendEscape={handleSendEscape}
                      onLocalCommand={handleLocalCommand}
                      sessionId={activeSessionId}
                      shareMode={shareMode}
                    />
                  )}
                </div>
              )}
            </main>

            {showReviewPanel && chatPanelsVisible && (
              <ReviewDraftPanel
                items={reviewItems}
                incomingAnchor={incomingAnchor}
                readonly={isReadonly}
                onSave={handleSaveReview}
                onSubmit={handleSubmitReview}
                onClose={() => setShowReviewPanel(false)}
              />
            )}
          </div>
        </div>
      </div>

      {showNewSession && (
        <NewSessionDialog
          onClose={() => {
            setShowNewSession(false);
            setClaudeSessions(null);
            setFoundClaudeSessions(null);
            setTmuxPanes(null);
            setNewSessionError(null);
            setNewSessionDraft(null);
          }}
          onCreate={handleCreateSession}
          onResume={handleResumeSession}
          onResumeInTmux={handleResumeInTmux}
          onFindClaudeSessions={handleFindClaudeSessions}
          foundClaudeSessions={foundClaudeSessions}
          onAttachTmux={handleAttachTmux}
          onOpenReadonly={handleOpenReadonly}
          onRequestClaudeSessions={handleRequestClaudeSessions}
          onRequestTmuxPanes={handleRequestTmuxPanes}
          claudeSessions={claudeSessions}
          tmuxPanes={tmuxPanes}
          recentDirs={recentDirs}
          onRequestRecentDirs={handleRequestRecentDirs}
          error={newSessionError}
          initialValues={newSessionError ? newSessionDraft : null}
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
          onOpenPreview={handleOpenPreview}
          onClose={() => setSubagentDrawer(null)}
        />
      )}

      {showRefDrawer && (
        <RefDrawer
          links={links}
          files={sessionFiles}
          pins={pins}
          messages={activeMessages}
          cwd={activeSession?.cwd}
          onOpenPreview={handleOpenPreview}
          onJumpToMessage={handleJumpFromRefs}
          onUnpin={handleUnpin}
          onClose={handleCloseRefDrawer}
        />
      )}

      {shellDrawer && (
        <ShellOutputDrawer
          taskId={shellDrawer.taskId}
          label={shellDrawer.label}
          status={shellDrawer.status}
          exitCode={shellDrawer.exitCode}
          text={shellDrawer.text}
          truncated={shellDrawer.truncated}
          onRequestOutput={handleRequestShellOutput}
          onClose={() => setShellDrawer(null)}
        />
      )}

      {diffDrawer && (
        <DiffDrawer
          sessionKey={diffSessionKey}
          scope={diffDrawer.scope}
          diffRef={diffDrawer.ref}
          sources={diffDrawer.sources}
          data={diffDrawer.data}
          focusTarget={diffDrawer.focus}
          onSubmitComments={handleSubmitDiffComments}
          onChangeScope={handleChangeDiffScope}
          onChangeRef={handleChangeDiffRef}
          // 取り直しは「要求した ref」で送る。最新を見ている（null）なら最新を取り直し、‹ › や select で
          // 選んだものならそれを保つ（resolvedRef で埋めた ref を送ると、最新のつもりが特定のコミットに固定される）
          onRefresh={() =>
            requestDiff(diffDrawer.sessionId, diffDrawer.scope, null, diffDrawer.requestedRef, {
              refreshSources: true,
            })
          }
          onOpenPreview={(path) => {
            setDiffDrawer(null);
            handleOpenPreview(path);
          }}
          onClose={() => setDiffDrawer(null)}
          onOpenPip={isDocumentPipSupported() ? handleOpenDiffPip : undefined}
        />
      )}

      {pipDiff && (
        <DiffPip
          key={pipDiff.id}
          pipWindow={pipDiff.pipWindow}
          sessionKey={pipDiffSessionKey}
          scope={pipDiff.scope}
          diffRef={pipDiff.ref}
          sources={pipDiff.sources}
          data={pipDiff.data}
          onSubmitComments={handleSubmitPipDiffComments}
          onChangeScope={handleChangePipDiffScope}
          onChangeRef={handleChangePipDiffRef}
          onRefresh={() => requestPipDiff(pipDiff.scope, pipDiff.requestedRef, { refreshSources: true })}
          // 小窓のファイル名はメイン画面のプレビューで開く（小窓は残す。送信先は小窓のセッション）
          onOpenPreview={handleOpenPreviewFromDiffPip}
          onClose={handleCloseDiffPip}
        />
      )}

      {previewData && (
        <PreviewDrawer
          filePath={previewData.filePath}
          markdown={previewData.markdown}
          title={previewData.title}
          reviewMode={previewData.reviewMode}
          onClose={() => {
            setPreviewData(null);
            setDrawerOpenedAt(null);
          }}
          onReviewSubmit={(target, items) =>
            previewData.target
              ? submitFileReview(previewData.target.sessionId, previewData.target.sessionKey, target, items)
              : submitFileReview(activeSessionId, sessionKey, target, items)
          }
          responses={
            drawerOpenedAt != null
              ? (previewData.target ? messagesBySession[previewData.target.sessionId] || [] : messages)
                  .slice(drawerOpenedAt)
                  .filter((m) => m.role === 'assistant')
              : []
          }
          onOpenPip={isDocumentPipSupported() ? handleOpenPip : undefined}
        />
      )}

      {pipPreview && (
        <PreviewPip
          key={pipPreview.id}
          pipWindow={pipPreview.pipWindow}
          filePath={pipPreview.filePath}
          markdown={pipPreview.markdown}
          title={pipPreview.title}
          onClose={handleClosePip}
          onReviewSubmit={handlePipReviewSubmit}
          responses={pipResponses}
        />
      )}
    </div>
  );
}
