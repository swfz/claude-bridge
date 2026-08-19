import { useState, useRef, useEffect } from 'react';
import './InputBar.css';

// タブ（セッション）ごとの書きかけテキスト。InputBar は key={draftKey} で
// タブ切替のたびに remount されるため、state ではなくモジュールレベルで保持する
const drafts = new Map();

export default function InputBar({ onSubmit, disabled, placeholder, draftKey }) {
  const [text, setText] = useState(() => (draftKey && drafts.get(draftKey)) || '');
  const textareaRef = useRef(null);

  const adjustHeight = (el) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  // 下書き復元時（remount 直後）に textarea の高さを内容に合わせる
  useEffect(() => {
    if (textareaRef.current && textareaRef.current.value) {
      adjustHeight(textareaRef.current);
    }
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
    if (draftKey) drafts.delete(draftKey);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e) => {
    setText(e.target.value);
    if (draftKey) drafts.set(draftKey, e.target.value);
    adjustHeight(e.target);
  };

  return (
    <div className="input-bar">
      <textarea
        ref={textareaRef}
        className="input-textarea"
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={
          placeholder ||
          (disabled ? 'セッションを作成してください' : 'メッセージを入力... (Enter で送信、Shift+Enter で改行)')
        }
        disabled={disabled}
        rows={1}
      />
      <button className="btn btn-primary input-send" onClick={handleSubmit} disabled={disabled || !text.trim()}>
        送信
      </button>
    </div>
  );
}
