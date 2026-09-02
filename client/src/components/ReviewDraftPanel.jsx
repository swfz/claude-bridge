import { useCallback, useEffect, useRef, useState } from 'react';
import './ReviewDraftPanel.css';

let seq = 0;
const newItem = (text = '') => ({
  id: `r-${Date.now()}-${seq++}`,
  text,
});

// セッション横断の pending review パネル。指摘を溜めて（永続化）、Submit で一括送信。
// 送信先（PTY / inbox）はサーバーが対象セッション種別で出し分けるので、ここでは投げるだけ。
export default function ReviewDraftPanel({ items, readonly, onSave, onSubmit, onClose }) {
  const [draft, setDraft] = useState(() => (items.length ? items : [newItem()]));
  // ユーザーが編集を始めるまではサーバー由来の items（get_review の遅延到着含む）を反映する。
  const touched = useRef(false);

  const [width, setWidth] = useState(380);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    if (touched.current) return;
    setDraft(items.length ? items : [newItem()]);
  }, [items]);

  const persist = useCallback(
    (next) => {
      // 空行は保存対象から除く
      onSave(next.filter((it) => (it.text || '').trim()));
    },
    [onSave],
  );

  const updateItem = (id, text) => {
    touched.current = true;
    setDraft((prev) => prev.map((it) => (it.id === id ? { ...it, text } : it)));
  };

  // Ctrl+Enter で追加した欄にフォーカスを移すために、直近で追加した id を覚える
  const [focusId, setFocusId] = useState(null);

  const addItem = () => {
    touched.current = true;
    const item = newItem();
    setFocusId(item.id);
    setDraft((prev) => [...prev, item]);
  };

  const removeItem = (id) => {
    touched.current = true;
    setDraft((prev) => {
      const next = prev.filter((it) => it.id !== id);
      const result = next.length ? next : [newItem()];
      persist(result);
      return result;
    });
  };

  const filled = draft.filter((it) => (it.text || '').trim());

  const handleSubmit = () => {
    if (filled.length === 0) return;
    onSubmit(filled);
    touched.current = false;
    setDraft([newItem()]);
  };

  // Ctrl/Cmd+Enter で Submit、Ctrl/Cmd+Shift+Enter で次の指摘欄を追加（通常の Enter は改行）
  const handleKeyDown = (e) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (e.shiftKey) {
      addItem();
    } else {
      handleSubmit();
    }
  };

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(260, Math.min(startWidth.current + delta, 800)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div className="review-draft-panel" style={{ width, minWidth: width }}>
      <div className="review-draft-resize-handle" onMouseDown={onDragStart} />
      <div className="review-draft-header">
        <h3>
          レビュー
          {filled.length > 0 && <span className="review-draft-count">{filled.length}</span>}
        </h3>
        <button className="review-draft-close" onClick={onClose} title="閉じる">
          x
        </button>
      </div>

      <div className="review-draft-hint">
        指摘を溜めて「Submit」で一括送信。送信先: {readonly ? 'inbox（agent が取り込む）' : 'Claude（このセッション）'}
      </div>

      <div className="review-draft-body">
        {draft.map((item, index) => (
          <div key={item.id} className="review-draft-item">
            <div className="review-draft-item-header">
              <span className="review-draft-item-number">#{index + 1}</span>
              {draft.length > 1 && (
                <button className="review-draft-item-remove" onClick={() => removeItem(item.id)} title="この指摘を削除">
                  x
                </button>
              )}
            </div>
            {item.anchor?.quote && (
              <div className="review-draft-item-quote">
                {item.anchor.type === 'file' && item.anchor.filePath
                  ? `📄 ${item.anchor.filePath.split('/').pop()}: `
                  : ''}
                “{item.anchor.quote.slice(0, 80)}
                {item.anchor.quote.length > 80 ? '…' : ''}”
              </div>
            )}
            <textarea
              className="review-draft-item-input"
              value={item.text}
              onChange={(e) => updateItem(item.id, e.target.value)}
              onBlur={() => persist(draft)}
              onKeyDown={handleKeyDown}
              autoFocus={item.id === focusId}
              placeholder={
                item.anchor?.quote
                  ? 'この箇所への指摘を入力...（Ctrl+Enterで送信 / Ctrl+Shift+Enterで欄を追加）'
                  : '指摘を入力...（Ctrl+Enterで送信 / Ctrl+Shift+Enterで欄を追加）'
              }
              rows={2}
            />
          </div>
        ))}
      </div>

      <div className="review-draft-footer">
        <button className="btn btn-ghost review-draft-add" onClick={addItem}>
          + 指摘を追加
        </button>
        <button className="btn btn-primary review-draft-submit" onClick={handleSubmit} disabled={filled.length === 0}>
          {filled.length > 1 ? `${filled.length}件をSubmit` : 'Submit'}
        </button>
      </div>
    </div>
  );
}
