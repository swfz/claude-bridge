import "./SessionTabs.css";

export default function SessionTabs({
  sessions,
  activeSessionId,
  homeActive,
  onHome,
  onSelect,
  onKill,
  onRestart,
  onRemovePast,
  onDetachTmux,
  onCloseReadonly,
  onNew,
}) {
  return (
    <div className="session-tabs">
      <button
        className={`tab-home ${homeActive ? "active" : ""}`}
        onClick={onHome}
        title="ホーム（起動中セッション一覧）"
      >
        ⌂ Home
      </button>
      <div className="tabs-list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`tab ${session.id === activeSessionId ? "active" : ""} ${!session.alive ? "dead" : ""}`}
            onClick={() => session.alive && onSelect(session.id)}
          >
            {session.type === "tmux" && (
              <span className="tab-badge">tmux</span>
            )}
            {session.type === "readonly" && (
              <span className="tab-badge">閲覧</span>
            )}
            {session.status && (
              <span
                className={`tab-status tab-status-${session.status}`}
                title={session.status}
              />
            )}
            <span className="tab-name">{session.name}</span>
            <span
              className={`tab-cwd ${session.type === "tmux" ? "tab-cwd-strong" : ""}`}
              title={session.cwd}
            >
              {session.cwd.split("/").pop()}
            </span>
            {session.alive ? (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  if (session.type === "tmux") {
                    onDetachTmux(session.id);
                  } else if (session.type === "readonly") {
                    onCloseReadonly(session.id);
                  } else {
                    onKill(session.id);
                  }
                }}
                title={
                  session.type === "tmux" || session.type === "readonly"
                    ? "閉じる"
                    : "セッションを終了"
                }
              >
                x
              </button>
            ) : (
              <span className="tab-dead-actions">
                <button
                  className="tab-restart"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestart(session.id);
                  }}
                  title="同じ設定で再起動"
                >
                  ↻
                </button>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemovePast(session.id);
                  }}
                  title="履歴から削除"
                >
                  x
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNew} title="新しいセッション">
        +
      </button>
    </div>
  );
}
