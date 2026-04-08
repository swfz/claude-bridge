import { useState } from "react";
import "./ReviewPanel.css";

export default function ReviewPanel({ messageId, onSubmit, onClose }) {
  const [items, setItems] = useState([{ id: 1, text: "" }]);
  const nextId = () => Math.max(...items.map((i) => i.id)) + 1;

  const updateItem = (id, text) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, text } : i)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, { id: nextId(), text: "" }]);
  };

  const removeItem = (id) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleSubmitAll = () => {
    const filled = items.filter((i) => i.text.trim());
    if (filled.length === 0) return;
    onSubmit(filled.map((i) => i.text.trim()));
    onClose();
  };

  const handleSubmitOne = (text) => {
    if (!text.trim()) return;
    onSubmit([text.trim()]);
  };

  const filledCount = items.filter((i) => i.text.trim()).length;

  return (
    <div className="review-panel">
      <div className="review-panel-header">
        <span className="review-panel-title">
          レビューコメント ({filledCount}/{items.length})
        </span>
        <button className="review-close-btn" onClick={onClose}>
          x
        </button>
      </div>

      <div className="review-items">
        {items.map((item, index) => (
          <div key={item.id} className="review-item">
            <div className="review-item-header">
              <span className="review-item-number">#{index + 1}</span>
              {items.length > 1 && (
                <button
                  className="review-item-remove"
                  onClick={() => removeItem(item.id)}
                >
                  x
                </button>
              )}
            </div>
            <textarea
              className="review-item-input"
              value={item.text}
              onChange={(e) => updateItem(item.id, e.target.value)}
              placeholder="レビューコメントを入力..."
              rows={2}
              autoFocus={index === items.length - 1}
            />
            <button
              className="review-item-send-one"
              onClick={() => handleSubmitOne(item.text)}
              disabled={!item.text.trim()}
              title="このコメントだけ送信"
            >
              個別送信
            </button>
          </div>
        ))}
      </div>

      <div className="review-panel-footer">
        <button className="btn btn-ghost review-add-btn" onClick={addItem}>
          + コメント追加
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSubmitAll}
          disabled={filledCount === 0}
        >
          {filledCount > 1
            ? `${filledCount}件まとめて送信`
            : "送信"}
        </button>
      </div>
    </div>
  );
}
