import { useEffect, useRef, useState } from 'react';
import './ChoicePrompt.css';

// 待ちの種類ごとの見出し。kind は画面から、waitingFor は ~/.claude/sessions の状態から来る
const KIND_LABELS = {
  question: '選択待ち',
  permission: 'ツールの許可待ち',
  other: '確認待ち',
};

function kindLabel(prompt, waitingFor) {
  if (prompt?.kind && KIND_LABELS[prompt.kind]) return KIND_LABELS[prompt.kind];
  return waitingFor === 'permission prompt' ? 'ツールの許可待ち' : '選択待ち';
}

export default function ChoicePrompt({ prompt, waitingFor, error, onAnswer, onRefresh }) {
  // 自由入力（"Type something"）を開いている選択肢の番号
  const [freeTextIndex, setFreeTextIndex] = useState(null);
  const [freeText, setFreeText] = useState('');
  const inputRef = useRef(null);

  // 質問が切り替わったら入力欄の状態を捨てる（前の質問の下書きを持ち越さない）
  useEffect(() => {
    setFreeTextIndex(null);
    setFreeText('');
  }, [prompt?.question]);

  useEffect(() => {
    if (freeTextIndex != null) inputRef.current?.focus();
  }, [freeTextIndex]);

  // 待っていないなら何も出さない。待っているのに画面が読めなかった時だけ注意を出す
  if (!prompt) {
    if (!waitingFor) return null;
    return (
      <div className="choice-prompt choice-prompt-unknown">
        <div className="choice-prompt-head">
          <span className="choice-prompt-badge">{kindLabel(null, waitingFor)}</span>
          <span className="choice-prompt-note">
            選択肢を読み取れませんでした。ターミナル側で操作するか、再読み込みしてください。
          </span>
          <button className="choice-btn-plain" onClick={onRefresh}>
            再読み込み
          </button>
        </div>
        {error && <div className="choice-prompt-error">{error}</div>}
      </div>
    );
  }

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text || freeTextIndex == null) return;
    onAnswer({ keys: [String(freeTextIndex)], text });
    setFreeTextIndex(null);
    setFreeText('');
  };

  const handleOptionClick = (option) => {
    if (option.freeText) {
      setFreeTextIndex(option.index);
      return;
    }
    // 単一選択は数字キーで即確定、multiSelect は数字キーでトグルされる
    onAnswer({ keys: [String(option.index)] });
  };

  return (
    <div className={`choice-prompt choice-prompt-${prompt.kind}`}>
      <div className="choice-prompt-head">
        <span className="choice-prompt-badge">{kindLabel(prompt, waitingFor)}</span>
        {prompt.multiSelect && <span className="choice-prompt-note">複数選択できます</span>}
        {prompt.tabs?.items?.length > 1 && (
          <span className="choice-prompt-note">{prompt.tabs.items.map((t) => t.label).join(' / ')}</span>
        )}
      </div>

      {prompt.detail && <pre className="choice-prompt-detail">{prompt.detail}</pre>}

      {prompt.question && <div className="choice-prompt-question">{prompt.question}</div>}

      <div className="choice-prompt-options">
        {prompt.options.map((option) => (
          <button
            key={option.index}
            className={`choice-option${option.cursor ? ' choice-option-cursor' : ''}${
              option.checked ? ' choice-option-checked' : ''
            }`}
            onClick={() => handleOptionClick(option)}
          >
            <span className="choice-option-key">
              {option.checked === null ? option.index : option.checked ? '☑' : '☐'}
            </span>
            <span className="choice-option-body">
              <span className="choice-option-label">{option.label}</span>
              {option.description && <span className="choice-option-desc">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>

      {freeTextIndex != null && (
        <div className="choice-prompt-freetext">
          <input
            ref={inputRef}
            className="choice-freetext-input"
            value={freeText}
            placeholder="自分の言葉で答える..."
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitFreeText();
              }
              if (e.key === 'Escape') setFreeTextIndex(null);
            }}
          />
          <button className="btn btn-primary choice-btn-send" onClick={submitFreeText} disabled={!freeText.trim()}>
            送信
          </button>
        </div>
      )}

      <div className="choice-prompt-actions">
        {prompt.multiSelect && (
          <button
            className="btn btn-primary choice-btn-send"
            onClick={() => onAnswer({ keys: ['Tab'] })}
            title="選択を確定して確認画面へ（Tab）"
          >
            確認へ進む
          </button>
        )}
        {prompt.tabs?.canNext && !prompt.multiSelect && (
          <button className="choice-btn-plain" onClick={() => onAnswer({ keys: ['Tab'] })}>
            次へ (Tab)
          </button>
        )}
        {prompt.tabs?.canPrev && (
          <button className="choice-btn-plain" onClick={() => onAnswer({ keys: ['BTab'] })}>
            戻る (Shift+Tab)
          </button>
        )}
        {prompt.canCancel && (
          <button className="choice-btn-plain" onClick={() => onAnswer({ keys: ['Escape'] })}>
            キャンセル (Esc)
          </button>
        )}
        <button className="choice-btn-plain" onClick={onRefresh}>
          再読み込み
        </button>
        <span className="choice-prompt-footer">{prompt.footer}</span>
      </div>

      {error && <div className="choice-prompt-error">{error}</div>}
    </div>
  );
}
