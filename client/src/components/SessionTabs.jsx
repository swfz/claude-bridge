import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCwd } from '../utils/cwdLabel.js';
import { contextColorFor, contextPercent, formatTokens } from '../utils/contextUsage.js';
import { visibleTabsOf } from '../utils/tabGroups.js';
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

// tmux で再開した直後は claude の起動を確かめるまで 'starting'（回転表示）、失敗なら 'failed'
const STATUS_TITLES = { starting: '起動中…', failed: '起動に失敗しました' };
const statusTitle = (status) => STATUS_TITLES[status] || status;

export default function SessionTabs({
  sessions,
  groups,
  groupActions,
  activeSessionId,
  homeActive,
  attentionIds,
  sensitiveIds,
  starredIds,
  pipSessionId,
  contextBySession,
  shareMode,
  onHome,
  onSelect,
  onKill,
  onRestart,
  onRemovePast,
  onDetachTmux,
  onTerminateTmux,
  onCloseReadonly,
  onNew,
  onReorder,
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

  // タブの D&D 並べ替え。落とす位置は対象タブの上半分なら前、下半分なら後ろ
  // 別グループのタブ・見出しへ落とすとそのグループへ移す（groupKey を onReorder に添える）
  const [dragId, setDragId] = useState(null);
  const [dragGroupKey, setDragGroupKey] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // {id, after} | {group}
  const endDrag = useCallback(() => {
    setDragId(null);
    setDragGroupKey(null);
    setDropTarget(null);
  }, []);
  const movedGroupKey = (groupKey) => (groupKey && groupKey !== dragGroupKey ? groupKey : undefined);
  const dndPropsOf = (session, groupKey) =>
    onReorder
      ? {
          draggable: true,
          onDragStart: (e) => {
            setDragId(session.id);
            setDragGroupKey(groupKey || null);
            e.dataTransfer.effectAllowed = 'move';
            // Firefox はデータを積まないとドラッグが始まらない
            e.dataTransfer.setData('text/plain', session.id);
          },
          onDragOver: (e) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            setDropTarget((prev) =>
              prev?.id === session.id && prev.after === after ? prev : { id: session.id, after },
            );
          },
          onDrop: (e) => {
            if (!dragId) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            onReorder(dragId, session.id, e.clientY > rect.top + rect.height / 2, movedGroupKey(groupKey));
            endDrag();
          },
          onDragEnd: endDrag,
        }
      : {};
  const dndClassOf = (session) => {
    if (!dragId) return '';
    if (session.id === dragId) return ' tab-dragging';
    if (dropTarget?.id === session.id && session.id !== dragId) {
      return dropTarget.after ? ' tab-drop-after' : ' tab-drop-before';
    }
    return '';
  };

  // グループ見出しへの D&D（グループの末尾へ入れる）
  const groupDndPropsOf = (group) =>
    onReorder
      ? {
          onDragOver: (e) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget((prev) => (prev?.group === group.key ? prev : { group: group.key }));
          },
          onDrop: (e) => {
            if (!dragId) return;
            e.preventDefault();
            const last = group.sessions.filter((s) => s.id !== dragId).at(-1);
            onReorder(dragId, last?.id || null, true, movedGroupKey(group.key));
            endDrag();
          },
        }
      : {};

  const handleCreateGroup = () => {
    const name = window.prompt('新しいグループの名前');
    if (name?.trim()) groupActions?.onCreate(name);
  };
  const handleRenameGroup = (group) => {
    const name = window.prompt('グループ名', group.label);
    if (name?.trim()) groupActions?.onRename(group.key.slice(2), name);
  };
  const handleDeleteGroup = (group) => {
    if (window.confirm(`グループ「${group.label}」を削除しますか？（タブはプロジェクトのグループへ戻ります）`)) {
      groupActions?.onDelete(group.key.slice(2));
    }
  };

  // 共有モード中のセンシティブ指定はタブごと出さない（マスク表示だと
  // 「隠しているセッションがある」事実自体が見えてしまうため）。
  const isHidden = (session) => shareMode && session.claudeSessionId && sensitiveIds?.has(session.claudeSessionId);
  const shownGroups = (groups || [{ key: '', label: '', manual: false, collapsed: false, sessions }])
    .map((group) => ({ ...group, sessions: group.sessions.filter((s) => !isHidden(s)) }))
    // 自動グループは中身が無ければ出さない。手動グループは空でも落とし先として出す
    .filter((group) => group.manual || group.sessions.length > 0);

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
        {shownGroups.map((group, index) => {
          const visible = visibleTabsOf(group, activeSessionId);
          const hasActive = group.sessions.some((s) => s.id === activeSessionId);
          const dropping = dropTarget?.group === group.key;
          // 折りたたみ表示では見出しを出さず、色帯付きの枠だけで示す（名前は枠の tooltip）
          const header = collapsed ? null : (
            <div
              className={`tab-group-header${group.manual ? ' manual' : ''}${dropping ? ' tab-group-drop' : ''}${group.collapsed && hasActive ? ' has-active' : ''}`}
              onClick={() => groupActions?.onToggle(group.key)}
              title={group.manual ? group.label : group.key.slice(2) || 'cwd 不明'}
              {...groupDndPropsOf(group)}
            >
              <span className="tab-group-caret">{group.collapsed ? '▸' : '▾'}</span>
              <span className="tab-group-label">{group.label}</span>
              <span className="tab-group-count">{group.sessions.length}</span>
              {group.manual && (
                <span className="tab-group-actions">
                  <button
                    className="tab-group-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameGroup(group);
                    }}
                    title="名前を変える"
                    aria-label="グループ名を変える"
                  >
                    ✎
                  </button>
                  <button
                    className="tab-group-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteGroup(group);
                    }}
                    title="グループを削除"
                    aria-label="グループを削除"
                  >
                    x
                  </button>
                </span>
              )}
            </div>
          );
          if (!groups) return visible.map((session) => renderTab(session, group.key));
          // グループごとに枠で囲み、左の色帯で見分ける（色はカレンダーのプロジェクト色と同じパレットを並び順で回す）
          return (
            <div
              key={group.key}
              className={`tab-group${group.manual ? ' manual' : ''}${group.collapsed ? ' is-collapsed' : ''}${hasActive ? ' has-active' : ''}`}
              style={{ '--group-color': `var(--cal-${index % 8})` }}
              title={collapsed ? group.label : undefined}
            >
              {header}
              {visible.length > 0 && (
                <div className="tab-group-body">{visible.map((session) => renderTab(session, group.key))}</div>
              )}
            </div>
          );
        })}
        {groups && !collapsed && groupActions && (
          <button
            className="tab-group-new"
            onClick={handleCreateGroup}
            title="手動のグループを作る（タブを D&D で入れる）"
          >
            ＋ グループ
          </button>
        )}
      </div>
      {/* 折りたたみ中は幅が足りないので出さない */}
      {!collapsed && <ShortcutHints />}
    </div>
  );

  function renderTab(session, groupKey) {
    const { parent, project, worktree } = parseCwd(session.cwd);
    const hasAttention = session.alive && attentionIds?.has(session.id);
    const isWaiting = Boolean(session.waitingFor) && session.alive;
    // Star / センシティブはホームと同じ claudeSessionId 単位。ここは表示専用（付け外しはホーム）
    const isStarredTab = Boolean(session.claudeSessionId && starredIds?.has(session.claudeSessionId));
    const isSensitiveTab = Boolean(session.claudeSessionId && sensitiveIds?.has(session.claudeSessionId));
    // プレビューを小窓（PiP）に出しているセッション。小窓は他のタブへ移っても残るので、どこから開いたかを示す
    const isPipTab = Boolean(pipSessionId) && session.id === pipSessionId;
    const className = `tab ${session.id === activeSessionId ? 'active' : ''} ${!session.alive ? 'dead' : ''} ${hasAttention ? 'tab-attention' : ''}${dndClassOf(session)}`;
    // コンテキスト使用率は展開表示のみ（折りたたみ時は幅が足りない）
    const contextUsage = contextBySession?.get(session.id) || null;
    const contextPct = contextUsage ? contextPercent(contextUsage) : 0;

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
      const markLabel = `${isStarredTab ? ' / ★ Star' : ''}${isSensitiveTab ? ' / 🔒 共有時は非表示' : ''}${isPipTab ? ' / ⧉ 小窓でプレビュー中' : ''}`;
      return (
        <div
          key={session.id}
          {...dndPropsOf(session, groupKey)}
          className={`${className} tab-mini ${isWaiting ? 'tab-mini-waiting' : ''}`}
          onClick={() => session.alive && onSelect(session.id)}
          title={`${session.name}${typeLabel}${stateLabel}${markLabel}\n${session.cwd || ''}`}
        >
          <span className="tab-mini-avatar">{miniLabel(project)}</span>
          {session.status && (
            <span className={`tab-status tab-status-${session.status}`} title={statusTitle(session.status)} />
          )}
          {(isStarredTab || isSensitiveTab || isPipTab) && (
            <span className="tab-mini-marks">
              {isStarredTab && <span className="tab-mark tab-mark-star">★</span>}
              {isSensitiveTab && <span className="tab-mark tab-mark-lock">🔒</span>}
              {isPipTab && <span className="tab-mark tab-mark-pip">⧉</span>}
            </span>
          )}
        </div>
      );
    }

    return (
      <div
        key={session.id}
        {...dndPropsOf(session, groupKey)}
        className={className}
        onClick={() => session.alive && onSelect(session.id)}
      >
        <div className="tab-row">
          {session.status && (
            <span className={`tab-status tab-status-${session.status}`} title={statusTitle(session.status)} />
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
          {isPipTab && (
            <span
              className="tab-mark tab-mark-pip"
              title="このセッションのプレビューを小窓に出しています（レビューはこのセッションへ送られます）"
            >
              ⧉
            </span>
          )}
          {session.type === 'tmux' && <span className="tab-badge">tmux</span>}
          {session.type === 'readonly' && <span className="tab-badge">閲覧</span>}
          {session.status === 'starting' && <span className="tab-badge tab-badge-starting">起動中…</span>}
          {session.status === 'failed' && <span className="tab-badge tab-badge-failed">起動失敗</span>}
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
          {session.alive && session.type === 'tmux' && onTerminateTmux && (
            <button
              className="tab-terminate"
              onClick={(e) => {
                e.stopPropagation();
                onTerminateTmux(session);
              }}
              title="claude を終了してペインを閉じる"
              aria-label="claude を終了してペインを閉じる"
            >
              ⏻
            </button>
          )}
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
          {/* コンテキスト使用率。狭いので % だけ出し、内訳は tooltip に逃がす */}
          {contextUsage && (
            <span
              className="tab-context"
              style={{ color: contextColorFor(contextPct) }}
              title={`コンテキスト ${formatTokens(contextUsage.contextTokens)} / ${formatTokens(contextUsage.contextWindow)}`}
            >
              {contextPct}%
            </span>
          )}
        </span>
      </div>
    );
  }
}
