import { useCallback, useMemo, useRef, useState } from 'react';
import './ThreadPanel.css';

function ThreadItem({ thread, draft, onDraftChange, onSubmitBatch, onResolve, onDelete }) {
  const hasDraft = draft.trim().length > 0;
  const [expanded, setExpanded] = useState(!thread.resolved || hasDraft);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmitBatch();
    }
  };

  return (
    <div className={`thread-item ${thread.resolved ? 'resolved' : ''}`}>
      <div className="thread-header" onClick={() => setExpanded(!expanded)}>
        <span className="thread-indicator">{thread.resolved ? 'done' : 'open'}</span>
        <span className="thread-selected-text">
          {thread.selectedText.slice(0, 60)}
          {thread.selectedText.length > 60 ? '...' : ''}
        </span>
        <span className="thread-reply-count">{thread.replies.length} 件の返信</span>
        {hasDraft && (
          <span className="thread-draft-indicator" title="未送信の下書きあり">
            下書き
          </span>
        )}
        <button
          className="thread-resolve-btn"
          onClick={(e) => {
            e.stopPropagation();
            onResolve(thread.id);
          }}
          title={thread.resolved ? '未解決に戻す' : '解決済みにする'}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button
          className="thread-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(thread.id);
          }}
          title="スレッドを削除"
        >
          x
        </button>
      </div>

      {expanded && (
        <div className="thread-body">
          {thread.replies.map((reply) => (
            <div key={reply.id} className={`thread-reply ${reply.role}`}>
              <span className="reply-role">{reply.role === 'human' ? 'You' : 'Claude'}</span>
              <span className="reply-text">{reply.text}</span>
              <span className="reply-time">{new Date(reply.timestamp).toLocaleTimeString('ja-JP')}</span>
            </div>
          ))}

          {!thread.resolved && (
            <div className="thread-reply-input">
              <textarea
                value={draft}
                onChange={(e) => onDraftChange(thread.id, e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="返信を入力... (Enterで改行 / Cmd+Enterでまとめて送信)"
                rows={2}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ThreadPanel({ threads, onReplyBatch, onResolve, onDelete }) {
  const unresolvedCount = threads.filter((t) => !t.resolved).length;
  const [drafts, setDrafts] = useState({});
  const [width, setWidth] = useState(480);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const pendingReplies = useMemo(() => {
    const activeThreadIds = new Set(threads.filter((t) => !t.resolved).map((t) => t.id));
    return Object.entries(drafts)
      .map(([threadId, text]) => ({ threadId, text: text.trim() }))
      .filter((r) => r.text && activeThreadIds.has(r.threadId));
  }, [drafts, threads]);

  const handleDraftChange = useCallback((threadId, text) => {
    setDrafts((prev) => ({ ...prev, [threadId]: text }));
  }, []);

  const handleSubmitBatch = useCallback(() => {
    if (pendingReplies.length === 0) return;
    onReplyBatch(pendingReplies);
    setDrafts({});
  }, [pendingReplies, onReplyBatch]);

  const handleDiscard = useCallback(() => {
    setDrafts({});
  }, []);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(240, Math.min(startWidth.current + delta, 800)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const pendingCount = pendingReplies.length;

  return (
    <div className="thread-panel" style={{ width, minWidth: width }}>
      <div className="thread-resize-handle" onMouseDown={onDragStart} />
      <div className="thread-panel-header">
        <h3>
          スレッド
          {unresolvedCount > 0 && <span className="unresolved-badge">{unresolvedCount}</span>}
        </h3>
      </div>
      <div className="thread-panel-body">
        {threads.length === 0 ? (
          <p className="thread-empty">スレッドなし — メッセージの「+ スレッド」から作成</p>
        ) : (
          threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              draft={drafts[thread.id] ?? ''}
              onDraftChange={handleDraftChange}
              onSubmitBatch={handleSubmitBatch}
              onResolve={onResolve}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
      {pendingCount > 0 && (
        <div className="thread-panel-footer">
          <span className="thread-draft-count">未送信 {pendingCount} 件</span>
          <button className="btn btn-ghost thread-discard-btn" onClick={handleDiscard} title="すべての下書きを破棄">
            破棄
          </button>
          <button className="btn btn-primary thread-submit-batch-btn" onClick={handleSubmitBatch}>
            {pendingCount > 1 ? `${pendingCount}件まとめて送信` : '送信'}
          </button>
        </div>
      )}
    </div>
  );
}
