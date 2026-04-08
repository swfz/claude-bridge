import { useState, useRef, useCallback } from "react";
import "./ThreadPanel.css";

function ThreadItem({ thread, onReply, onResolve, onDelete }) {
  const [replyText, setReplyText] = useState("");
  const [expanded, setExpanded] = useState(!thread.resolved);

  const handleReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(thread.id, trimmed);
    setReplyText("");
  };

  return (
    <div className={`thread-item ${thread.resolved ? "resolved" : ""}`}>
      <div className="thread-header" onClick={() => setExpanded(!expanded)}>
        <span className="thread-indicator">
          {thread.resolved ? "done" : "open"}
        </span>
        <span className="thread-selected-text">
          {thread.selectedText.slice(0, 60)}
          {thread.selectedText.length > 60 ? "..." : ""}
        </span>
        <span className="thread-reply-count">
          {thread.replies.length} 件の返信
        </span>
        <button
          className="thread-resolve-btn"
          onClick={(e) => {
            e.stopPropagation();
            onResolve(thread.id);
          }}
          title={thread.resolved ? "未解決に戻す" : "解決済みにする"}
        >
          {thread.resolved ? "Reopen" : "Resolve"}
        </button>
        <button
          className="thread-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(thread.id);
          }}
          title="スレッドを削除"
        >
          x
        </button>
      </div>

      {expanded && (
        <div className="thread-body">
          {thread.replies.map((reply) => (
            <div key={reply.id} className={`thread-reply ${reply.role}`}>
              <span className="reply-role">
                {reply.role === "human" ? "You" : "Claude"}
              </span>
              <span className="reply-text">{reply.text}</span>
              <span className="reply-time">
                {new Date(reply.timestamp).toLocaleTimeString("ja-JP")}
              </span>
            </div>
          ))}

          {!thread.resolved && (
            <div className="thread-reply-input">
              <input
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleReply()}
                placeholder="返信を入力..."
              />
              <button onClick={handleReply} disabled={!replyText.trim()}>
                送信
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ThreadPanel({ threads, onReply, onResolve, onDelete }) {
  const unresolvedCount = threads.filter((t) => !t.resolved).length;
  const [width, setWidth] = useState(480);
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
      setWidth(Math.max(240, Math.min(startWidth.current + delta, 800)));
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
    <div className="thread-panel" style={{ width, minWidth: width }}>
      <div className="thread-resize-handle" onMouseDown={onDragStart} />
      <div className="thread-panel-header">
        <h3>
          スレッド
          {unresolvedCount > 0 && (
            <span className="unresolved-badge">{unresolvedCount}</span>
          )}
        </h3>
      </div>
      <div className="thread-panel-body">
        {threads.length === 0 ? (
          <p className="thread-empty">
            スレッドなし — メッセージの「+ スレッド」から作成
          </p>
        ) : (
          threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              onReply={onReply}
              onResolve={onResolve}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
