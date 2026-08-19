import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCwd } from '../utils/cwdLabel.js';
import './SessionTabs.css';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;

function readStoredWidth() {
  const stored = Number(localStorage.getItem('sidebarWidth'));
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(stored, MAX_WIDTH));
}

export default function SessionTabs({
  sessions,
  activeSessionId,
  homeActive,
  attentionIds,
  onHome,
  onSelect,
  onKill,
  onRestart,
  onRemovePast,
  onDetachTmux,
  onCloseReadonly,
  onNew,
}) {
  const [width, setWidth] = useState(readStoredWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(width));
  }, [width]);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setWidth(Math.max(MIN_WIDTH, Math.min(startWidth.current + delta, MAX_WIDTH)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div className="session-tabs" style={{ width, minWidth: width }}>
      <div className="sidebar-resize-handle" onMouseDown={onDragStart} onDragStart={(e) => e.preventDefault()} />
      <button
        className={`tab-home ${homeActive ? 'active' : ''}`}
        onClick={onHome}
        title="ホーム（起動中セッション一覧）"
      >
        ⌂ Home
      </button>
      <button className="tab-new" onClick={onNew} title="新しいセッション">
        ＋ 新しいセッション
      </button>
      <div className="tabs-list">
        {sessions.map((session) => {
          const { project, worktree } = parseCwd(session.cwd);
          const hasAttention = session.alive && attentionIds?.has(session.id);
          return (
            <div
              key={session.id}
              className={`tab ${session.id === activeSessionId ? 'active' : ''} ${!session.alive ? 'dead' : ''} ${hasAttention ? 'tab-attention' : ''}`}
              onClick={() => session.alive && onSelect(session.id)}
            >
              <div className="tab-row">
                {session.status && (
                  <span className={`tab-status tab-status-${session.status}`} title={session.status} />
                )}
                {session.type === 'tmux' && <span className="tab-badge">tmux</span>}
                {session.type === 'readonly' && <span className="tab-badge">閲覧</span>}
                {hasAttention && (
                  <span className="tab-badge tab-badge-attention" title="応答が完了しました（未確認）">
                    完了
                  </span>
                )}
                {session.waitingFor && session.alive && (
                  <span className="tab-badge tab-badge-waiting" title={session.waitingFor}>
                    {session.waitingFor === 'permission prompt' ? '許可待ち' : '回答待ち'}
                  </span>
                )}
                <span className="tab-name" title={session.name}>
                  {session.name}
                </span>
                {session.alive ? (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (session.type === 'tmux') {
                        onDetachTmux(session.id);
                      } else if (session.type === 'readonly') {
                        onCloseReadonly(session.id);
                      } else {
                        onKill(session.id);
                      }
                    }}
                    title={session.type === 'tmux' || session.type === 'readonly' ? '閉じる' : 'セッションを終了'}
                  >
                    x
                  </button>
                ) : (
                  <span className="tab-dead-actions">
                    <button
                      className="tab-restart"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestart(session.id);
                      }}
                      title="同じ設定で再起動"
                    >
                      ↻
                    </button>
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemovePast(session.id);
                      }}
                      title="履歴から削除"
                    >
                      x
                    </button>
                  </span>
                )}
              </div>
              <span className={`tab-cwd ${session.type === 'tmux' ? 'tab-cwd-strong' : ''}`} title={session.cwd}>
                <span className="tab-cwd-project">{project}</span>
                {worktree && <span className="tab-cwd-worktree">⎇ {worktree}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
