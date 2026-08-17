import {
  annotateRunningSessions,
  findUnmatchedTabs,
  statusClass,
  formatElapsed,
} from "../utils/runningSessions.js";
import "./HomeView.css";

// cwd を「親ディレクトリ + 末尾」に分けて表示（末尾を強調して識別しやすくする）
function Cwd({ cwd }) {
  if (!cwd) return null;
  const parts = cwd.split("/");
  const base = parts.pop();
  const parent = parts.join("/");
  return (
    <div className="home-card-cwd" title={cwd}>
      {parent && <span className="home-cwd-parent">{parent}/</span>}
      <span className="home-cwd-base">{base}</span>
    </div>
  );
}

// ホーム画面。今このマシンで起動している Claude セッションを一覧し、
// ブリッジのタブとして開いているものにはバッジを出して区別する。
export default function HomeView({
  runningSessions,
  sessions,
  activeSessionId,
  loading,
  onRefresh,
  onSelectTab,
  onAttachTmux,
  onOpenReadonly,
  onNew,
}) {
  const annotated = annotateRunningSessions(runningSessions, sessions);
  const otherTabs = findUnmatchedTabs(runningSessions, sessions);

  const openTmux = (r) => {
    onAttachTmux({
      paneId: r.paneId,
      name: r.name || r.sessionId.slice(0, 8),
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
      name: r.name || r.sessionId.slice(0, 8),
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
          <span className="home-count">{annotated.length} 件</span>
          <button className="btn btn-ghost" onClick={onRefresh} title="一覧を更新">
            更新
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            新しいセッション
          </button>
        </div>
      </div>

      {annotated.length === 0 ? (
        <p className="home-empty">
          {loading
            ? "読み込み中..."
            : "起動中の Claude セッションはありません（tmux やターミナルで claude を起動すると表示されます）"}
        </p>
      ) : (
        <div className="home-grid">
          {annotated.map((r) => (
            <div
              key={r.sessionId}
              className={`home-card ${r.openTab ? "open" : ""} ${
                r.openTab && r.openTab.id === activeSessionId ? "active" : ""
              }`}
              onClick={() => handleCardClick(r)}
            >
              <div className="home-card-top">
                <span
                  className={`home-status home-status-${statusClass(r.status)}`}
                  title={r.status || "unknown"}
                />
                <span className="home-card-name">
                  {r.name || r.sessionId.slice(0, 8)}
                </span>
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
              </div>

              <Cwd cwd={r.cwd} />

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
          ))}
        </div>
      )}

      {otherTabs.length > 0 && (
        <div className="home-section">
          <h3 className="home-subtitle">
            その他の開いているタブ（起動中セッションに紐づかないもの）
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
