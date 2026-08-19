import { useCallback, useRef, useState } from 'react';
import './CommentPanel.css';

// セッションに残すコメント（送信されない・参照専用）のパネル。
// 上部の入力欄からセッションに対して直接コメントを追加し、一覧で見返す・削除する。
export default function CommentPanel({ comments, onAdd, onDelete, onJump, onClose }) {
  const [text, setText] = useState('');
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
      setWidth(Math.max(240, Math.min(startWidth.current + delta, 800)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handleAdd = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText('');
  };

  const handleKeyDown = (e) => {
    // Cmd/Ctrl+Enter で追加（通常の Enter は改行）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleAdd();
    }
  };

  // 新しい順に並べる
  const sorted = [...comments].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return (
    <div className="comment-panel" style={{ width, minWidth: width }}>
      <div className="comment-resize-handle" onMouseDown={onDragStart} />
      <div className="comment-panel-header">
        <h3>
          コメント
          {comments.length > 0 && <span className="comment-count-badge">{comments.length}</span>}
        </h3>
        <button className="comment-panel-close" onClick={onClose} title="閉じる">
          x
        </button>
      </div>

      <div className="comment-panel-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="このセッションにコメントを残す（送信されません / Cmd+Enterで追加）..."
          rows={2}
        />
        <button onClick={handleAdd} disabled={!text.trim()}>
          追加
        </button>
      </div>

      <div className="comment-panel-body">
        {sorted.length === 0 ? (
          <p className="comment-panel-empty">
            コメントなし — 上の欄からセッションにコメントを残せます（送信されません）
          </p>
        ) : (
          sorted.map((c) => {
            const quote = c.anchor?.quote || c.messageSnippet || '';
            const jumpable =
              (c.anchor?.type === 'message' && c.anchor.messageUuid) ||
              (c.anchor?.type === 'file' && c.anchor.filePath);
            return (
              <div key={c.id} className="comment-panel-item">
                <div
                  className={`comment-panel-item-main ${jumpable ? 'jumpable' : ''}`}
                  onClick={jumpable ? () => onJump?.(c.anchor) : undefined}
                  title={
                    jumpable
                      ? c.anchor.type === 'file'
                        ? '該当ファイルのプレビューを開く'
                        : '該当メッセージへ移動'
                      : undefined
                  }
                >
                  {/* どの箇所に対するコメントか（引用 / ファイル） */}
                  {c.anchor?.type === 'file' && (
                    <div className="comment-panel-snippet">📄 {(c.anchor.filePath || '').split('/').pop()}</div>
                  )}
                  {quote && (
                    <div className="comment-panel-snippet">
                      “{quote.slice(0, 80)}
                      {quote.length > 80 ? '…' : ''}”
                    </div>
                  )}
                  <div className="comment-panel-text">{c.text}</div>
                  <div className="comment-panel-time">
                    {c.timestamp ? new Date(c.timestamp).toLocaleString('ja-JP') : ''}
                  </div>
                </div>
                <button className="comment-panel-delete" onClick={() => onDelete?.(c.id)} title="このコメントを削除">
                  x
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
