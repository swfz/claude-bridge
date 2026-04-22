import { useEffect, useRef, useState, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EXT_TO_LANG, highlightLines } from "../highlight.js";
import CommentPopover from "./CommentPopover.jsx";
import ReviewPanel from "./ReviewPanel.jsx";
import FilePreview from "./FilePreview.jsx";
import "./ChatView.css";

const COLLAPSE_THRESHOLD = 600; // 文字数がこれを超えたら折りたたみ

const TOOL_ICONS = {
  Bash: "$",
  Read: "R",
  Edit: "E",
  Write: "W",
  Grep: "G",
  Glob: "G",
  Agent: "A",
};

const FILE_TOOLS = new Set(["Read", "Edit", "Write"]);

function ToolUseItem({ tool, onOpenPreview, onOpenFileReview }) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[tool.name] || "T";
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
        <span className="tool-expand">{expanded ? "−" : "+"}</span>
      </div>
      {expanded && (
        <div className="tool-use-detail">
          {tool.name === "Edit" ? (
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
      {html
        ? <span dangerouslySetInnerHTML={{ __html: html }} />
        : <span>{text}</span>}
    </div>
  );
}

function EditDiff({ input }) {
  if (!input) return null;
  const filePath = input.file_path || "";
  const oldStr = input.old_string || "";
  const newStr = input.new_string || "";

  const ext = filePath.split(".").pop()?.toLowerCase();
  const lang = EXT_TO_LANG[ext];

  const oldHighlighted = useMemo(() => highlightLines(oldStr, lang), [oldStr, lang]);
  const newHighlighted = useMemo(() => highlightLines(newStr, lang), [newStr, lang]);

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  return (
    <>
      <div className="diff-file-path">{filePath}</div>
      <pre className="diff-block">
        {oldLines.map((line, i) => (
          <DiffLine
            key={`old-${i}`}
            sign="-"
            className="diff-removed"
            html={oldHighlighted?.[i]}
            text={line}
          />
        ))}
        {newLines.map((line, i) => (
          <DiffLine
            key={`new-${i}`}
            sign="+"
            className="diff-added"
            html={newHighlighted?.[i]}
            text={line}
          />
        ))}
      </pre>
    </>
  );
}

function formatToolInput(name, input) {
  if (!input) return "";
  switch (name) {
    case "Bash":
      return input.command || "";
    case "Edit":
      return input.file_path || "";
    case "Write":
      return `${input.file_path || ""}\n${(input.content || "").slice(0, 500)}${(input.content || "").length > 500 ? "\n..." : ""}`;
    case "Read":
      return input.file_path || "";
    case "Grep": case "Glob":
      return `pattern: ${input.pattern || ""}${input.path ? `\npath: ${input.path}` : ""}`;
    default:
      return JSON.stringify(input, null, 2).slice(0, 500);
  }
}

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

const PREVIEWABLE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".html", ".htm", ".pdf",
  ".md", ".txt", ".csv", ".json", ".js", ".css", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".sh",
]);

// プレビュー可能な拡張子を持つか判定
function hasPreviewableExt(text) {
  if (!text) return false;
  const match = text.match(/\.(\w+)$/);
  if (!match) return false;
  return PREVIEWABLE_EXTS.has(`.${match[1].toLowerCase()}`);
}

// ファイルパスを解決（相対パスは cwd を使って絶対パスに）
function resolveFilePath(text, cwd) {
  if (!text) return null;
  if (text.startsWith("/")) {
    return hasPreviewableExt(text) ? text : null;
  }
  // 相対パス: cwd があれば結合
  if (cwd && hasPreviewableExt(text)) {
    // ./ を除去
    const cleaned = text.startsWith("./") ? text.slice(2) : text;
    return `${cwd.replace(/\/$/, "")}/${cleaned}`;
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
      if (part.startsWith("```") || part.startsWith("`")) return part;
      // file:// URL をMarkdownリンクに変換
      return part.replace(
        /(file:\/\/[^\s<>"')\]`]+)/g,
        (url) => `[${url}](${url})`
      );
    })
    .join("");
}

function MarkdownContent({ content, sessionCwd, onOpenPreview, onOpenFileReview }) {
  const processed = preprocessFileUrls(content);

  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            const text = String(children).trim();
            // インラインコード内の file:// URL を FilePreview に変換
            if (isFileUrl(text)) {
              return (
                <FilePreview
                  href={text}
                  onOpenPreview={onOpenPreview}
                  onOpenFileReview={onOpenFileReview}
                />
              );
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
  sessionCwd,
  onStartThread,
  onAddComment,
  onSendCommentToClaude,
  onReviewSubmit,
  onOpenPreview,
  onPreviewMarkdown,
  onOpenFileReview,
}) {
  const [showComments, setShowComments] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
        {!isHuman && (
          <div className="header-actions">
            <button
              className="btn-header-action"
              onClick={() => onPreviewMarkdown(message.content, `Claude #${message.id}`)}
              title="サイドパネルでプレビュー"
            >
              Preview
            </button>
            <button
              className="btn-header-action"
              onClick={() => setShowReview(!showReview)}
              title="レビューコメントを書く"
            >
              Review
            </button>
            <button
              className="btn-header-action"
              onClick={() => onStartThread(message.id, "")}
              title="スレッドを開始"
            >
              Thread
            </button>
            <button
              className="btn-header-action"
              onClick={() => setShowComments(!showComments)}
              title="コメント"
            >
              {messageComments.length > 0
                ? `Memo(${messageComments.length})`
                : "Memo"}
            </button>
          </div>
        )}
      </div>
      {message.toolUses && message.toolUses.length > 0 && (
        <div className="tool-uses">
          {message.toolUses.map((tool) => (
            <ToolUseItem key={tool.id} tool={tool} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />
          ))}
        </div>
      )}
      {message.content && (
        <div
          className={`chat-message-body ${shouldCollapse ? "collapsed" : ""}`}
          onMouseUp={!isHuman ? handleTextSelect : undefined}
        >
          <MarkdownContent content={message.content} sessionCwd={sessionCwd} onOpenPreview={onOpenPreview} onOpenFileReview={onOpenFileReview} />
        </div>
      )}

      {shouldCollapse && (
        <button
          className="expand-bar"
          onClick={() => setExpanded(true)}
        >
          ... 続きを表示 ({message.content.length} 文字)
        </button>
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
  sessionCwd,
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
                sessionCwd={sessionCwd}
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
