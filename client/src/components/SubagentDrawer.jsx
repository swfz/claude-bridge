import { useEffect, useMemo, useRef } from "react";
import { ChatMessage } from "./ChatView.jsx";
import "./SubagentDrawer.css";

// 実行中のサブエージェントの会話を取り直す間隔
const TRANSCRIPT_POLL_INTERVAL = 4000;

// サブエージェントの会話トランスクリプトを右サイドのドロワーで見せる。
// 会話の描画は ChatView の ChatMessage を再利用する（readonly 固定）。
export default function SubagentDrawer({
  agentId,
  description,
  agentType,
  status,
  messages,
  onRequestTranscript,
  onOpenPreview,
  onClose,
}) {
  const bodyRef = useRef(null);

  // 開いた直後は即取得し、実行中の間だけポーリングで追いかける
  useEffect(() => {
    if (!agentId) return;
    onRequestTranscript(agentId);
    if (status !== "running") return;
    const timer = setInterval(
      () => onRequestTranscript(agentId),
      TRANSCRIPT_POLL_INTERVAL
    );
    return () => clearInterval(timer);
  }, [agentId, status, onRequestTranscript]);

  // 新着で末尾へ
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages]);

  // ChatMessage は id を key に使うので、クライアント側で採番する
  const items = useMemo(
    () =>
      (messages || []).map((m, i) => ({
        ...m,
        id: `${agentId}-${i}`,
      })),
    [messages, agentId]
  );

  return (
    <div className="subagent-drawer-overlay" onClick={onClose}>
      <div className="subagent-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-drawer-header">
          <div className="subagent-drawer-title-area">
            <span className="subagent-drawer-title">
              {description || agentType || agentId}
            </span>
            <div className="subagent-drawer-meta">
              {agentType && (
                <span className="subagent-badge">{agentType}</span>
              )}
              <span
                className={`subagent-badge subagent-badge-status ${
                  status === "running" ? "running" : "done"
                }`}
              >
                {status === "running" ? "実行中" : "完了"}
              </span>
            </div>
          </div>
          <button className="subagent-drawer-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="subagent-drawer-body" ref={bodyRef}>
          {items.length === 0 ? (
            <div className="subagent-drawer-empty">
              {status === "running"
                ? "サブエージェントの応答を待っています..."
                : "会話がありません"}
            </div>
          ) : (
            items.map((m) => (
              <ChatMessage
                key={m.id}
                message={m}
                threads={[]}
                comments={[]}
                onOpenPreview={onOpenPreview}
                readonly
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
