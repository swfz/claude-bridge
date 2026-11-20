import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { TbAlertTriangle, TbArrowUp, TbFile, TbLoader2, TbPaperclip, TbX } from 'react-icons/tb';
import {
  appendAttachmentLines,
  attachmentUploadUrl,
  formatBytes,
  hasDraggedFiles,
  isImageType,
  precheckAttachment,
  shouldAttachPaste,
  submitState,
} from '../utils/attachments.js';
import './InputBar.css';

// タブ（セッション）ごとの書きかけテキスト。InputBar は key={draftKey} で
// タブ切替のたびに remount されるため、state ではなくモジュールレベルで保持する
const drafts = new Map();

// タブごとの添付（{id, name, size, type, status: 'uploading'|'done'|'error', path, error, previewUrl}）。
// drafts と同じ理由でモジュールレベルに置く。アップロード中にタブを切り替えても完了を書き込めるよう、
// コンポーネントの state ではなくここを更新して購読者（useSyncExternalStore）に知らせる
const attachmentsByKey = new Map();
const attachmentListeners = new Set();
const NO_ATTACHMENTS = [];

function getAttachments(key) {
  return attachmentsByKey.get(key) || NO_ATTACHMENTS;
}

function setAttachments(key, updater) {
  const next = updater(getAttachments(key));
  if (next.length > 0) attachmentsByKey.set(key, next);
  else attachmentsByKey.delete(key);
  attachmentListeners.forEach((listener) => listener());
}

function subscribeAttachments(listener) {
  attachmentListeners.add(listener);
  return () => attachmentListeners.delete(listener);
}

