import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TbChevronDown,
  TbEye,
  TbFolder,
  TbGitBranch,
  TbLock,
  TbPencil,
  TbPictureInPicture,
  TbPower,
  TbRefresh,
  TbStarFilled,
  TbTag,
  TbTerminal2,
  TbTrash,
  TbX,
} from 'react-icons/tb';
import { parseCwd } from '../utils/cwdLabel.js';
import { contextPercent, formatTokens, sidebarUsageColor } from '../utils/contextUsage.js';
import { autoGroupKeyOf, representativeDirOf, shouldShowDir, visibleTabsOf } from '../utils/tabGroups.js';
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

  // グループ色はドット（見出しとディレクトリ前）にだけ使う。並び順でパレットを回す
  const colorByKey = new Map(shownGroups.map((group, index) => [group.key, `var(--cal-${index % 8})`]));

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
        {shownGroups.map((group) => {
          const visible = visibleTabsOf(group, activeSessionId);
          const hasActive = group.sessions.some((s) => s.id === activeSessionId);
          const dropping = dropTarget?.group === group.key;
          const groupColor = colorByKey.get(group.key);
          if (!groups) return visible.map((session) => renderTab(session, group));
          // 見出しにはグループ名（＝リポジトリ名）を優先し、代表ディレクトリは置き場所（親パス）だけ出す。
          // フルパスは tooltip
          const repDir = representativeDirOf(group);
          const repParent = repDir ? repDir.slice(0, repDir.lastIndexOf('/')) || '/' : null;
          // 折りたたみ表示では見出しを出さず、色ドットだけで区切る（名前は tooltip）
          const header = collapsed ? (
            <span className="tab-group-mini-dot" style={{ background: groupColor }} />
          ) : (
            <div
              className={`tab-group-header${group.manual ? ' manual' : ''}${dropping ? ' tab-group-drop' : ''}${group.collapsed && hasActive ? ' has-active' : ''}`}
              onClick={() => groupActions?.onToggle(group.key)}
              title={group.manual ? group.label : repDir || group.key.slice(2) || 'cwd 不明'}
              {...groupDndPropsOf(group)}
            >
              <TbChevronDown className={`tab-group-caret${group.collapsed ? ' closed' : ''}`} aria-hidden="true" />
              {group.manual ? (
                <TbTag className="tab-group-kind" aria-label="自作グループ" />
              ) : (
                <TbFolder className="tab-group-kind" aria-label="ディレクトリグループ" />
              )}
              <span className="tab-group-dot" style={{ background: groupColor }} />
              <span className="tab-group-label">{group.label}</span>
              {repDir && (
                <span className="tab-group-dir" title={repDir}>
                  {repParent}
                </span>
              )}
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
                    <TbPencil />
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
                    <TbTrash />
                  </button>
                </span>
              )}
            </div>
          );
          return (
            <div
              key={group.key}
              className={`tab-group${group.manual ? ' manual' : ''}${group.collapsed ? ' is-collapsed' : ''}${hasActive ? ' has-active' : ''}`}
              title={collapsed ? group.label : undefined}
            >
              {header}
              {visible.length > 0 && (
                <div className="tab-group-body">{visible.map((session) => renderTab(session, group))}</div>
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

  function renderTab(session, group) {
    const groupKey = group?.key;
    const { project, worktree } = parseCwd(session.cwd);
    const hasAttention = session.alive && attentionIds?.has(session.id);
    const isWaiting = Boolean(session.waitingFor) && session.alive;
    // Star / センシティブはホームと同じ claudeSessionId 単位。ここは表示専用（付け外しはホーム）
    const isStarredTab = Boolean(session.claudeSessionId && starredIds?.has(session.claudeSessionId));
    const isSensitiveTab = Boolean(session.claudeSessionId && sensitiveIds?.has(session.claudeSessionId));
    // プレビューを小窓（PiP）に出しているセッション。小窓は他のタブへ移っても残るので、どこから開いたかを示す
    const isPipTab = Boolean(pipSessionId) && session.id === pipSessionId;
    const className = `tab ${session.id === activeSessionId ? 'active' : ''} ${!session.alive ? 'dead' : ''} ${hasAttention ? 'tab-attention' : ''}${dndClassOf(session)}`;
    const dot = statusDotOf(session, { isWaiting, hasAttention });

    if (collapsed) {
      // 折りたたみ時はアイコン相当（頭文字＋状態）だけ。詳細は tooltip に逃がす
      const typeLabel = TYPE_LABELS[session.type || 'pty'] ? ` [${TYPE_LABELS[session.type || 'pty']}]` : '';
      const markLabel = `${isStarredTab ? ' / ★ Star' : ''}${isSensitiveTab ? ' / 🔒 共有時は非表示' : ''}${isPipTab ? ' / ⧉ 小窓でプレビュー中' : ''}`;
      return (
        <div
          key={session.id}
          {...dndPropsOf(session, groupKey)}
          className={`${className} tab-mini`}
          onClick={() => session.alive && onSelect(session.id)}
          title={`${session.name}${typeLabel} / ${dot.title}${markLabel}\n${session.cwd || ''}`}
        >
          <span className="tab-mini-avatar">{miniLabel(project)}</span>
          <span className={`tab-status ${dot.className}`} />
          {(isStarredTab || isSensitiveTab || isPipTab) && (
            <span className="tab-mini-marks">
              {isStarredTab && <TbStarFilled className="tab-mark tab-mark-star" />}
              {isSensitiveTab && <TbLock className="tab-mark tab-mark-lock" />}
              {isPipTab && <TbPictureInPicture className="tab-mark tab-mark-pip" />}
            </span>
          )}
        </div>
      );
    }

    // コンテキスト使用率は展開表示のみ（折りたたみ時は幅が足りない）
    const contextUsage = contextBySession?.get(session.id) || null;
    const contextPct = contextUsage ? contextPercent(contextUsage) : 0;
    const showDir = shouldShowDir(session, group) && Boolean(project);
    // 対応するディレクトリグループが表示されていれば、その色のドットで出どころを紐づける
    const dirColor = showDir ? colorByKey.get(autoGroupKeyOf(session)) : null;
    const typeLabel = TYPE_LABELS[session.type || 'pty'];
    const TypeIcon = TYPE_ICONS[session.type || 'pty'];
    const hasMeta =
      isStarredTab || showDir || worktree || typeLabel || isSensitiveTab || isPipTab || Boolean(contextUsage);

    return (
      <div
        key={session.id}
        {...dndPropsOf(session, groupKey)}
        className={className}
        onClick={() => session.alive && onSelect(session.id)}
      >
        <div className="tab-row">
          <span className={`tab-status ${dot.className}`} title={dot.title} />
          <span className="tab-name" title={session.name}>
            {session.name}
          </span>
        </div>
        {hasMeta && (
          <div className="tab-meta">
            {isStarredTab && (
              <TbStarFilled className="tab-mark tab-mark-star" title="Star 付き（未解決／続きをやる）" />
            )}
            {showDir && (
              <span className="tab-meta-item tab-dir" title={session.cwd}>
                {dirColor && <span className="tab-dir-dot" style={{ background: dirColor }} />}
                <TbFolder className="tab-meta-icon" aria-hidden="true" />
                <span className="tab-meta-text mono">{project}</span>
              </span>
            )}
            {worktree && (
              <span className="tab-meta-item tab-branch" title={`worktree: ${worktree}`}>
                <TbGitBranch className="tab-meta-icon" aria-hidden="true" />
                <span className="tab-meta-text">{worktree}</span>
              </span>
            )}
            {/* tmux は既定なので出さない。それ以外の実行形態だけ薄いアイコンで例外として示す */}
            {typeLabel && TypeIcon && <TypeIcon className="tab-meta-icon tab-type" title={typeLabel} />}
            {isSensitiveTab && <TbLock className="tab-mark tab-mark-lock" title="共有モード中は隠すセッション" />}
            {isPipTab && (
              <TbPictureInPicture
                className="tab-mark tab-mark-pip"
                title="このセッションのプレビューを小窓に出しています（レビューはこのセッションへ送られます）"
              />
            )}
            {contextUsage && (
              <span
                className="tab-context"
                title={`コンテキスト ${formatTokens(contextUsage.contextTokens)} / ${formatTokens(contextUsage.contextWindow)}`}
              >
                <span className="tab-context-bar">
                  <span
                    className="tab-context-fill"
                    style={{ width: `${contextPct}%`, background: sidebarUsageColor(contextPct) }}
                  />
                </span>
                <span className="tab-context-num">{contextPct}%</span>
              </span>
            )}
          </div>
        )}
        <span className="tab-actions">
          {session.alive && session.type === 'tmux' && onTerminateTmux && (
            <button
              className="tab-action tab-terminate"
              onClick={(e) => {
                e.stopPropagation();
                onTerminateTmux(session);
              }}
              title="claude を終了してペインを閉じる"
              aria-label="claude を終了してペインを閉じる"
            >
              <TbPower />
            </button>
          )}
          {!session.alive && (
            <button
              className="tab-action tab-restart"
              onClick={(e) => {
                e.stopPropagation();
                onRestart(session.id);
              }}
              title="同じ設定で再起動"
              aria-label="同じ設定で再起動"
            >
              <TbRefresh />
            </button>
          )}
          <button
            className="tab-action tab-close"
            onClick={(e) => {
              e.stopPropagation();
              if (!session.alive) onRemovePast(session.id);
              else if (session.type === 'tmux') onDetachTmux(session.id);
              else if (session.type === 'readonly') onCloseReadonly(session.id);
              else onKill(session.id);
            }}
            title={closeTitleOf(session)}
            aria-label={closeTitleOf(session)}
          >
            <TbX />
          </button>
        </span>
      </div>
    );
  }
}

// 実行形態のうち例外として示すもの（tmux は既定なので載せない。内蔵 PTY は type を持たない）
const TYPE_LABELS = { readonly: '閲覧', pty: '内蔵' };
const TYPE_ICONS = { readonly: TbEye, pty: TbTerminal2 };

function closeTitleOf(session) {
  if (!session.alive) return '履歴から削除';
  if (session.type === 'tmux' || session.type === 'readonly') return '閉じる';
  return 'セッションを終了';
}

// 行頭ドット 1 か所で状態を表す（文字ラベルは使わない）。
// 色は意味を固定する: 緑＝動いている（処理中は点滅・応答完了で未確認は光る）、黄＝操作が必要、赤＝エラー
function statusDotOf(session, { isWaiting, hasAttention }) {
  if (!session.alive) return { className: 'tab-status-dead', title: '停止' };
  if (session.status === 'failed') return { className: 'tab-status-failed', title: '起動に失敗しました' };
  if (session.status === 'starting') return { className: 'tab-status-starting', title: '起動中…' };
  if (isWaiting) {
    return {
      className: 'tab-status-waiting',
      title: session.waitingFor === 'permission prompt' ? '許可待ち' : '回答待ち',
    };
  }
  if (session.status === 'busy') return { className: 'tab-status-busy', title: '処理中' };
  if (hasAttention) return { className: 'tab-status-attention', title: '応答が完了しました（未確認）' };
  if (session.status === 'idle') return { className: 'tab-status-idle', title: '入力待ち' };
  return { className: 'tab-status-none', title: session.status || '状態不明' };
}
