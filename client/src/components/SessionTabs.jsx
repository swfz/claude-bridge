import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCwd } from '../utils/cwdLabel.js';
import ShortcutHints from './ShortcutHints.jsx';
import './SessionTabs.css';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 48;

function readStoredWidth() {
  const stored = Number(localStorage.getItem('sidebarWidth'));
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(stored, MAX_WIDTH));
}

// 折りたたみ時はプロジェクト名の頭文字だけで見分ける（Chrome の favicon 相当）
function miniLabel(project) {
  if (!project) return '?';
  const parts = String(project)
    .split(/[-_.\s]+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .slice(0, 3)
      .map((part) => part[0])
      .join('')
      .toUpperCase();
  }
  return String(project).slice(0, 2).toUpperCase();
}

export default function SessionTabs({
  sessions,
  activeSessionId,
  homeActive,
  attentionIds,
  sensitiveIds,
  starredIds,
  shareMode,
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
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(width));
  }, [width]);

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  }, [collapsed]);

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

  const shownWidth = collapsed ? COLLAPSED_WIDTH : width;

  return (
    <div className={`session-tabs ${collapsed ? 'collapsed' : ''}`} style={{ width: shownWidth, minWidth: shownWidth }}>
      {/* 折りたたみ中は幅固定なのでリサイズハンドルは出さない */}
      {!collapsed && (
        <div className="sidebar-resize-handle" onMouseDown={onDragStart} onDragStart={(e) => e.preventDefault()} />
      )}
      <div className="sidebar-head">
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'タブリストを開く' : 'タブリストを閉じる'}
          aria-label={collapsed ? 'タブリストを開く' : 'タブリストを閉じる'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      <button
        className={`tab-home ${homeActive ? 'active' : ''}`}
        onClick={onHome}
        title="ホーム（起動中セッション一覧）"
      >
        {collapsed ? '⌂' : '⌂ Home'}
      </button>
      <button className="tab-new" onClick={onNew} title="新しいセッション">
        {collapsed ? '＋' : '＋ 新しいセッション'}
      </button>
      <div className="tabs-list">
        {sessions
          // 共有モード中のセンシティブ指定はタブごと出さない（マスク表示だと
          // 「隠しているセッションがある」事実自体が見えてしまうため）。
          .filter((session) => !(shareMode && session.claudeSessionId && sensitiveIds?.has(session.claudeSessionId)))
          .map((session) => {
            const { parent, project, worktree } = parseCwd(session.cwd);
            const hasAttention = session.alive && attentionIds?.has(session.id);
            const isWaiting = Boolean(session.waitingFor) && session.alive;
            // Star / センシティブはホームと同じ claudeSessionId 単位。ここは表示専用（付け外しはホーム）
            const isStarredTab = Boolean(session.claudeSessionId && starredIds?.has(session.claudeSessionId));
            const isSensitiveTab = Boolean(session.claudeSessionId && sensitiveIds?.has(session.claudeSessionId));
            const className = `tab ${session.id === activeSessionId ? 'active' : ''} ${!session.alive ? 'dead' : ''} ${hasAttention ? 'tab-attention' : ''}`;

            if (collapsed) {
              // 折りたたみ時はアイコン相当（頭文字＋状態）だけ。詳細は tooltip に逃がす
              const typeLabel = session.type === 'tmux' ? ' [tmux]' : session.type === 'readonly' ? ' [閲覧]' : '';
              const stateLabel = isWaiting
                ? session.waitingFor === 'permission prompt'
                  ? ' / 許可待ち'
                  : ' / 回答待ち'
                : hasAttention
                  ? ' / 完了（未確認）'
                  : '';
              const markLabel = `${isStarredTab ? ' / ★ Star' : ''}${isSensitiveTab ? ' / 🔒 共有時は非表示' : ''}`;
              return (
                <div
                  key={session.id}
                  className={`${className} tab-mini ${isWaiting ? 'tab-mini-waiting' : ''}`}
                  onClick={() => session.alive && onSelect(session.id)}
                  title={`${session.name}${typeLabel}${stateLabel}${markLabel}\n${session.cwd || ''}`}
                >
                  <span className="tab-mini-avatar">{miniLabel(project)}</span>
                  {session.status && (
                    <span className={`tab-status tab-status-${session.status}`} title={session.status} />
                  )}
                  {(isStarredTab || isSensitiveTab) && (
                    <span className="tab-mini-marks">
                      {isStarredTab && <span className="tab-mark tab-mark-star">★</span>}
                      {isSensitiveTab && <span className="tab-mark tab-mark-lock">🔒</span>}
                    </span>
                  )}
                </div>
              );
            }

            return (
              <div key={session.id} className={className} onClick={() => session.alive && onSelect(session.id)}>
                <div className="tab-row">
                  {session.status && (
                    <span className={`tab-status tab-status-${session.status}`} title={session.status} />
                  )}
                  {isStarredTab && (
                    <span className="tab-mark tab-mark-star" title="Star 付き（未解決／続きをやる）">
                      ★
                    </span>
                  )}
                  {isSensitiveTab && (
                    <span className="tab-mark tab-mark-lock" title="共有モード中は隠すセッション">
                      🔒
                    </span>
                  )}
                  {session.type === 'tmux' && <span className="tab-badge">tmux</span>}
                  {session.type === 'readonly' && <span className="tab-badge">閲覧</span>}
                  {hasAttention && (
                    <span className="tab-badge tab-badge-attention" title="応答が完了しました（未確認）">
                      完了
                    </span>
                  )}
                  {isWaiting && (
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
                  <span className="tab-cwd-project">
                    {parent && <span className="tab-cwd-parent">{parent}/</span>}
                    {project}
                  </span>
                  {worktree && <span className="tab-cwd-worktree">⎇ {worktree}</span>}
                </span>
              </div>
            );
          })}
      </div>
      {/* 折りたたみ中は幅が足りないので出さない */}
      {!collapsed && <ShortcutHints />}
    </div>
  );
}