// 外した・送ったあとに届いた結果は捨てる（id が残っているものだけ更新する）
function patchAttachment(key, id, patch) {
  setAttachments(key, (list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

function revokePreview(attachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

// 選んだ時点でサーバーに送る。保存先（cwd/.claude/bridge-attachments）はサーバーがセッションから決める
async function uploadAttachment(key, sessionId, file) {
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const precheckError = precheckAttachment(file);
  setAttachments(key, (list) => [
    ...list,
    {
      id,
      name: file.name,
      size: file.size,
      type: file.type,
      status: precheckError ? 'error' : 'uploading',
      error: precheckError,
      previewUrl: !precheckError && isImageType(file.type) ? URL.createObjectURL(file) : null,
    },
  ]);
  if (precheckError) return;
  try {
    const res = await fetch(attachmentUploadUrl(sessionId, file.name), {
      method: 'POST',
      // 独自ヘッダと octet-stream はサーバー側の CSRF 対策の条件
      headers: { 'Content-Type': 'application/octet-stream', 'X-Bridge-Upload': '1' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.path) throw new Error(data.error || `HTTP ${res.status}`);
    patchAttachment(key, id, { status: 'done', path: data.path });
  } catch (e) {
    patchAttachment(key, id, { status: 'error', error: `アップロードに失敗しました: ${e.message}` });
  }
}

const ATTACH_TITLE =
  'ファイルを添付（ドラッグ&ドロップ・貼り付けでも可）。添付ファイルは cwd/.claude/bridge-attachments に保存され、' +
  'Claude が読むと会話ログにも残ります。認証情報や顧客の個人情報を含むものは添付しないでください';

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
// 閉じるための Escape 送信で、補完ドロップダウンを Escape キーで畳む挙動とは別物。
// notice は入力欄の直上に出す注意書き（閲覧タブで「tmux 未接続なので届かない」等）
// onLocalCommand はブリッジが横取りするコマンド（/diff など）の処理。true を返したら送信しない
// sessionId は添付のアップロード先を決めるブリッジのセッション ID。shareMode 中は添付のサムネイルを出さない
export default function InputBar({
  onSubmit,
  disabled,
  placeholder,
  draftKey,
  slashCommands = [],
  onSendEscape,
  notice,
  onLocalCommand,
  sessionId,
  shareMode = false,
}) {
  const attachKey = draftKey || '';
  const attachments = useSyncExternalStore(subscribeAttachments, () => getAttachments(attachKey));
  const [dragActive, setDragActive] = useState(false);
  // 子要素をまたぐと dragenter / dragleave が交互に来るので、入った回数で外に出たかを判定する
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef(null);
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

  const sendState = submitState(text, attachments);
  const readyAttachments = attachments.filter((a) => a.status === 'done');

  const addFiles = (files) => {
    if (disabled) return;
    for (const file of files) uploadAttachment(attachKey, sessionId, file);
  };

  const removeAttachment = (id) => {
    setAttachments(attachKey, (list) => {
      list.filter((a) => a.id === id).forEach(revokePreview);
      return list.filter((a) => a.id !== id);
    });
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    // アップロード中・スラッシュコマンドに添付・空はここで止める（Enter の経路にも効かせる）
    if (disabled || !sendState.ok) return;
    if (readyAttachments.length === 0 && onLocalCommand?.(trimmed)) {
      updateText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }
    // 明示的に false が返ったら送信失敗（WS 切断中など）。書きかけと添付を消さない
    if (onSubmit(appendAttachmentLines(trimmed, readyAttachments)) === false) return;
    setText('');
    if (draftKey) drafts.delete(draftKey);
    // 失敗した添付も一緒に片付ける（サーバー上のファイルは自動では消さない）
    setAttachments(attachKey, (list) => {
      list.forEach(revokePreview);
      return [];
    });
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

  // 貼り付けにファイルだけがあるときに横取りする（テキストを含む貼り付けはそのまま。判定は shouldAttachPaste）
  const handlePaste = (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (disabled || !shouldAttachPaste(e.clipboardData?.types, files.length)) return;
    e.preventDefault();
    addFiles(files);
  };

  // ファイルのドラッグだけに反応する。dragover / drop で preventDefault しないとブラウザがファイルを開く
  const acceptsDrag = (e) => !disabled && hasDraggedFiles(e.dataTransfer?.types);

  const handleDragEnter = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e) => {
    if (!acceptsDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(Array.from(e.dataTransfer.files || []));
  };

  const handleFileChange = (e) => {
    addFiles(Array.from(e.target.files || []));
    // 同じファイルを続けて選べるよう空に戻す
    e.target.value = '';
  };

  return (
    <>
      <div
        className={`input-bar${dragActive ? ' drop-active' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
        <button
          type="button"
          className="input-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title={ATTACH_TITLE}
          aria-label="ファイルを添付"
        >
          <TbPaperclip aria-hidden="true" />
        </button>
        <input
          ref={fileInputRef}
          className="input-attach-file"
          type="file"
          multiple
          hidden
          onChange={handleFileChange}
        />
        {/* 添付のチップ列。クリップと入力欄の間に同じ行で並べる（高さは入力欄より低く固定し、溢れたら横スクロール）。
            上に重ねると直上の選択肢カードのボタンを覆うので重ねない。出し入れで変わるのは入力欄の幅だけ */}
        {attachments.length > 0 && (
          <div className="input-attachments" role="list" aria-label="添付ファイル">
            {attachments.map((a) => (
              <div
                key={a.id}
                role="listitem"
                className={`input-attachment ${a.status}`}
                title={a.error || `${a.name}（${formatBytes(a.size)}）`}
              >
                {/* 共有モードでは中身が映るサムネイルを出さない */}
                {a.previewUrl && !shareMode ? (
                  <img className="input-attachment-thumb" src={a.previewUrl} alt="" />
                ) : (
                  <TbFile className="input-attachment-icon" aria-hidden="true" />
                )}
                <span className="input-attachment-name">{a.name}</span>
                {a.status === 'uploading' && (
                  <TbLoader2 className="input-attachment-status spinning" aria-label="アップロード中" />
                )}
                {a.status === 'error' && <TbAlertTriangle className="input-attachment-status" aria-label="失敗" />}
                <button
                  type="button"
                  className="input-attachment-remove"
                  onClick={() => removeAttachment(a.id)}
                  title="添付を外す"
                  aria-label={`${a.name} の添付を外す`}
                >
                  <TbX aria-hidden="true" />
                </button>
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
          onPaste={handlePaste}
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
        {/* 届かない理由（未接続など）は帯にせず、送信ボタンの横に小さく出す。詳しい説明は title */}
        {notice && <div className="input-notice">{notice}</div>}
        {/* 送信は「送る操作」なので枠と文字だけピンクのアイコン。送れない理由は title */}
        <button
          className="input-send"
          onClick={handleSubmit}
          disabled={disabled || !sendState.ok}
          aria-label="送信"
          title={sendState.reason || '送信（Enter）'}
        >
          <TbArrowUp aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
