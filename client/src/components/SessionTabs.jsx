import "./SessionTabs.css";

export default function SessionTabs({
  sessions,
  activeSessionId,
  onSelect,
  onKill,
  onRestart,
  onRemovePast,
  onNew,
}) {
  return (
    <div className="session-tabs">
      <div className="tabs-list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`tab ${session.id === activeSessionId ? "active" : ""} ${!session.alive ? "dead" : ""}`}
            onClick={() => session.alive && onSelect(session.id)}
          >
            <span className="tab-name">{session.name}</span>
            <span className="tab-cwd" title={session.cwd}>
              {session.cwd.split("/").pop()}
            </span>
            {session.alive ? (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onKill(session.id);
                }}
                title="セッションを終了"
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
