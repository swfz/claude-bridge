import { useState, useRef, useEffect } from 'react';
import './InputBar.css';

// タブ（セッション）ごとの書きかけテキスト。InputBar は key={draftKey} で
// タブ切替のたびに remount されるため、state ではなくモジュールレベルで保持する
const drafts = new Map();

// 補完を出すのは「先頭の / から始まる 1 トークン目を打っている間」だけ。
// 空白・改行が入ったら引数を書き始めているので候補は畳む
const SLASH_QUERY_RE = /^\/([A-Za-z0-9_:-]*)$/;
const MAX_SUGGESTIONS = 50;

// 入力から候補を絞る。前方一致が無ければ部分一致にフォールバックする
function filterCommands(commands, query) {
  const q = query.toLowerCase();
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const matched = prefix.length > 0 ? prefix : commands.filter((c) => c.name.toLowerCase().includes(q));
  return matched.slice(0, MAX_SUGGESTIONS);
}

// onSendEscape は PTY を持つセッションだけに渡される。TUI で開いてしまったモーダルを
// 閉じるための Escape 送信で、補完ドロップダウンを Escape キーで畳む挙動とは別物
export default function InputBar({ onSubmit, disabled, placeholder, draftKey, slashCommands = [], onSendEscape }) {
  const [text, setText] = useState(() => (draftKey && drafts.get(draftKey)) || '');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Escape で閉じたあと、入力が変わるまでは出し直さない
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef(null);
  const listRef = useRef(null);

  const query = text.match(SLASH_QUERY_RE)?.[1];
  const suggestions = query === undefined || dismissed ? [] : filterCommands(slashCommands, query);
  const showSuggestions = suggestions.length > 0;

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

  // 絞り込み結果が変わったら先頭を選び直す
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 選択行がドロップダウンの外に出ないようスクロールする
  useEffect(() => {
    if (!showSuggestions) return;
    listRef.current?.children[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, showSuggestions]);

  const updateText = (value) => {
    setText(value);
    if (draftKey) drafts.set(draftKey, value);
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    // 明示的に false が返ったら送信失敗（WS 切断中など）。書きかけを消さない
    if (onSubmit(trimmed) === false) return;
    setText('');
    if (draftKey) drafts.delete(draftKey);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // 候補を確定して引数を書ける状態にする（末尾にスペースを付ける）
  const applySuggestion = (command) => {
    updateText(`/${command.name} `);
    setDismissed(true);
    if (textareaRef.current) {
      textareaRef.current.focus();
      adjustHeight(textareaRef.current);
    }
  };

  const handleKeyDown = (e) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      // Tab / Enter は補完の確定に使う（Enter でも送信しない）
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e) => {
    updateText(e.target.value);
    setDismissed(false);
    adjustHeight(e.target);
  };

  return (
    <div className="input-bar">
      {showSuggestions && (
        <div className="slash-suggestions" ref={listRef}>
          {suggestions.map((command, i) => (
            <div
              key={command.name}
              className={`slash-suggestion${i === selectedIndex ? ' selected' : ''}`}
              // フォーカスを textarea に残したまま確定する
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(command);
              }}
            >
              <span className="slash-suggestion-name">/{command.name}</span>
              <span className="slash-suggestion-desc">{command.description}</span>
            </div>
          ))}
        </div>
      )}
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
      {onSendEscape && (
        <button
          className="btn btn-ghost input-escape"
          onClick={onSendEscape}
          disabled={disabled}
          title="TUI で開いたパネル（/model 等）を閉じる"
        >
          Esc
        </button>
      )}
      <button className="btn btn-primary input-send" onClick={handleSubmit} disabled={disabled || !text.trim()}>
        送信
      </button>
    </div>
  );
}
