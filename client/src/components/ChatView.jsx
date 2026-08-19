import { useEffect, useRef, useState, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import { EXT_TO_LANG, highlightLines } from '../highlight.js';
import { PREVIEWABLE_EXTS, getExt } from '../utils/previewExts.js';
import FilePreview from './FilePreview.jsx';
import CodeBlock from './CodeBlock.jsx';
import './ChatView.css';

const COLLAPSE_THRESHOLD = 600; // 文字数がこれを超えたら折りたたみ

const TOOL_ICONS = {
  Bash: '$',
  Read: 'R',
  Edit: 'E',
  Write: 'W',
  Grep: 'G',
  Glob: 'G',
  Agent: 'A',
};

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);

function ToolUseItem({ tool, onOpenPreview, onOpenFileReview }) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[tool.name] || 'T';
  const filePath = FILE_TOOLS.has(tool.name) ? tool.input?.file_path : null;

  return (
    <div className="tool-use-item">
      <div className="tool-use-summary" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{tool.name}</span>
        {filePath ? (
          <span className="tool-file-preview" onClick={(e) => e.stopPropagation()}>
            <FilePreview
              href={`file://${filePath}`}
              onOpenPreview={onOpenPreview}
              onOpenFileReview={onOpenFileReview}
            />
          </span>
        ) : (
          <span className="tool-desc">{tool.summary}</span>
        )}
        <span className="tool-expand">{expanded ? '−' : '+'}</span>
      </div>
      {expanded && (
        <div className="tool-use-detail">
          {tool.name === 'Edit' ? (
            <EditDiff input={tool.input} />
          ) : (
            <pre className="tool-detail-pre">{formatToolInput(tool.name, tool.input)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function DiffLine({ sign, className, html, text }) {
  return (
    <div className={`diff-line ${className}`}>
      <span className="diff-sign">{sign}</span>
      {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <span>{text}</span>}
    </div>
  );
}

function EditDiff({ input }) {
  const filePath = input?.file_path || '';
  const oldStr = input?.old_string || '';
  const newStr = input?.new_string || '';

  const ext = filePath.split('.').pop()?.toLowerCase();
  const lang = EXT_TO_LANG[ext];

  const oldHighlighted = useMemo(() => highlightLines(oldStr, lang), [oldStr, lang]);
  const newHighlighted = useMemo(() => highlightLines(newStr, lang), [newStr, lang]);

  if (!input) return null;

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <>
      <div className="diff-file-path">{filePath}</div>
      <pre className="diff-block">
        {oldLines.map((line, i) => (
          <DiffLine key={`old-${i}`} sign="-" className="diff-removed" html={oldHighlighted?.[i]} text={line} />
        ))}
        {newLines.map((line, i) => (
          <DiffLine key={`new-${i}`} sign="+" className="diff-added" html={newHighlighted?.[i]} text={line} />
        ))}
      </pre>
    </>
  );
}

function formatToolInput(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return input.command || '';
    case 'Edit':
      return input.file_path || '';
    case 'Write':
      return `${input.file_path || ''}\n${(input.content || '').slice(0, 500)}${(input.content || '').length > 500 ? '\n...' : ''}`;
    case 'Read':
      return input.file_path || '';
    case 'Grep':
    case 'Glob':
      return `pattern: ${input.pattern || ''}${input.path ? `\npath: ${input.path}` : ''}`;
    default:
      return JSON.stringify(input, null, 2).slice(0, 500);
  }
}

function isFileUrl(href) {
  return href && (href.startsWith('file://') || href.startsWith('file:///'));
}

// プレビュー可能な拡張子を持つか判定（拡張子定義は previewExts.js に集約）
function hasPreviewableExt(text) {
  return PREVIEWABLE_EXTS.includes(getExt(text));
}

// ファイルパスを解決（相対パスは cwd を使って絶対パスに）
function resolveFilePath(text, cwd) {
  if (!text) return null;
  if (text.startsWith('/')) {
    return hasPreviewableExt(text) ? text : null;
  }
  // 相対パス: cwd があれば結合
  if (cwd && hasPreviewableExt(text)) {
    // ./ を除去
    const cleaned = text.startsWith('./') ? text.slice(2) : text;
    return `${cwd.replace(/\/$/, '')}/${cleaned}`;
  }
  return null;
}

// Markdown に渡す前に file:// URL をリンク形式に変換
// バッククォート内は除外、プレーンテキストの file:// のみ対象
function preprocessFileUrls(text) {
  // コードブロック・インラインコードの外にある file:// URL をリンクに変換
  const codeBlockPattern = /(```[\s\S]*?```|`[^`]+`)/g;
  const parts = text.split(codeBlockPattern);
  return parts
    .map((part) => {
      // コードブロック/インラインコード部分はそのまま
      if (part.startsWith('```') || part.startsWith('`')) return part;
      // file:// URL をMarkdownリンクに変換
      return part.replace(/(file:\/\/[^\s<>"')\]`]+)/g, (url) => `[${url}](${url})`);
    })
    .join('');
}

