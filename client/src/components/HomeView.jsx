import {
  annotateRunningSessions,
  annotateRecentSessions,
  findUnmatchedTabs,
  statusClass,
  formatElapsed,
} from "../utils/runningSessions.js";
import { isStarred, sortStarredFirst } from "../utils/starredSessions.js";
import { parseCwd } from "../utils/cwdLabel.js";
import "./HomeView.css";

// 「直近のセッション」の期間プリセット
const DAY_PRESETS = [1, 3, 7, 30];

// cwd を「親ディレクトリ + 末尾」に分けて表示（末尾を強調して識別しやすくする）
function Cwd({ cwd, branch }) {
  if (!cwd) return null;
  const parts = cwd.split("/");
  const base = parts.pop();
  const parent = parts.join("/");
  return (
    <div className="home-card-cwd" title={cwd}>
      {parent && <span className="home-cwd-parent">{parent}/</span>}
      <span className="home-cwd-base">{base}</span>
      {branch && <span className="home-branch">{branch}</span>}
    </div>
  );
}

// 「未解決／続きをやる」の印。カードのクリック（＝開く）とは分けたいので伝播を止める。
function StarButton({ on, onToggle }) {
  return (
    <button
      className={`home-star ${on ? "on" : ""}`}
      title={on ? "Star を外す" : "未解決（続きをやる）として Star を付ける"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

// タイトル行に出すプロジェクト名（worktree があれば併記）。タブの下段と同じ parseCwd を使う。
function ProjectChip({ cwd }) {
  const { project, worktree } = parseCwd(cwd);
  if (!project) return null;
  return (
    <span className="home-card-project" title={cwd}>
      {project}
      {worktree && <span className="home-card-worktree">⎇ {worktree}</span>}
    </span>
  );
}

// カード内の会話抜粋（冒頭の依頼・直近のやりとり）。中身が分かる最低限の情報。
function Snippet({ label, text, role }) {
  if (!text) return null;
  return (
    <div className={`home-snippet ${role || ""}`} title={text}>
      <span className="home-snippet-label">{label}</span>
      <span className="home-snippet-text">{text}</span>
    </div>
  );
}

// ホーム画面。今このマシンで起動している Claude セッションと、
// 直近 N 日に動いていた（終了済みを含む）セッションを一覧する。
export default function HomeView({
  runningSessions,
  recentSessions,
  recentDays,
  onChangeRecentDays,
  starred,
  onToggleStar,
  sessions,
  activeSessionId,
  loading,
  recentLoading,
  error,
  onDismissError,
  onRefresh,
  onSelectTab,
  onAttachTmux,
  onOpenReadonly,
  onResume,
  onResumeInTmux,
  onNew,
}) {
  // Star を付けたものは「続きをやる」印なので、それぞれの一覧で先頭に寄せる
  const annotated = sortStarredFirst(
    annotateRunningSessions(runningSessions, sessions),
    starred
  );
  const recent = sortStarredFirst(
    annotateRecentSessions(recentSessions, runningSessions, sessions),
    starred
  );
  const otherTabs = findUnmatchedTabs(runningSessions, sessions, recentSessions);
  const starredCount = [...annotated, ...recent].filter((s) =>
    isStarred(starred, s.sessionId)
  ).length;

  // タブの識別名はカードに出しているサマリー（AI タイトル）を優先する。
  // r.name は自動生成スラッグで中身が分からないことが多い。
  const tabName = (r) => r.title || r.name || r.sessionId.slice(0, 8);

  const openTmux = (r) => {
    onAttachTmux({
      paneId: r.paneId,
      name: tabName(r),
      cwd: r.cwd,
      target: r.tmuxTarget,
      claudePid: r.pid,
      claudeSessionId: r.sessionId,
      status: r.status,
    });
  };

  const openReadonly = (r) => {
    onOpenReadonly({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
      projectDir: r.projectDir,
    });
  };

  const resume = (r) => {
    onResume({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
      projectDir: r.projectDir,
    });
  };

  const resumeInTmux = (r) => {
    onResumeInTmux({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
    });
  };

  // カード全体のクリックは「一番やりたいこと」に割り当てる:
  // 開いていればそのタブへ移動、tmux ペインがあれば接続、無ければ閲覧で開く。
  const handleCardClick = (r) => {
    if (r.openTab) onSelectTab(r.openTab.id);
    else if (r.paneId) openTmux(r);
    else openReadonly(r);
  };

  return (
    <div className="home-view">
      <div className="home-header">
        <h2 className="home-title">起動中の Claude セッション</h2>
        <div className="home-header-actions">
          {starredCount > 0 && (
            <span className="home-count starred-count" title="Star を付けたセッション">
              ★ {starredCount}
            </span>
          )}
          <span className="home-count">{annotated.length} 件</span>
          <button className="btn btn-ghost" onClick={onRefresh} title="一覧を更新">
            更新
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            新しいセッション
          </button>
        </div>
      </div>

      {error && (
        <div className="home-error">
          <span className="home-error-text">{error}</span>
          <button className="home-error-close" onClick={onDismissError} title="閉じる">
            ×
          </button>
        </div>
      )}

      {annotated.length === 0 ? (
        <p className="home-empty">
          {loading
            ? "読み込み中..."
            : "起動中の Claude セッションはありません（tmux やターミナルで claude を起動すると表示されます）"}
        </p>
      ) : (
        <div className="home-grid">
          {annotated.map((r) => {
            // タブとして開いていればその表示名をそのまま使い、カードとタブの見出しを一致させる
            const label = r.openTab?.name || tabName(r);
            const starredNow = isStarred(starred, r.sessionId);
            return (
              <div
                key={r.sessionId}
                className={`home-card ${r.openTab ? "open" : ""} ${
                  r.openTab && r.openTab.id === activeSessionId ? "active" : ""
                } ${starredNow ? "starred" : ""}`}
                onClick={() => handleCardClick(r)}
              >
                <div className="home-card-top">
                  <span
                    className={`home-status home-status-${statusClass(r.status)}`}
                    title={r.status || "unknown"}
                  />
                  <ProjectChip cwd={r.cwd} />
                  <span className="home-card-name">{label}</span>
                  {r.kind && <span className="home-badge kind">{r.kind}</span>}
                  {r.openTab ? (
                    <span className="home-badge open-badge">
                      タブで表示中
                      {r.openTab.type === "readonly"
                        ? "（閲覧）"
                        : r.openTab.type === "tmux"
                          ? "（tmux）"
                          : ""}
                    </span>
                  ) : (
                    <span className="home-badge closed-badge">未オープン</span>
                  )}
                  <StarButton
                    on={starredNow}
                    onToggle={() => onToggleStar(r.sessionId)}
                  />
                </div>

                {/* 見出しに使わなかった側の名前（AI タイトル / スラッグ）も併記する */}
                {(() => {
                  const sub = [r.title, r.name].find((t) => t && t !== label);
                  return sub ? <div className="home-card-title">{sub}</div> : null;
                })()}

                <Cwd cwd={r.cwd} branch={r.gitBranch} />

                <Snippet label="冒頭" text={r.firstUserMessage} />
                <Snippet label="直近" text={r.lastUserMessage} />
                <Snippet label="応答" text={r.lastAssistantMessage} role="assistant" />

                <div className="home-card-meta">
                  <span>pid {r.pid}</span>
                  {r.tmuxTarget && <span>tmux {r.tmuxTarget}</span>}
                  {r.status && <span>{r.status}</span>}
                  <span>{formatElapsed(r.updatedAt)}</span>
                </div>

                <div className="home-card-actions" onClick={(e) => e.stopPropagation()}>
                  {r.openTab ? (
                    <button
                      className="home-action primary"
                      onClick={() => onSelectTab(r.openTab.id)}
                    >
                      タブへ移動
                    </button>
                  ) : (
                    <>
                      {r.paneId && (
                        <button className="home-action primary" onClick={() => openTmux(r)}>
                          tmux で開く
                        </button>
                      )}
                      <button className="home-action" onClick={() => openReadonly(r)}>
                        閲覧で開く
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="home-section">
        <div className="home-header">
          <h3 className="home-subtitle">直近のセッション（起動していないもの）</h3>
          <div className="home-header-actions">
            <div className="home-days">
              {DAY_PRESETS.map((d) => (
                <button
                  key={d}
                  className={`home-day ${d === recentDays ? "active" : ""}`}
                  onClick={() => onChangeRecentDays(d)}
                >
                  {d}日
                </button>
              ))}
            </div>
            <span className="home-count">{recent.length} 件</span>
          </div>
        </div>

        {recent.length === 0 ? (
          <p className="home-empty">
            {recentLoading
              ? "読み込み中..."
              : `直近 ${recentDays} 日に動いていたセッションはありません`}
          </p>
        ) : (
          <div className="home-grid">
            {recent.map((s) => {
              const label = s.openTab?.name || tabName(s);
              const starredNow = isStarred(starred, s.sessionId);
              return (
                <div
                  key={s.sessionId}
                  className={`home-card recent ${s.openTab ? "open" : ""} ${
                    s.openTab && s.openTab.id === activeSessionId ? "active" : ""
                  } ${starredNow ? "starred" : ""}`}
                  onClick={() =>
                    s.openTab ? onSelectTab(s.openTab.id) : openReadonly(s)
                  }
                >
                  <div className="home-card-top">
                    <ProjectChip cwd={s.cwd} />
                    <span className="home-card-name">{label}</span>
                    {s.openTab && (
                      <span className="home-badge open-badge">タブで表示中</span>
                    )}
                    <StarButton
                      on={starredNow}
                      onToggle={() => onToggleStar(s.sessionId)}
                    />
                  </div>

                  <Cwd cwd={s.cwd} branch={s.gitBranch} />

                  <Snippet label="冒頭" text={s.firstUserMessage} />
                  <Snippet label="直近" text={s.lastUserMessage} />
                  <Snippet
                    label="応答"
                    text={s.lastAssistantMessage}
                    role="assistant"
                  />

                  <div className="home-card-meta">
                    <span>{formatElapsed(s.updatedAt)}</span>
                    <span>{Math.round((s.size || 0) / 1024)} KB</span>
                    <span className="home-sid">{s.sessionId.slice(0, 8)}</span>
                  </div>

                  <div
                    className="home-card-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.openTab ? (
                      <button
                        className="home-action"
                        onClick={() => onSelectTab(s.openTab.id)}
                      >
                        タブへ移動
                      </button>
                    ) : (
                      <button className="home-action" onClick={() => openReadonly(s)}>
                        閲覧で開く
                      </button>
                    )}
                    <button
                      className="home-action primary"
                      onClick={() => resumeInTmux(s)}
                      title="tmux に新しい window を作って claude --resume で起こす。ブリッジを落としても生き残り、ターミナルからも操作できる"
                    >
                      tmux で再開
                    </button>
                    <button
                      className="home-action"
                      onClick={() => resume(s)}
                      title="ブリッジ内で claude を起動（サーバーを落とすと終了・ブラウザからのみ操作）"
                    >
                      再開（内蔵）
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {otherTabs.length > 0 && (
        <div className="home-section">
          <h3 className="home-subtitle">
            その他の開いているタブ（一覧に紐づかないもの）
          </h3>
          <div className="home-tab-list">
            {otherTabs.map((s) => (
              <button
                key={s.id}
                className={`home-tab-item ${s.id === activeSessionId ? "active" : ""} ${
                  s.alive ? "" : "dead"
                }`}
                onClick={() => s.alive && onSelectTab(s.id)}
                disabled={!s.alive}
              >
                <span className="home-tab-name">{s.name}</span>
                <span className="home-tab-cwd" title={s.cwd}>
                  {(s.cwd || "").split("/").pop()}
                </span>
                {s.type && s.type !== "pty" && (
                  <span className="home-badge kind">{s.type}</span>
                )}
                {!s.alive && <span className="home-badge closed-badge">終了</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
