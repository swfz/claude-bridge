import { useCallback, useRef, useState } from "react";
import "./AgentSidePanel.css";

// agent view 連携パネル（一覧ランチャー）。
// agent を選ぶとメインタブに readonly セッションとして開き、会話はメインの大画面で表示する。
// 送信はメインタブの readonly 送信欄（inbox 経由）で行う。
export default function AgentSidePanel({
  agents,
  activeClaudeSessionId,
  syncNotice,
  onSelectAgent,
  onRefreshAgents,
}) {
  const [width, setWidth] = useState(360);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;
    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(280, Math.min(startWidth.current + delta, 720)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="agent-side-panel" style={{ width, minWidth: width }}>
      <div className="agent-resize-handle" onMouseDown={onDragStart} />
      <div className="agent-panel-header">
        <h3>Agents</h3>
        <div className="agent-panel-actions">
          <button onClick={onRefreshAgents} title="一覧を更新">
            更新
          </button>
        </div>
      </div>

      {syncNotice && <div className="agent-sync-notice">{syncNotice}</div>}

      <div className="agent-list">
        {!agents || agents.length === 0 ? (
          <p className="agent-list-empty">
            エージェントなし（agent view 未起動 or 取得失敗）
          </p>
        ) : (
          agents.map((a) => {
            const busy = a.status === "busy" || a.status === "working";
            const active = a.sessionId === activeClaudeSessionId;
            return (
              <div
                key={a.sessionId}
                className={`agent-list-item ${active ? "active" : ""}`}
                onClick={() => onSelectAgent(a)}
                title="クリックでメインタブに開く"
              >
                <div className="agent-item-main">
                  {a.status && (
                    <span
                      className={`pane-status pane-status-${busy ? "busy" : "idle"}`}
                      title={a.status}
                    />
                  )}
                  <span className="agent-item-name">
                    {a.name || a.sessionId.slice(0, 8)}
                  </span>
                  {a.kind && <span className="agent-item-kind">{a.kind}</span>}
                </div>
                <div className="agent-item-cwd" title={a.cwd}>
                  {a.cwd}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
