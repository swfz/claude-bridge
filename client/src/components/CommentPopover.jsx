import { useState } from "react";
import "./CommentPopover.css";

export default function CommentPopover({
  comments,
  onAdd,
  onSendToClaude,
  onClose,
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(true);

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setText("");
  };

  return (
    <div className="comment-popover">
      <div className="comment-popover-header">
        <span>コメント ({comments.length})</span>
        <div className="comment-popover-actions">
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? "折りたたむ" : "展開"}
          </button>
          <button onClick={onClose}>x</button>
        </div>
      </div>

      {expanded && (
        <>
          <div className="comment-list">
            {comments.map((c) => (
              <div key={c.id} className="comment-item">
                <p className="comment-text">{c.text}</p>
                <div className="comment-meta">
                  <span>
                    {new Date(c.timestamp).toLocaleTimeString("ja-JP")}
                  </span>
                  <button
                    className="comment-send-btn"
                    onClick={() => onSendToClaude(c.text)}
                    title="このコメントを Claude に送る"
                  >
                    Claude に送信
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="comment-input">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="コメントを追加..."
            />
            <button onClick={handleAdd} disabled={!text.trim()}>
              追加
            </button>
          </div>
        </>
      )}
    </div>
  );
}