function MarkdownContent({ content, sessionCwd, onOpenPreview, onOpenFileReview }) {
  const processed = preprocessFileUrls(content);

  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkAlert]}
      urlTransform={(url) => url}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            const text = String(children).trim();
            // インラインコード内の file:// URL を FilePreview に変換
            if (isFileUrl(text)) {
              return <FilePreview href={text} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />;
            }
            // ファイルパスを FilePreview に変換（絶対パス or CWD+相対パス）
            const resolved = resolveFilePath(text, sessionCwd);
            if (resolved) {
              return (
                <FilePreview
                  href={`file://${resolved}`}
                  onOpenPreview={onOpenPreview}
                  onOpenFileReview={onOpenFileReview}
                />
              );
            }
            return (
              <code className="inline-code" {...props}>
                {children}
              </code>
            );
          }
          return <CodeBlock className={className}>{children}</CodeBlock>;
        },
        a({ href, children, ...props }) {
          if (isFileUrl(href)) {
            return <FilePreview href={href} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />;
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {processed}
    </Markdown>
  );
}

// サブエージェントのトランスクリプト（SubagentDrawer）からも使うので export する。
// その場合 threads/comments は空、操作ハンドラは渡らない（readonly 表示）。
export function ChatMessage({
  message,
  threads,
  comments,
  sessionCwd,
  onStartThread,
  onAddAnchoredReview,
  onAddAnchoredComment,
  onDeleteComment,
  onOpenPreview,
  onPreviewMarkdown,
  onOpenFileReview,
  readonly,
}) {
  const [expanded, setExpanded] = useState(false);
  // 範囲選択時に出すアクションメニュー（レビューに追加 / コメントに残す / スレッド）
  const [selMenu, setSelMenu] = useState(null);
  // 選択後に本文（指摘/コメント）を書くノート入力ポップオーバー { mode, quote, top, left, text }
  const [noteDraft, setNoteDraft] = useState(null);
  // 💬 マーカーのインラインコメント一覧の開閉
  const [showInlineComments, setShowInlineComments] = useState(false);

  // メニュー表示中は外側クリック・スクロールで閉じる
  useEffect(() => {
    if (!selMenu) return;
    const onDocMouseDown = (e) => {
      if (e.target.closest?.('.selection-menu')) return;
      setSelMenu(null);
    };
    const onScroll = () => setSelMenu(null);
    // 開いた直後の mouseup で即閉じないよう次サイクルで登録
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [selMenu]);

  const isHuman = message.role === 'human';
  const isSystem = message.role === 'system';
  const isHistory = message.isHistory;

  if (isSystem) {
    return (
      <div className="chat-message system">
        <div className="chat-message-body">
          <p>{message.content}</p>
        </div>
      </div>
    );
  }
  const messageThreads = (threads || []).filter((t) => t.messageId === message.id);
  // このメッセージ（uuid）に紐付いたコメント
  const messageComments = (comments || []).filter(
    (c) => c.anchor && c.anchor.messageUuid && c.anchor.messageUuid === message.uuid,
  );

  const isLong = (message.content || '').length > COLLAPSE_THRESHOLD;
  const shouldCollapse = isLong && !expanded;

  // 範囲選択したら、選択範囲の上にアクションメニューを出す（即 Thread 化はしない）
  const handleTextSelect = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text && text.length > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSelMenu({
        text,
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
    } else {
      setSelMenu(null);
    }
  };

  // 選択 → スレッド（従来どおり選択範囲で即開始）
  const runSelAction = (fn) => {
    if (selMenu) fn(selMenu.text);
    window.getSelection()?.removeAllRanges();
    setSelMenu(null);
  };

  // 選択 → レビュー/コメント: 選択を「対象（引用）」にしてノート入力へ。本文は別に書く。
  const openNote = (mode) => {
    if (!selMenu) return;
    setNoteDraft({ mode, quote: selMenu.text, top: selMenu.top, left: selMenu.left, text: '' });
    setSelMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const saveNote = () => {
    if (!noteDraft) return;
    const text = (noteDraft.text || '').trim();
    if (!text) return;
    const anchor = { type: 'message', messageUuid: message.uuid || null, quote: noteDraft.quote };
    if (noteDraft.mode === 'review') {
      onAddAnchoredReview?.({ anchor, text });
    } else {
      onAddAnchoredComment?.({ anchor, text });
    }
    setNoteDraft(null);
  };

  return (
    <div
      className={`chat-message ${isHuman ? 'human' : 'assistant'} ${isHistory ? 'history' : ''}`}
      data-message-uuid={message.uuid || undefined}
    >
      <div className="chat-message-header">
        <span className="chat-role">{isHuman ? 'You' : 'Claude'}</span>
        <span className="chat-time">{new Date(message.timestamp).toLocaleTimeString('ja-JP')}</span>
        {messageComments.length > 0 && (
          <button
            className="comment-marker"
            onClick={() => setShowInlineComments((v) => !v)}
            title="このメッセージへのコメント"
          >
            💬 {messageComments.length}
          </button>
        )}
        {isLong && (
          <button className="expand-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? '折りたたむ' : '全文表示'}
          </button>
        )}
        {!isHuman && (
          <div className="header-actions">
            {onPreviewMarkdown && (
              <button
                className="btn-header-action"
                onClick={() => onPreviewMarkdown(message.content, `Claude #${message.id}`)}
                title="サイドパネルでプレビュー"
              >
                Preview
              </button>
            )}
            {!readonly && (
              <button
                className="btn-header-action"
                onClick={() => onStartThread(message.id, '')}
                title="スレッドを開始"
              >
                Thread
              </button>
            )}
          </div>
        )}
      </div>

      {showInlineComments && messageComments.length > 0 && (
        <div className="inline-comments">
          {messageComments.map((c) => (
            <div key={c.id} className="inline-comment-item">
              {c.anchor?.quote && (
                <div className="inline-comment-quote">
                  “{c.anchor.quote.slice(0, 80)}
                  {c.anchor.quote.length > 80 ? '…' : ''}”
                </div>
              )}
              <div className="inline-comment-text">{c.text}</div>
              <div className="inline-comment-meta">
                <span>{new Date(c.timestamp).toLocaleString('ja-JP')}</span>
                {onDeleteComment && (
                  <button onClick={() => onDeleteComment(c.id)} title="削除">
                    削除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {message.toolUses && message.toolUses.length > 0 && (
        <div className="tool-uses">
          {message.toolUses.map((tool) => (
            <ToolUseItem key={tool.id} tool={tool} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />
          ))}
        </div>
      )}
      {message.content && (
        <div
          className={`chat-message-body ${shouldCollapse ? 'collapsed' : ''}`}
          onMouseUp={!isHuman ? handleTextSelect : undefined}
        >
          <MarkdownContent
            content={message.content}
            sessionCwd={sessionCwd}
            onOpenPreview={onOpenPreview}
            onOpenFileReview={onOpenFileReview}
          />
        </div>
      )}

      {selMenu && !noteDraft && (onAddAnchoredReview || onAddAnchoredComment || onStartThread) && (
        <div
          className="selection-menu"
          style={{ top: selMenu.top, left: selMenu.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {onAddAnchoredReview && <button onClick={() => openNote('review')}>レビューに追加</button>}
          {onAddAnchoredComment && <button onClick={() => openNote('comment')}>コメントに残す</button>}
          {!readonly && onStartThread && (
            <button onClick={() => runSelAction((t) => onStartThread(message.id, t))}>スレッド</button>
          )}
        </div>
      )}

      {noteDraft && (
        <div
          className="selection-note"
          style={{ top: noteDraft.top, left: noteDraft.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="selection-note-head">
            {noteDraft.mode === 'review' ? 'レビュー（送る）' : 'コメント（残す）'}
          </div>
          <div className="selection-note-quote">
            “{noteDraft.quote.slice(0, 80)}
            {noteDraft.quote.length > 80 ? '…' : ''}”
          </div>
          <textarea
            className="selection-note-input"
            autoFocus
            value={noteDraft.text}
            onChange={(e) => setNoteDraft((d) => ({ ...d, text: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                saveNote();
              } else if (e.key === 'Escape') {
                setNoteDraft(null);
              }
            }}
            placeholder={
              noteDraft.mode === 'review'
                ? 'この箇所への指摘を書く（Cmd+Enterで追加）...'
                : 'この箇所へのコメントを書く（送信されません / Cmd+Enter）...'
            }
            rows={3}
          />
          <div className="selection-note-actions">
            <button onClick={() => setNoteDraft(null)}>キャンセル</button>
            <button className="primary" onClick={saveNote} disabled={!noteDraft.text.trim()}>
              {noteDraft.mode === 'review' ? 'レビューに追加' : 'コメントを残す'}
            </button>
          </div>
        </div>
      )}

      {shouldCollapse && (
        <button className="expand-bar" onClick={() => setExpanded(true)}>
          ... 続きを表示 ({message.content.length} 文字)
        </button>
      )}

      {messageThreads.length > 0 && (
        <div className="inline-threads">
          {messageThreads.map((t) => (
            <div key={t.id} className={`inline-thread-badge ${t.resolved ? 'resolved' : ''}`}>
              {t.resolved ? 'done' : 'open'} {t.selectedText.slice(0, 30)}
              {t.selectedText.length > 30 ? '...' : ''}({t.replies.length} replies)
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatView({
  messages,
  threads,
  comments,
  sessionCwd,
  onStartThread,
  onAddAnchoredReview,
  onAddAnchoredComment,
  onDeleteComment,
  jumpToUuid,
  onJumpDone,
  onOpenPreview,
  onPreviewMarkdown,
  onOpenFileReview,
  readonly,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // コメント一覧から指定の messageUuid へスクロール（ベストエフォート）
  useEffect(() => {
    if (!jumpToUuid || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-message-uuid="${jumpToUuid}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('comment-jump-highlight');
      setTimeout(() => el.classList.remove('comment-jump-highlight'), 1500);
    }
    onJumpDone?.();
  }, [jumpToUuid, onJumpDone]);

  return (
    <div className="chat-view" ref={scrollRef}>
      {messages.length === 0 ? (
        <div className="chat-empty">Chat モード — Claude の出力がここに表示されます</div>
      ) : (
        messages.map((msg, i) => {
          const showDivider = msg.isHistory && i < messages.length - 1 && !messages[i + 1].isHistory;
          return (
            <div key={msg.id}>
              <ChatMessage
                message={msg}
                threads={threads}
                comments={comments}
                sessionCwd={sessionCwd}
                onStartThread={onStartThread}
                onAddAnchoredReview={onAddAnchoredReview}
                onAddAnchoredComment={onAddAnchoredComment}
                onDeleteComment={onDeleteComment}
                onOpenPreview={onOpenPreview}
                onPreviewMarkdown={onPreviewMarkdown}
                onOpenFileReview={onOpenFileReview}
                readonly={readonly}
              />
              {showDivider && <div className="history-divider">--- 過去の会話 / ここから新規 ---</div>}
            </div>
          );
        })
      )}
    </div>
  );
}
