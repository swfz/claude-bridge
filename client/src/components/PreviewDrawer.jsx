import { useEffect, useRef, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./PreviewDrawer.css";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"];
const HTML_EXTS = [".html", ".htm"];
const PDF_EXTS = [".pdf"];
const TEXT_EXTS = [".md", ".txt", ".csv", ".json", ".js", ".css", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".sh"];
const MARKDOWN_EXTS = [".md"];

function getExt(path) {
  const match = path.match(/\.(\w+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function previewUrl(localPath) {
  return `/preview?path=${encodeURIComponent(localPath)}`;
}

let commentIdSeq = 0;

export default function PreviewDrawer({
  filePath,
  markdown,
  title,
  reviewMode,
  onClose,
  onReviewSubmit,
  responses,
}) {
  const isMarkdownMode = !!markdown;
  const ext = filePath ? getExt(filePath) : "";
  const fileName = filePath ? filePath.split("/").pop() : title || "プレビュー";
  const isImage = IMAGE_EXTS.includes(ext);
  const isHtml = HTML_EXTS.includes(ext);
  const isPdf = PDF_EXTS.includes(ext);
  const isText = TEXT_EXTS.includes(ext);
  const isMarkdownFile = MARKDOWN_EXTS.includes(ext);
  const [fileContent, setFileContent] = useState(null);
  const [reviewItems, setReviewItems] = useState([]);
  const [selectionPopup, setSelectionPopup] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const bodyRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    if (!isMarkdownMode && filePath && (isText || isMarkdownFile)) {
      fetch(previewUrl(filePath))
        .then((r) => r.text())
        .then((text) => {
          setFileContent(text);
          if (textRef.current && !isMarkdownFile) {
            textRef.current.textContent = text;
          }
        })
        .catch(() => {
          setFileContent(null);
          if (textRef.current) textRef.current.textContent = "読み込みに失敗しました";
        });
    }
  }, [filePath, isText, isMarkdownFile, isMarkdownMode]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        if (selectionPopup) {
          setSelectionPopup(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, selectionPopup]);

  // テキスト選択を検出
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || text.length < 2) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const bodyRect = bodyRef.current?.getBoundingClientRect();
    if (!bodyRect) return;

    setSelectionPopup({
      text,
      top: rect.bottom - bodyRect.top + bodyRef.current.scrollTop,
      left: rect.left - bodyRect.left,
    });
  }, []);

  const addComment = useCallback((selectedText) => {
    const id = ++commentIdSeq;
    setReviewItems((prev) => [
      ...prev,
      { id, selectedText, comment: "", resolved: false },
    ]);
    setEditingId(id);
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const updateComment = useCallback((id, comment) => {
    setReviewItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, comment } : item))
    );
  }, []);

  const removeItem = useCallback((id) => {
    setReviewItems((prev) => prev.filter((item) => item.id !== id));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  const toggleResolved = useCallback((id) => {
    setReviewItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, resolved: !item.resolved } : item
      )
    );
  }, []);

  const [submitStatus, setSubmitStatus] = useState(null);

  const handleSubmitAll = useCallback(() => {
    const items = reviewItems.filter((i) => i.comment.trim() && !i.resolved);
    if (items.length === 0 || !onReviewSubmit) return;

    const target = filePath || "preview";
    const formatted = items.map(
      (item, i) =>
        `${i + 1}. 「${item.selectedText.slice(0, 80)}」について:\n   ${item.comment}`
    );
    onReviewSubmit(target, formatted);
    setSubmitStatus(`${items.length}件送信しました`);
    setTimeout(() => setSubmitStatus(null), 3000);
    // 送信済みを解決済みに
    setReviewItems((prev) =>
      prev.map((item) =>
        item.comment.trim() && !item.resolved ? { ...item, resolved: true } : item
      )
    );
  }, [reviewItems, filePath, onReviewSubmit]);

  const markdownToRender = isMarkdownMode
    ? markdown
    : isMarkdownFile
      ? fileContent
      : null;

  const unresolvedCount = reviewItems.filter(
    (i) => !i.resolved && i.comment.trim()
  ).length;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className={`drawer ${reviewItems.length > 0 ? "drawer-with-review" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <div className="drawer-title-area">
            <span className="drawer-filename">{fileName}</span>
            {filePath && <span className="drawer-path">{filePath}</span>}
          </div>
          <div className="drawer-actions">
            {unresolvedCount > 0 && (
              <button className="drawer-btn drawer-btn-submit" onClick={handleSubmitAll}>
                {unresolvedCount}件送信
              </button>
            )}
            {filePath && (
              <a
                href={previewUrl(filePath)}
                target="_blank"
                rel="noopener noreferrer"
                className="drawer-btn"
              >
                別タブ
              </a>
            )}
            <button className="drawer-close" onClick={onClose}>
              x
            </button>
          </div>
        </div>

        <div className="drawer-hint">
          テキストを選択してコメントを追加できます
        </div>

        <div className="drawer-content">
          <div className="drawer-body" ref={bodyRef} onMouseUp={handleMouseUp}>
            {markdownToRender ? (
              <div className="drawer-markdown">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {markdownToRender}
                </Markdown>
              </div>
            ) : (
              <>
                {isImage && (
                  <img
                    src={previewUrl(filePath)}
                    alt={fileName}
                    className="drawer-image"
                  />
                )}
                {isHtml && (
                  <iframe
                    src={previewUrl(filePath)}
                    className="drawer-iframe"
                    title={fileName}
                    sandbox="allow-scripts allow-same-origin"
                  />
                )}
                {isPdf && (
                  <iframe
                    src={previewUrl(filePath)}
                    className="drawer-iframe"
                    title={fileName}
                  />
                )}
                {isText && !isMarkdownFile && (
                  <pre className="drawer-text" ref={textRef}>
                    読み込み中...
                  </pre>
                )}
                {!isImage && !isHtml && !isPdf && !isText && !isMarkdownMode && (
                  <div className="drawer-unsupported">
                    <p>プレビュー非対応の形式です</p>
                  </div>
                )}
              </>
            )}

            {/* 選択時のポップアップ */}
            {selectionPopup && (
              <div
                className="selection-popup"
                style={{
                  top: selectionPopup.top + 4,
                  left: selectionPopup.left,
                }}
              >
                <button
                  className="selection-popup-btn"
                  onClick={() => addComment(selectionPopup.text)}
                >
                  + コメント追加
                </button>
              </div>
            )}
          </div>

          {/* レビュースレッド */}
          {(reviewItems.length > 0 || (responses && responses.length > 0)) && (
            <div className="drawer-review-pane">
              <div className="review-pane-header">
                レビュースレッド
              </div>
              <div className="review-pane-thread">
                {/* 未送信コメント */}
                {reviewItems.filter((i) => !i.resolved).map((item, index) => (
                  <div key={item.id} className="review-pane-item">
                    <div className="review-pane-item-header">
                      <span className="review-pane-num">#{index + 1}</span>
                      <button
                        className="review-pane-remove"
                        onClick={() => removeItem(item.id)}
                      >
                        x
                      </button>
                    </div>
                    <div className="review-pane-selected">
                      {item.selectedText.slice(0, 120)}
                      {item.selectedText.length > 120 ? "..." : ""}
                    </div>
                    {editingId === item.id || item.comment ? (
                      <textarea
                        className="review-pane-input"
                        value={item.comment}
                        onChange={(e) => updateComment(item.id, e.target.value)}
                        onFocus={() => setEditingId(item.id)}
                        placeholder="コメントを入力..."
                        rows={2}
                        autoFocus={editingId === item.id}
                      />
                    ) : (
                      <button
                        className="review-pane-edit-btn"
                        onClick={() => setEditingId(item.id)}
                      >
                        コメントを書く
                      </button>
                    )}
                  </div>
                ))}

                {/* 送信ボタン */}
                {unresolvedCount > 0 && (
                  <div className="review-pane-send-area">
                    {submitStatus && (
                      <div className="review-pane-status">{submitStatus}</div>
                    )}
                    <button
                      className="btn btn-primary review-pane-submit"
                      onClick={handleSubmitAll}
                    >
                      {unresolvedCount}件送信
                    </button>
                  </div>
                )}

                {/* 送信済み + 返信のスレッド表示 */}
                {reviewItems.filter((i) => i.resolved).length > 0 && (
                  <div className="review-thread-sent">
                    <div className="review-thread-label">送信済み</div>
                    {reviewItems.filter((i) => i.resolved).map((item, index) => (
                      <div key={item.id} className="review-pane-item resolved">
                        <div className="review-pane-item-header">
                          <span className="review-pane-num sent">#{index + 1}</span>
                          <button
                            className="review-pane-resolve"
                            onClick={() => toggleResolved(item.id)}
                            title="未解決に戻す"
                          >
                            ↩
                          </button>
                        </div>
                        <div className="review-pane-selected">
                          {item.selectedText.slice(0, 80)}...
                        </div>
                        <div className="review-pane-comment-sent">{item.comment}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Claude の返信 */}
                {responses && responses.map((r, i) => (
                  <div key={`resp-${i}`} className="review-pane-response">
                    <div className="review-pane-response-header">
                      <span className="review-pane-response-role">Claude</span>
                      <span className="review-pane-response-time">
                        {r.timestamp
                          ? new Date(r.timestamp).toLocaleTimeString("ja-JP")
                          : ""}
                      </span>
                    </div>
                    <div className="review-pane-response-body">
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {r.content}
                      </Markdown>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
