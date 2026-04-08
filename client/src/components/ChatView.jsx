import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CommentPopover from "./CommentPopover.jsx";
import ReviewPanel from "./ReviewPanel.jsx";
import FilePreview from "./FilePreview.jsx";
import "./ChatView.css";

const COLLAPSE_THRESHOLD = 600; // 文字数がこれを超えたら折りたたみ

function CodeBlock({ children, className }) {
  const codeRef = useRef(null);
  const lang = className?.replace("language-", "") || "";

  const handleCopy = () => {
    const text = codeRef.current?.textContent || "";
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-lang">{lang}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          Copy
        </button>
      </div>
      <pre>
        <code ref={codeRef} className={className}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function isFileUrl(href) {
  return href && (href.startsWith("file://") || href.startsWith("file:///"));
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
      if (part.startsWith("```") || part.startsWith("`")) return part;
      // file:// URL をMarkdownリンクに変換
      return part.replace(
        /(file:\/\/[^\s<>"')\]`]+)/g,
        (url) => `[${url}](${url})`
      );
    })
    .join("");
}

function MarkdownContent({ content, onOpenPreview, onOpenFileReview }) {
  const processed = preprocessFileUrls(content);

  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            // インラインコード内の file:// URL を FilePreview に変換
            const text = String(children);
            if (isFileUrl(text.trim())) {
              return (
                <FilePreview
                  href={text.trim()}
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
            return (
              <FilePreview
                href={href}
                onOpenPreview={onOpenPreview}
                onOpenFileReview={onOpenFileReview}
              />
            );
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

function ChatMessage({
  message,
  threads,
  comments,
  onStartThread,
  onAddComment,
  onSendCommentToClaude,
  onReviewSubmit,
  onOpenPreview,
  onPreviewMarkdown,
  onOpenFileReview,
}) {
  const isHuman = message.role === "human";
  const isSystem = message.role === "system";
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
  const [showComments, setShowComments] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const messageThreads = threads.filter((t) => t.messageId === message.id);
  const messageComments = comments.filter((c) => c.messageId === message.id);

  const isLong = message.content.length > COLLAPSE_THRESHOLD;
  const shouldCollapse = isLong && !expanded;

  const handleTextSelect = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text && text.length > 0) {
      onStartThread(message.id, text);
      selection.removeAllRanges();
    }
  };

  return (
    <div className={`chat-message ${isHuman ? "human" : "assistant"} ${isHistory ? "history" : ""}`}>
      <div className="chat-message-header">
        <span className="chat-role">{isHuman ? "You" : "Claude"}</span>
        <span className="chat-time">
          {new Date(message.timestamp).toLocaleTimeString("ja-JP")}
        </span>
        {isLong && (
          <button
            className="expand-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "折りたたむ" : "全文表示"}
          </button>
        )}
      </div>
      <div
        className={`chat-message-body ${shouldCollapse ? "collapsed" : ""}`}
        onMouseUp={!isHuman ? handleTextSelect : undefined}
      >
        <MarkdownContent content={message.content} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />
      </div>

      {shouldCollapse && (
        <button
          className="expand-bar"
          onClick={() => setExpanded(true)}
        >
          ... 続きを表示 ({message.content.length} 文字)
        </button>
      )}

      {!isHuman && (
        <div className="chat-message-actions">
          <button
            className="btn-action btn-action-primary"
            onClick={() => onPreviewMarkdown(message.content, `Claude #${message.id}`)}
            title="サイドパネルでプレビュー"
          >
            プレビュー
          </button>
          <button
            className="btn-action"
            onClick={() => setShowReview(!showReview)}
            title="レビューコメントを書く"
          >
            レビュー
          </button>
          <button
            className="btn-action"
            onClick={() => onStartThread(message.id, "")}
            title="スレッドを開始"
          >
            + スレッド
          </button>
          <button
            className="btn-action"
            onClick={() => setShowComments(!showComments)}
            title="コメント"
          >
            {messageComments.length > 0
              ? `メモ (${messageComments.length})`
              : "メモ"}
          </button>
        </div>
      )}

      {messageThreads.length > 0 && (
        <div className="inline-threads">
          {messageThreads.map((t) => (
            <div
              key={t.id}
              className={`inline-thread-badge ${t.resolved ? "resolved" : ""}`}
            >
              {t.resolved ? "done" : "open"} {t.selectedText.slice(0, 30)}
              {t.selectedText.length > 30 ? "..." : ""}
              ({t.replies.length} replies)
            </div>
          ))}
        </div>
      )}

      {showReview && (
        <ReviewPanel
          messageId={message.id}
          onSubmit={(items) => onReviewSubmit(message.id, items)}
          onClose={() => setShowReview(false)}
        />
      )}

      {showComments && (
        <CommentPopover
          comments={messageComments}
          onAdd={(text) => onAddComment(message.id, text)}
          onSendToClaude={onSendCommentToClaude}
          onClose={() => setShowComments(false)}
        />
      )}
    </div>
  );
}

export default function ChatView({
  messages,
  threads,
  comments,
  onStartThread,
  onAddComment,
  onSendCommentToClaude,
  onReviewSubmit,
  onOpenPreview,
  onPreviewMarkdown,
  onOpenFileReview,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="chat-view" ref={scrollRef}>
      {messages.length === 0 ? (
        <div className="chat-empty">
          Chat モード — Claude の出力がここに表示されます
        </div>
      ) : (
        messages.map((msg, i) => {
          const showDivider =
            msg.isHistory &&
            i < messages.length - 1 &&
            !messages[i + 1].isHistory;
          return (
            <div key={msg.id}>
              <ChatMessage
                message={msg}
                threads={threads}
                comments={comments}
                onStartThread={onStartThread}
                onAddComment={onAddComment}
                onSendCommentToClaude={onSendCommentToClaude}
                onReviewSubmit={onReviewSubmit}
                onOpenPreview={onOpenPreview}
                onPreviewMarkdown={onPreviewMarkdown}
                onOpenFileReview={onOpenFileReview}
              />
              {showDivider && (
                <div className="history-divider">--- 過去の会話 / ここから新規 ---</div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
