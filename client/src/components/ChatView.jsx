import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import { EXT_TO_LANG, highlightLines } from '../highlight.js';
import { PREVIEWABLE_EXTS, getExt } from '../utils/previewExts.js';
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import { useNumberPick } from '../hooks/useNumberPick.js';
import { halfScreenJump } from '../utils/pickJump.js';
import { halfPageScrollKey } from '../utils/keys.js';
import { collectArtifacts } from '../utils/artifacts.js';
import { LEAF_BLOCKS, blockForLine, collectSourceBlocks } from '../utils/sourceBlocks.js';
import { rehypeSourceLine } from '../utils/rehypeSourceLine.js';
import FilePreview from './FilePreview.jsx';
import CodeBlock from './CodeBlock.jsx';
import ArtifactStrip from './ArtifactStrip.jsx';
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

// react-markdown に渡すものは全部モジュール定数にする。
// components / remarkPlugins を毎レンダー作り直すと、React には「別のコンポーネント型」に見えて
// 本文中の code / a 要素が全部アンマウント→再マウントされる（FilePreview が存在確認からやり直して
// チップ⇄プレーン表示がチラつく）。ハンドラは要素の型に混ぜず context で渡す。
const MarkdownHandlersContext = createContext({ sessionCwd: null, onOpenPreview: null, onOpenFileReview: null });
const REMARK_PLUGINS = [remarkGfm, remarkAlert];
// 行ピック（#N.M）で「表示中のどのブロックがソースの何行目か」を引けるようにする
const REHYPE_PLUGINS = [rehypeSourceLine];
const identityUrl = (url) => url;

// react-markdown は hast の node も props で渡してくるので DOM に漏らさないよう抜く
// eslint-disable-next-line no-unused-vars
function MdCode({ className, children, node, ...props }) {
  const { sessionCwd, onOpenPreview, onOpenFileReview } = useContext(MarkdownHandlersContext);
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
        <FilePreview href={`file://${resolved}`} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />
      );
    }
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  }
  return <CodeBlock className={className}>{children}</CodeBlock>;
}

