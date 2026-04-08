import { useState, useEffect } from "react";
import "./NewSessionDialog.css";

export default function NewSessionDialog({
  onClose,
  onCreate,
  onResume,
  onAttachTmux,
  onRequestClaudeSessions,
  onRequestTmuxPanes,
  claudeSessions,
  tmuxPanes,
}) {
  const [tab, setTab] = useState("new"); // "new" | "resume" | "tmux"
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (tab === "resume" && onRequestClaudeSessions) {
      onRequestClaudeSessions();
    }
    if (tab === "tmux" && onRequestTmuxPanes) {
      onRequestTmuxPanes();
    }
  }, [tab, onRequestClaudeSessions, onRequestTmuxPanes]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onCreate({
      name: name.trim() || "New Session",
      cwd: cwd.trim() || undefined,
    });
  };

  const filteredSessions = (claudeSessions || []).filter((s) => {
    if (!filter) return true;
    const lower = filter.toLowerCase();
    return (
      s.cwd.toLowerCase().includes(lower) ||
      s.firstUserMessage.toLowerCase().includes(lower) ||
      s.sessionId.includes(lower)
    );
  });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-tabs">
          <button
            className={`dialog-tab ${tab === "new" ? "active" : ""}`}
            onClick={() => setTab("new")}
          >
            新規作成
          </button>
          <button
            className={`dialog-tab ${tab === "resume" ? "active" : ""}`}
            onClick={() => setTab("resume")}
          >
            既存セッションを再開
          </button>
          <button
            className={`dialog-tab ${tab === "tmux" ? "active" : ""}`}
            onClick={() => setTab("tmux")}
          >
            tmux ペイン
          </button>
        </div>

        {tab === "tmux" ? (
          <div className="resume-panel">
            <div className="session-list">
              {!tmuxPanes ? (
                <p className="session-list-empty">読み込み中...</p>
              ) : tmuxPanes.length === 0 ? (
                <p className="session-list-empty">
                  Claude を実行中の tmux ペインが見つかりません
                </p>
              ) : (
                tmuxPanes.map((p) => (
                  <div
                    key={p.paneId}
                    className="session-list-item"
                    onClick={() =>
                      onAttachTmux({
                        paneId: p.paneId,
                        name: `tmux: ${p.target}`,
                        cwd: p.cwd,
                        target: p.target,
                      })
                    }
                  >
                    <div className="session-item-main">
                      <span className="session-item-cwd">{p.cwd}</span>
                      <span className="session-item-time">{p.target}</span>
                    </div>
                    <div className="session-item-id">
                      pane: {p.paneId} / pid: {p.panePid}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                キャンセル
              </button>
            </div>
          </div>
        ) : tab === "new" ? (
          <form onSubmit={handleSubmit}>
            <div className="dialog-field">
              <label>セッション名</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="レビュー作業"
                autoFocus
              />
            </div>
            <div className="dialog-field">
              <label>作業ディレクトリ</label>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="$HOME（デフォルト）"
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
              >
                キャンセル
              </button>
              <button type="submit" className="btn btn-primary">
                作成
              </button>
            </div>
          </form>
        ) : (
          <div className="resume-panel">
            <div className="dialog-field">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="セッションを検索（パス、メッセージ、ID）..."
                autoFocus
              />
            </div>
            <div className="session-list">
              {filteredSessions.length === 0 ? (
                <p className="session-list-empty">
                  {claudeSessions === null
                    ? "読み込み中..."
                    : "セッションが見つかりません"}
                </p>
              ) : (
                filteredSessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="session-list-item"
                    onClick={() =>
                      onResume({
                        claudeSessionId: s.sessionId,
                        name: s.firstUserMessage
                          ? s.firstUserMessage.slice(0, 40)
                          : s.sessionId.slice(0, 8),
                        cwd: s.cwd,
                        projectDir: s.projectDir,
                      })
                    }
                  >
                    <div className="session-item-main">
                      <span className="session-item-cwd">{s.cwd}</span>
                      <span className="session-item-time">
                        {new Date(s.updatedAt).toLocaleString("ja-JP")}
                      </span>
                    </div>
                    <div className="session-item-message">
                      {s.firstUserMessage || "(メッセージなし)"}
                    </div>
                    <div className="session-item-id">{s.sessionId}</div>
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
