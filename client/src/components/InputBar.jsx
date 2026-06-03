import { useState, useRef } from "react";
import "./InputBar.css";

export default function InputBar({ onSubmit, disabled, placeholder }) {
  const [text, setText] = useState("");
  const textareaRef = useRef(null);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
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
          (disabled
            ? "セッションを作成してください"
            : "メッセージを入力... (Enter で送信、Shift+Enter で改行)")
        }
        disabled={disabled}
        rows={1}
      />
      <button
        className="btn btn-primary input-send"
        onClick={handleSubmit}
        disabled={disabled || !text.trim()}
      >
        送信
      </button>
    </div>
  );
}