// eslint-disable-next-line no-unused-vars
function MdAnchor({ href, children, node, ...props }) {
  const { onOpenPreview, onOpenFileReview } = useContext(MarkdownHandlersContext);
  if (isFileUrl(href)) {
    return <FilePreview href={href} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS = { code: MdCode, a: MdAnchor };

function MarkdownContent({ content, sessionCwd, onOpenPreview, onOpenFileReview }) {
  const processed = useMemo(() => preprocessFileUrls(content), [content]);
  const handlers = useMemo(
    () => ({ sessionCwd, onOpenPreview, onOpenFileReview }),
    [sessionCwd, onOpenPreview, onOpenFileReview],
  );

  return (
    <MarkdownHandlersContext.Provider value={handlers}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={identityUrl}
        components={MARKDOWN_COMPONENTS}
      >
        {processed}
      </Markdown>
    </MarkdownHandlersContext.Provider>
  );
}

// サブエージェントのトランスクリプト（SubagentDrawer）からも使うので export する。
// その場合 threads/comments は空、操作ハンドラは渡らない（readonly 表示）。
// 5 秒ごとのポーリング（subagent_tasks 等）で App が再描画されても本文を作り直さないよう memo する。
// 親から渡す props は App 側で useCallback / state の参照を保っている前提
export const ChatMessage = memo(function ChatMessage({
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
  pickNumber,
  pickTarget,
  pickLine,
  expandCmd,
}) {
  const [expanded, setExpanded] = useState(false);
  // 範囲選択時に出すアクションメニュー（レビューに追加 / コメントに残す / スレッド）
  const [selMenu, setSelMenu] = useState(null);
  // 選択後に本文（指摘/コメント）を書くノート入力ポップオーバー { mode, quote, top, left, text }
  const [noteDraft, setNoteDraft] = useState(null);
  // 💬 マーカーのインラインコメント一覧の開閉
  const [showInlineComments, setShowInlineComments] = useState(false);
  // 行ピックの 2 段目（#N.M）で出す、本文左のソース行番号バッジ [{line, top}]
  const bodyRef = useRef(null);
  const [lineBadges, setLineBadges] = useState([]);
  // pickLine が undefined なら行モードではない（null は「行モードだが行が未確定」）
  const lineMode = pickLine !== undefined;

  // ピック中の →← で全文表示／折りたたみを切り替える。同じ値を続けて送れるよう nonce で発火する
  useEffect(() => {
    if (!expandCmd) return;
    setExpanded(expandCmd.expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandCmd?.nonce]);

  // 行モードのあいだ、末端ブロックごとに行番号バッジの位置を測る。
  // 同じ行に複数のブロックがあれば DOM 順で後ろ（＝より深い方）を採る
  useEffect(() => {
    if (!lineMode) {
      setLineBadges((prev) => (prev.length ? [] : prev));
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const bodyTop = body.getBoundingClientRect().top;
    const byLine = new Map();
    for (const { el, line } of collectSourceBlocks(body)) {
      if (LEAF_BLOCKS.has(el.tagName)) byLine.set(line, el);
    }
    setLineBadges([...byLine.entries()].map(([line, el]) => ({ line, top: el.getBoundingClientRect().top - bodyTop })));
  }, [lineMode, expanded, message.content]);

  // 打鍵中の行に対応するブロックを強調して画面内に寄せる。クラスは cleanup で外す
  useEffect(() => {
    if (!lineMode || pickLine == null) return;
    const body = bodyRef.current;
    if (!body) return;
    const el = blockForLine(collectSourceBlocks(body), pickLine);
    if (!el) return;
    el.classList.add('msg-line-target');
    el.scrollIntoView({ block: 'nearest' });
    return () => el.classList.remove('msg-line-target');
  }, [lineMode, pickLine, message.content]);

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

  // Artifact の publish（claude.ai の共有ページ）。本文は無いのでリンクだけ出す
  if (message.role === 'artifact') {
    return (
      <div
        className={`chat-message artifact ${isHistory ? 'history' : ''}`}
        data-message-uuid={message.uuid || undefined}
      >
        <span className="artifact-message-icon">🔗</span>
        <span className="artifact-message-label">Artifact を公開</span>
        <a
          className="artifact-message-link"
          href={message.url}
          target="_blank"
          rel="noopener noreferrer"
          title={message.path || message.url}
        >
          {message.title || message.content || message.url}
        </a>
        <span className="chat-time">{new Date(message.timestamp).toLocaleTimeString('ja-JP')}</span>
      </div>
    );
  }
  const messageThreads = (threads || []).filter((t) => t.messageId === message.id);
  // このメッセージ（uuid）に紐付いたコメント
  const messageComments = (comments || []).filter(
    (c) => c.anchor && c.anchor.messageUuid && c.anchor.messageUuid === message.uuid,
  );

  const isLong = (message.content || '').length > COLLAPSE_THRESHOLD;
  // 行を指しているあいだは折りたたまない（隠れた行のバッジを打っても見えないため）
  const shouldCollapse = isLong && !expanded && !lineMode;

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
      className={`chat-message ${isHuman ? 'human' : 'assistant'} ${isHistory ? 'history' : ''} ${
        pickTarget ? 'msg-pick-target' : ''
      } ${lineMode ? 'msg-line-mode' : ''}`}
      data-message-uuid={message.uuid || undefined}
    >
      <div className="chat-message-header">
        {pickNumber != null && (
          <span className="msg-pick-badge" title="この番号を打って Enter でレビュー対象にする">
            {pickNumber}
          </span>
        )}
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
          ref={bodyRef}
          className={`chat-message-body ${shouldCollapse ? 'collapsed' : ''} ${lineMode ? 'msg-line-mode' : ''}`}
          onMouseUp={!isHuman ? handleTextSelect : undefined}
        >
          {lineMode &&
            lineBadges.map((b) => (
              <span key={b.line} className="msg-line-badge" style={{ top: b.top }}>
                {b.line}
              </span>
            ))}
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
});

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
  onPickMessageForReview,
  readonly,
  sessionId,
}) {
  // 最下部にいる間だけ新着に追従する（上を読んでいる最中に引き戻さない）
  const { scrollRef, onScroll, hasNew, scrollToBottom } = useStickToBottom(messages, sessionId);

  // このセッションで公開した Artifact（URL ごとに 1 件）
  const artifacts = useMemo(() => collectArtifacts(messages), [messages]);

  // ── メッセージピック（Alt+R → 数字 → Enter でレビュー対象にする）─────────────
  // 番号は「新しいものが 1」。目に入るのは最新側なので、そこから数えられる方が探しやすい。
  const pickable = useMemo(
    () => messages.filter((m) => m.uuid && (m.role === 'human' || m.role === 'assistant')),
    [messages],
  );
  const pickNumbers = useMemo(() => {
    const map = new Map();
    pickable.forEach((m, i) => map.set(m.uuid, pickable.length - i));
    return map;
  }, [pickable]);

  // →← の全文表示／折りたたみ指示（対象メッセージへ nonce 付きで送る）
  const [expandCmd, setExpandCmd] = useState(null);
  // p / Tab で開くファイルリンクの選択位置と、HUD に出すファイル名
  const [pickFileIndex, setPickFileIndex] = useState(0);
  const [pickFiles, setPickFiles] = useState([]);
  const pickRef = useRef(null);

  // 番号 n のメッセージ要素（DOM）を引く
  const messageElOf = useCallback(
    (n) => {
      const msg = pickable[pickable.length - n];
      if (!msg?.uuid) return null;
      return scrollRef.current?.querySelector(`[data-message-uuid="${msg.uuid}"]`) || null;
    },
    [pickable, scrollRef],
  );

  const handlePickMessage = useCallback(
    (n, line) => {
      const msg = pickable[pickable.length - n];
      if (!msg || !onPickMessageForReview) return;
      // 行が指定されていれば、そのソース行に対応する表示ブロックの文を引用にする
      let quote = '';
      if (line != null) {
        const body = messageElOf(n)?.querySelector('.chat-message-body');
        const block = body ? blockForLine(collectSourceBlocks(body), line) : null;
        quote = (block?.textContent || (msg.content || '').split('\n')[line - 1] || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
      } else {
        quote = (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      if (!quote) quote = msg.role === 'human' ? 'You' : 'Claude';
      const anchor = { type: 'message', messageUuid: msg.uuid, quote };
      if (line != null) anchor.line = line;
      onPickMessageForReview({ anchor });
    },
    [pickable, onPickMessageForReview, messageElOf],
  );

  // ピック中の Ctrl+D / Ctrl+U: 対象を半画面分先のメッセージ（2 段目なら行）へ飛ばす。
  // 番号ではなく画面上の位置で決める（長いメッセージが混ざると「n 件先」では移動量がぶれる）
  const jumpHalfScreen = useCallback(
    (direction, { target, subTarget }) => {
      const container = scrollRef.current;
      if (!container) return;
      const half = container.clientHeight / 2;
      let items;
      let current;
      if (pickRef.current?.sub != null && target != null) {
        const body = messageElOf(target)?.querySelector('.chat-message-body');
        items = body
          ? collectSourceBlocks(body)
              .filter(({ el }) => LEAF_BLOCKS.has(el.tagName))
              .map(({ el, line }) => ({ n: line, top: el.getBoundingClientRect().top }))
          : [];
        current = subTarget;
      } else {
        items = pickable
          .map((m) => {
            const el = container.querySelector(`[data-message-uuid="${m.uuid}"]`);
            return el ? { n: pickNumbers.get(m.uuid), top: el.getBoundingClientRect().top } : null;
          })
          .filter(Boolean);
        current = target;
      }
      // 同じ番号が並ぶ（同一行に複数ブロック）ことがあるので番号で重複排除し、画面上の並びに揃える
      const seen = new Set();
      items = items.filter((it) => it.n != null && !seen.has(it.n) && seen.add(it.n)).sort((a, b) => a.top - b.top);
      const next = halfScreenJump({ items, current, half, direction });
      if (next != null) pickRef.current?.setTarget(next);
    },
    [pickable, pickNumbers, messageElOf, scrollRef],
  );

  // ピック中の呼び出し側固有キー。→← は折りたたみ、Tab / p はファイルリンク、Ctrl+D/U は半画面ジャンプ
  const handlePickKey = useCallback(
    (e, { target, subTarget }) => {
      const scroll = halfPageScrollKey(e);
      if (scroll) {
        jumpHalfScreen(scroll, { target, subTarget });
        return true;
      }
      if (target == null) return false;
      const msg = pickable[pickable.length - target];
      if (!msg?.uuid) return false;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        setExpandCmd({ uuid: msg.uuid, expanded: e.key === 'ArrowRight', nonce: Date.now() });
        return true;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const links = [...(messageElOf(target)?.querySelectorAll('.file-link') || [])];
      if (e.key === 'Tab' && !e.shiftKey) {
        // リンクが 1 つ以下でも握る（フォーカスがチャットの外へ飛ぶのを防ぐ）
        if (links.length > 1) setPickFileIndex((i) => (i + 1) % links.length);
        return true;
      }
      // 行を打っている最中の p は行番号の入力ではないので、1 段目のときだけプレビューを開く
      if (e.key === 'p' && pickRef.current?.sub == null) {
        if (links.length) {
          links[Math.min(pickFileIndex, links.length - 1)].click();
          pickRef.current?.clear();
        }
        return true;
      }
      return false;
    },
    [pickable, messageElOf, pickFileIndex, jumpHalfScreen],
  );

  const pick = useNumberPick({
    // プレビューのドロワーが開いている間はそちらの行ピックが対象なので譲る
    enabled: useCallback(() => !document.querySelector('.drawer-overlay'), []),
    max: pickable.length,
    // 入力欄に打った数字を誤って拾わないよう、チャットでは Alt+R での開始を必須にする
    allowBareDigits: false,
    // 上に行くほど番号が大きいので、↑ で番号を増やす（2 段目の行には効かせない）
    invertArrows: true,
    // `.` で 2 段目（メッセージ内の行）へ。上限は本文の行数
    allowSub: true,
    subMax: (n) => (pickable[pickable.length - n]?.content || '').split('\n').length,
    onKey: handlePickKey,
    onPick: handlePickMessage,
  });
  pickRef.current = pick;

  // 打鍵中の対象が画面外なら寄せる
  useEffect(() => {
    if (!pick.active || pick.target == null) return;
    messageElOf(pick.target)?.scrollIntoView({ block: 'nearest' });
  }, [pick.active, pick.target, messageElOf]);

  // `.` で 2 段目に入った瞬間だけ、対象を全文表示にする（隠れた行は指せないため）
  const prevSubRef = useRef(null);
  useEffect(() => {
    const prev = prevSubRef.current;
    prevSubRef.current = pick.sub;
    if (prev != null || pick.sub !== '' || pick.target == null) return;
    const msg = pickable[pickable.length - pick.target];
    if (msg?.uuid) setExpandCmd({ uuid: msg.uuid, expanded: true, nonce: Date.now() });
  }, [pick.sub, pick.target, pickable]);

  // 対象メッセージ内のファイルリンクを拾い、選択中の 1 つを強調する。
  // ChatMessage の memo を崩さないよう className ではなく DOM 直接操作で付け外しする
  useEffect(() => {
    if (!pick.active || pick.target == null) {
      setPickFiles((prev) => (prev.length ? [] : prev));
      return;
    }
    const links = [...(messageElOf(pick.target)?.querySelectorAll('.file-link') || [])];
    setPickFiles(links.map((el) => el.textContent || ''));
    if (!links.length) return;
    const link = links[Math.min(pickFileIndex, links.length - 1)];
    link.classList.add('msg-pick-file');
    return () => link.classList.remove('msg-pick-file');
  }, [pick.active, pick.target, pickFileIndex, messageElOf, expandCmd]);

  // ピックを抜けたらファイル選択位置を戻す
  useEffect(() => {
    if (!pick.active) setPickFileIndex(0);
  }, [pick.active]);

  // 打鍵中の数字が範囲外（丸められた）なら HUD を赤くする。2 段目に入っていればそちらを見る
  const pickHudInvalid =
    pick.sub == null
      ? pick.target == null || Number(pick.buffer) !== pick.target
      : pick.subTarget == null || Number(pick.sub) !== pick.subTarget;

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
    <div className="chat-view" ref={scrollRef} onScroll={onScroll}>
      {messages.length > 0 && <ArtifactStrip artifacts={artifacts} />}
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
                // ピック中だけ番号を渡す（それ以外は undefined のままで memo を効かせる）
                pickNumber={pick.active ? (pickNumbers.get(msg.uuid) ?? null) : undefined}
                pickTarget={pick.active && pick.target != null && pickNumbers.get(msg.uuid) === pick.target}
                pickLine={
                  pick.active && pick.sub != null && pickNumbers.get(msg.uuid) === pick.target
                    ? pick.subTarget
                    : undefined
                }
                expandCmd={expandCmd?.uuid === msg.uuid ? expandCmd : undefined}
              />
              {showDivider && <div className="history-divider">--- 過去の会話 / ここから新規 ---</div>}
            </div>
          );
        })
      )}

      {hasNew && (
        <button className="scroll-to-latest" onClick={scrollToBottom}>
          ↓ 新しいメッセージ
        </button>
      )}

      {/* メッセージピックの打鍵中に「今どのメッセージを指しているか」を出す */}
      {pick.active && (
        <div className="msg-pick-hud" data-mode={pick.sub == null ? 'message' : 'line'}>
          <span className={`msg-pick-hud-value ${pickHudInvalid ? 'invalid' : ''}`}>
            #{pick.buffer || '_'}
            {pick.sub != null && `.${pick.sub || '_'}`}
          </span>
          {pickFiles.length > 0 && (
            <span className="msg-pick-hud-file">
              📄 {pickFiles[Math.min(pickFileIndex, pickFiles.length - 1)]} (
              {Math.min(pickFileIndex, pickFiles.length - 1) + 1}/{pickFiles.length})
              {pickFiles.length > 1 && ' · Tab で切替'}
            </span>
          )}
          <span className="msg-pick-hud-hint">
            {pick.sub == null
              ? 'Enter 指摘 / . 行を指定 / ↑↓ 移動 / →← 全文表示 / p プレビュー / Esc 取消'
              : '行番号を打つ / Enter 指摘 / ↑↓ 行を移動 / ⌫ 戻る'}
          </span>
        </div>
      )}
    </div>
  );
}
