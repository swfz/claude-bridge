import { useCallback, useEffect, useRef, useState } from 'react';
import { isConfirmShortcut, isDeleteItemShortcut, isSubmitAllShortcut } from '../utils/keys.js';
import './ReviewDraftPanel.css';

let seq = 0;
const newItem = (text = '') => ({
  id: `r-${Date.now()}-${seq++}`,
  text,
});

// セッション横断の pending review パネル。指摘を溜めて（永続化）、Submit で一括送信。
// 送信先（PTY / inbox）はサーバーが対象セッション種別で出し分けるので、ここでは投げるだけ。
export default function ReviewDraftPanel({ items, incomingAnchor, readonly, onSave, onSubmit, onClose }) {
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

  // チャットで数字キーで選ばれたメッセージを、引用付きの指摘欄として受け取る。
  // 末尾が「まだ何も書いていない引用なしの欄」ならそこに引用を付け、そうでなければ末尾に足す。
  // 同じメッセージを続けて選べるよう、更新の合図は nonce で受ける。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastAnchorNonce = useRef(null);
  useEffect(() => {
    if (!incomingAnchor?.nonce || incomingAnchor.nonce === lastAnchorNonce.current) return;
    lastAnchorNonce.current = incomingAnchor.nonce;
    touched.current = true;
    const prev = draftRef.current;
    const last = prev[prev.length - 1];
    if (last && !(last.text || '').trim() && !last.anchor) {
      setDraft(prev.map((it) => (it.id === last.id ? { ...it, anchor: incomingAnchor.anchor } : it)));
      setFocusId(last.id);
    } else {
      const item = { ...newItem(), anchor: incomingAnchor.anchor };
      setDraft([...prev, item]);
      setFocusId(item.id);
    }
  }, [incomingAnchor]);

  // 既にある欄に引用が付いた場合は autoFocus（マウント時のみ）では効かないので、明示的に移す
  const inputRefs = useRef(new Map());
  useEffect(() => {
    if (focusId) inputRefs.current.get(focusId)?.focus();
  }, [focusId]);

  // focusNeighbor はキーボード（Ctrl+Shift+⌫）から消したとき用。フォーカスが body に飛ぶと
  // 続けて書けなくなるので、直前の欄（先頭を消したなら残った先頭）へ移す。
  // 最後の 1 件を消した場合は作り直した空欄が行き先になる。
  const removeItem = (id, focusNeighbor = false) => {
    touched.current = true;
    const prev = draftRef.current;
    const index = prev.findIndex((it) => it.id === id);
    const rest = prev.filter((it) => it.id !== id);
    const result = rest.length ? rest : [newItem()];
    if (focusNeighbor) setFocusId(result[rest.length ? Math.max(0, index - 1) : 0].id);
    setDraft(result);
    persist(result);
  };

  const filled = draft.filter((it) => (it.text || '').trim());

  const handleSubmit = () => {
    if (filled.length === 0) return;
    onSubmit(filled);
    touched.current = false;
    setDraft([newItem()]);
  };

  // 指摘欄のキー操作（通常の Enter は改行）
  //   Ctrl/Cmd+Enter       = この指摘を確定して次の欄へ（溜める）
  //   Ctrl/Cmd+Shift+Enter = 溜めた指摘を一気に Submit
  //   Ctrl/Cmd+Shift+⌫     = この指摘を削除して直前の欄へ
  // 「書く→Ctrl+Enter で溜める→…→最後に一括送信」の流れに合わせた割り当て。
  const handleKeyDown = (e, item) => {
    if (isDeleteItemShortcut(e)) {
      e.preventDefault();
      removeItem(item.id, true);
    } else if (isSubmitAllShortcut(e)) {
      e.preventDefault();
      handleSubmit();
    } else if (isConfirmShortcut(e)) {
      e.preventDefault();
      addItem();
    }
  };

  // Submit のショートカットはパネルが開いていればフォーカス位置を問わず効かせる
  // （欄にフォーカスが無いと何も起きず「動かない」と見えるため）。指摘欄側で処理済みのもの
  // （defaultPrevented）や、プレビューのドロワーが開いている間（そちらの送信が優先）は無視する。
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  useEffect(() => {
    const handler = (e) => {
      if (!isSubmitAllShortcut(e) || e.defaultPrevented) return;
      if (document.querySelector('.drawer-overlay')) return;
      e.preventDefault();
      handleSubmitRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

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
                <button
                  className="review-draft-item-remove"
                  onClick={() => removeItem(item.id)}
                  title="この指摘を削除（Ctrl+Shift+⌫）"
                >
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
              ref={(el) => {
                if (el) inputRefs.current.set(item.id, el);
                else inputRefs.current.delete(item.id);
              }}
              value={item.text}
              onChange={(e) => updateItem(item.id, e.target.value)}
              onBlur={() => persist(draft)}
              onKeyDown={(e) => handleKeyDown(e, item)}
              autoFocus={item.id === focusId}
              placeholder={
                item.anchor?.quote
                  ? 'この箇所への指摘を入力...（Ctrl+Enterで次の欄 / Ctrl+Shift+Enterで一括送信）'
                  : '指摘を入力...（Ctrl+Enterで次の欄 / Ctrl+Shift+Enterで一括送信）'
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
        <button
          className="btn btn-primary review-draft-submit"
          onClick={handleSubmit}
          disabled={filled.length === 0}
          title="溜めた指摘を一括送信（Ctrl+Shift+Enter）"
        >
          {filled.length > 1 ? `${filled.length}件をSubmit` : 'Submit'}
        </button>
      </div>
    </div>
  );
}
