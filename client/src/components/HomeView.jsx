import { useCallback, useMemo, useState } from 'react';
import {
  TbGitBranch,
  TbLink,
  TbListDetails,
  TbLock,
  TbLockOpen,
  TbPlugConnected,
  TbPlugConnectedX,
  TbPower,
  TbSparkles,
  TbStar,
  TbStarFilled,
  TbUser,
} from 'react-icons/tb';
import {
  annotateRunningSessions,
  annotateRecentSessions,
  findUnmatchedTabs,
  statusClass,
  formatElapsed,
} from '../utils/runningSessions.js';
import { isStarred, sortStarredFirst } from '../utils/starredSessions.js';
import { isSensitive, splitSensitive } from '../utils/sensitiveSessions.js';
import RestorableBanner from './RestorableBanner.jsx';
import {
  COMPLETION_STATES,
  FILTERABLE_STATES,
  classifyCompletion,
  completionTooltip,
  countByCompletion,
  filterByCompletion,
} from '../utils/completionState.js';
import { parseCwd } from '../utils/cwdLabel.js';
import { filterBySearch, collectProjects, filterByProject, rankProjects } from '../utils/sessionSearch.js';
import ActivityPanel from './ActivityPanel.jsx';
import SessionDetailDrawer from './SessionDetailDrawer.jsx';
import HomeArtifactChips from './HomeArtifactChips.jsx';
import RecentPeek from './RecentPeek.jsx';
import { contextPercent, formatTokens, isUsageNotable, usageColor } from '../utils/contextUsage.js';
import { groupArtifactPublishes } from '../utils/artifacts.js';
import { modelBadgeLabel, modelTitleLine } from '../utils/modelLabel.js';
import './HomeView.css';

// 「その他の開いているタブ」は name/cwd しか持たないので検索対象をこの2つに絞る
const OTHER_TAB_SEARCH_FIELDS = ['name', 'cwd'];

// 「直近のセッション」の期間プリセット
const DAY_PRESETS = [1, 3, 7, 30];

// 既定ブランチは「どのセッションにも付く」＝識別に効かないので出さない
const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD']);

// 応答列の代わりに離席要約（現状と次の一手）を出す状態＝手を付け直す必要があるもの
const AWAY_STATES = new Set(['unfinished', 'interrupted', 'unpushed', 'merging']);

// ディレクトリの表記。サイドバー・トップバーと揃えて「ディレクトリ色のドット＋リポジトリ名（ホスト部分は省く）」に
// し、ブランチ（既定ブランチ以外。無ければ worktree 名）を添える。フルパスは title に逃がす。
// color はサイドバーのグループ色で、対応するグループが無ければ輪郭だけのドットにする
function PathLine({ cwd, branch, color }) {
  const { project, worktree } = parseCwd(cwd);
  if (!project) return null;
  const shownBranch = branch && !DEFAULT_BRANCHES.has(branch) ? branch : worktree;
  return (
    <div className="home-card-path" title={[cwd, branch].filter(Boolean).join(' · ')}>
      <span className={`home-dir-dot${color ? '' : ' none'}`} style={color ? { background: color } : undefined} />
      <span className="home-path-project">{project}</span>
      {shownBranch && (
        <span className="home-path-branch">
          <TbGitBranch aria-hidden="true" />
          {shownBranch}
        </span>
      )}
    </div>
  );
}

// 「未解決／続きをやる」の印。カードのクリック（＝開く）とは分けたいので伝播を止める。
function StarButton({ on, onToggle }) {
  return (
    <button
      className={`home-star ${on ? 'on' : ''}`}
      title={on ? 'Star を外す' : '未解決（続きをやる）として Star を付ける'}
      aria-label={on ? 'Star を外す' : 'Star を付ける'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? <TbStarFilled /> : <TbStar />}
    </button>
  );
}

// 画面共有で見せたくないセッションの印。Star と同じくカードのクリックとは分ける。
function SensitiveButton({ on, onToggle }) {
  return (
    <button
      className={`home-sensitive ${on ? 'on' : ''}`}
      title={on ? 'センシティブ指定を外す' : 'センシティブ指定（共有モードで隠す）'}
      aria-label={on ? 'センシティブ指定を外す' : 'センシティブ指定にする'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? <TbLock /> : <TbLockOpen />}
    </button>
  );
}

// 共有モードで隠した件数の注記（何件か分かれば十分なので中身は出さない）
function HiddenNote({ count }) {
  if (!count) return null;
  return <div className="home-hidden-note">🔒 {count} 件を非表示中（共有モード）</div>;
}

// カード内の会話抜粋（直近の指示・応答）。ラベルの代わりに人／AI のアイコンで区別し、1 行に clamp する。
function Snippet({ icon: Icon, label, text, role }) {
  if (!text) return null;
  return (
    <div className={`home-snippet ${role || ''}`} title={text}>
      <Icon className="home-snippet-icon" aria-label={label} />
      <span className="home-snippet-text">{text}</span>
    </div>
  );
}

// カードのフッターの使用率。サイドバーと同じ細いバー＋数値（しきい値で色が変わる）
function UsageBar({ usage }) {
  if (!usage) return null;
  const pct = contextPercent(usage);
  return (
    <span className="home-usage" title={contextTitle(usage)}>
      <span className="home-usage-bar">
        <span className="home-usage-fill" style={{ width: `${pct}%`, background: usageColor(pct) }} />
      </span>
      <span className="home-usage-value" style={isUsageNotable(pct) ? { color: usageColor(pct) } : undefined}>
        {pct}%
      </span>
    </span>
  );
}

// カードの Artifact は件数付きの小さなアイコン 1 つにまとめる。クリックで最後に公開したものを開き、
// 一覧は tooltip に出す
function ArtifactCount({ artifacts }) {
  const grouped = useMemo(() => groupArtifactPublishes(artifacts), [artifacts]);
  if (grouped.length === 0) return null;
  return (
    <a
      className="home-artifact-count"
      href={grouped[0].url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`公開した Artifact（クリックで最新を開く）\n${grouped.map((a) => a.title).join('\n')}`}
    >
      <TbLink aria-hidden="true" />
      {grouped.length}
    </a>
  );
}

// コンテキスト使用量のツールチップ（内訳）。カード・行で共用する。
function contextTitle(usage) {
  return `コンテキスト ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)}\ninput ${formatTokens(usage.inputTokens)} · cache 作成 ${formatTokens(usage.cacheCreationTokens)} · cache 読み込み ${formatTokens(usage.cacheReadTokens)}${modelTitleLine(usage.model)}`;
}

// 行リストの Ctx 列。使用率だけを色付きで出し、内訳は tooltip に逃がす。
// モデル名。一覧で最も多いモデル（defaultModel）と違うときだけ出す
function ModelLabel({ usage, defaultModel, className }) {
  const label = modelBadgeLabel(usage?.model, defaultModel);
  if (!label) return null;
  return (
    <span className={className} title={`モデル: ${usage.model}`}>
      {label}
    </span>
  );
}

function ContextCell({ usage }) {
  if (!usage) return <span className="home-row-ctx" />;
  const pct = contextPercent(usage);
  return (
    <span
      className="home-row-ctx"
      style={isUsageNotable(pct) ? { color: usageColor(pct) } : undefined}
      title={contextTitle(usage)}
    >
      {pct}%
    </span>
  );
}

// やり残し判定のバッジ。内訳（ターン終了・コミット済みか・未コミットのファイル・現状メモ）は tooltip
function CompletionBadge({ session, running }) {
  const state = classifyCompletion(session, { running });
  return (
    <span className={`home-completion ${state}`} title={completionTooltip(session, { running })}>
      {COMPLETION_STATES[state].label}
    </span>
  );
}

// ホーム画面。今このマシンで起動している Claude セッションと、
// 直近 N 日に動いていた（終了済みを含む）セッションを一覧する。
export default function HomeView({
  defaultModel,
  runningSessions,
  recentSessions,
  recentDays,
  onChangeRecentDays,
  includeHeadless,
  onChangeIncludeHeadless,
  recentPeriod,
  onChangeRecentPeriod,
  starred,
  onToggleStar,
  sensitive,
  shareMode,
  onToggleSensitive,
  sessions,
  activeSessionId,
  loading,
  recentLoading,
  heatmap,
  heatmapLoading,
  onRefreshHeatmap,
  calendar,
  calendarLoading,
  onRequestCalendar,
  sessionTurns,
  onRequestSessionTurns,
  recentExchanges,
  onRequestRecentExchanges,
  error,
  onDismissError,
  notice,
  onDismissNotice,
  restorable,
  onResumeRestorable,
  onDismissRestorable,
  onRefresh,
  onSelectTab,
  onAttachTmux,
  onTerminateTmux,
  onOpenReadonly,
  onResume,
  onResumeInTmux,
  onNew,
  dirColorOf = () => null,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  // 直近一覧の状態絞り込み（やり残し / 途中で終了 / 完了）。その場限りなので保存しない
  const [completionFilter, setCompletionFilter] = useState('');
  // セッション詳細（ターン詳細）のパネルに出しているセッション。{sessionId, projectDir, title, cwd}
  const [detailTarget, setDetailTarget] = useState(null);

  // Star を付けたものは「続きをやる」印なので、それぞれの一覧で先頭に寄せる
  const annotatedAll = sortStarredFirst(annotateRunningSessions(runningSessions, sessions), starred);
  const recentAll = sortStarredFirst(annotateRecentSessions(recentSessions, runningSessions, sessions), starred);
  const otherTabsAll = findUnmatchedTabs(runningSessions, sessions, recentSessions);

  // 共有モードのときはここでセンシティブ指定を落とし、以降の集計（プロジェクトチップ・
  // 件数・検索）は残った側だけで行う。集計に混ぜるとチップや件数からパスが漏れる。
  const split = (items, keyOf) =>
    shareMode ? splitSensitive(items, sensitive, keyOf) : { visible: items, hidden: [] };
  const { visible: annotated, hidden: hiddenRunning } = split(annotatedAll);
  const { visible: recent, hidden: hiddenRecent } = split(recentAll);
  const { visible: otherTabsVisible, hidden: hiddenOtherTabs } = split(otherTabsAll, (t) => t.claudeSessionId);

  const starredCount = [...annotated, ...recent].filter((s) => isStarred(starred, s.sessionId)).length;

  // プロジェクトのチップは起動中のセッションがあるものだけを件数順に 1 行で出し、
  // 起動中の無いプロジェクト（直近だけにあるもの）は「他のディレクトリ」のプルダウンから選ぶ
  const runningProjects = rankProjects(annotated);
  const runningProjectNames = new Set(runningProjects.map((p) => p.project));
  const otherProjects = collectProjects(recent).filter((p) => !runningProjectNames.has(p));

  // プロジェクト絞り込み → テキスト検索の順で AND 適用
  const filteredAnnotated = filterBySearch(filterByProject(annotated, selectedProject), searchQuery);
  const searchedRecent = filterBySearch(filterByProject(recent, selectedProject), searchQuery);
  // 件数はプロジェクト・検索で絞った後の母数で数える（チップの数字と一覧の件数を一致させる）
  const completionCounts = countByCompletion(searchedRecent);
  const filteredRecent = filterByCompletion(searchedRecent, completionFilter);
  const otherTabs = filterBySearch(
    filterByProject(otherTabsVisible, selectedProject),
    searchQuery,
    OTHER_TAB_SEARCH_FIELDS,
  );

  const isFiltering = searchQuery.trim().length > 0 || !!selectedProject;
  const isFilteringRecent = isFiltering || !!completionFilter;
  const emptyMessageFor = (defaultText) => (isFiltering ? '条件に一致するセッションはありません' : defaultText);

  // タブの識別名はカードに出しているサマリー（AI タイトル）を優先する。
  // r.name は自動生成スラッグで中身が分からないことが多い。
  const tabName = (r) => r.title || r.name || r.sessionId.slice(0, 8);

  const openTmux = (r) => {
    onAttachTmux({
      paneId: r.paneId,
      name: tabName(r),
      cwd: r.cwd,
      target: r.tmuxTarget,
      claudePid: r.pid,
      claudeSessionId: r.sessionId,
      status: r.status,
    });
  };

  const openReadonly = (r) => {
    onOpenReadonly({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
      projectDir: r.projectDir,
    });
  };

  const resume = (r) => {
    onResume({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
      projectDir: r.projectDir,
    });
  };

  const resumeInTmux = (r) => {
    onResumeInTmux({
      claudeSessionId: r.sessionId,
      name: tabName(r),
      cwd: r.cwd,
      projectDir: r.projectDir,
    });
  };

  // カード全体のクリックは「一番やりたいこと」に割り当てる:
  // 開いていればそのタブへ移動、tmux ペインがあれば接続、無ければ閲覧で開く。
  const handleCardClick = (r) => {
    if (r.openTab) onSelectTab(r.openTab.id);
    else if (r.paneId) openTmux(r);
    else openReadonly(r);
  };

  // カレンダーの帯・セッション詳細の「開く」。カードと同じく「開いていればそのタブ / tmux ペインが
  // あれば接続 / 無ければ閲覧」の順で開く（起動中かどうかは running_sessions で引く）
  const openSession = (target) => {
    setDetailTarget(null);
    const openTab = (sessions || []).find((t) => t.alive && t.claudeSessionId === target.sessionId);
    if (openTab) return onSelectTab(openTab.id);
    const running = (runningSessions || []).find((r) => r.sessionId === target.sessionId);
    if (running?.paneId) return openTmux({ ...running, title: running.title || target.title });
    openReadonly({ sessionId: target.sessionId, title: target.title, cwd: target.cwd, projectDir: target.projectDir });
  };

  // カードの「詳細」・行の「詳細」・カレンダーの帯から、セッション詳細のパネルを開く
  const openDetail = (s) =>
    setDetailTarget({ sessionId: s.sessionId, projectDir: s.projectDir, title: s.title || tabName(s), cwd: s.cwd });
  const closeDetail = useCallback(() => setDetailTarget(null), []);

  // 共有モードではセンシティブ指定のセッションを帯にも出さない（タイトル・パスが見えるため）
  const calendarData =
    shareMode && calendar ? { ...calendar, sessions: splitSensitive(calendar.sessions, sensitive).visible } : calendar;

  // 直近の行の「タブで開いている」印（更新時刻の代わりに出す）
  const openLabel = (openTab) => {
    if (!openTab) return null;
    const suffix = openTab.type === 'readonly' ? '・閲覧' : openTab.type === 'tmux' ? '・tmux' : '';
    return <span className="home-open-mark">タブ{suffix}</span>;
  };

  return (
    <div className="home-view">
      {/* 草は一覧のどのセクションにも属さないので、見出しより前・画面の最上段に置く */}
      <ActivityPanel
        data={heatmap}
        loading={heatmapLoading}
        onRefresh={onRefreshHeatmap}
        selectedPeriod={recentPeriod}
        onSelectPeriod={onChangeRecentPeriod}
        calendar={calendarData}
        calendarLoading={calendarLoading}
        onRequestCalendar={onRequestCalendar}
        onOpenSession={openDetail}
        dirColorOf={dirColorOf}
      />

      <div className="home-header">
        <h2 className="home-title">起動中の Claude セッション</h2>
        <div className="home-header-actions">
          <div className="home-search-box">
            <input
              type="search"
              className="home-search"
              placeholder="検索（タイトル・依頼・パス・ブランチ）"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="home-search-clear" onClick={() => setSearchQuery('')} title="検索をクリア">
                ×
              </button>
            )}
          </div>
          {starredCount > 0 && (
            <span className="home-count starred-count" title="Star を付けたセッション">
              ★ {starredCount}
            </span>
          )}
          <span className="home-count">
            {isFiltering ? `${filteredAnnotated.length} / ${annotated.length} 件` : `${annotated.length} 件`}
          </span>
          <button className="btn btn-ghost" onClick={onRefresh} title="一覧を更新">
            更新
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            新しいセッション
          </button>
        </div>
      </div>

      {(runningProjects.length > 1 || otherProjects.length > 0) && (
        <div className="home-projects">
          <button
            className={`home-project-chip ${selectedProject ? '' : 'active'}`}
            onClick={() => setSelectedProject('')}
          >
            すべて
          </button>
          {runningProjects.map(({ project, count, cwd }) => {
            const color = dirColorOf(cwd);
            return (
              <button
                key={project}
                className={`home-project-chip ${selectedProject === project ? 'active' : ''}`}
                onClick={() => setSelectedProject((prev) => (prev === project ? '' : project))}
              >
                <span
                  className={`home-dir-dot${color ? '' : ' none'}`}
                  style={color ? { background: color } : undefined}
                />
                {project}
                <span className="home-project-count">{count}</span>
              </button>
            );
          })}
          {otherProjects.length > 0 && (
            <select
              className={`home-project-other${otherProjects.includes(selectedProject) ? ' active' : ''}`}
              value={otherProjects.includes(selectedProject) ? selectedProject : ''}
              onChange={(e) => setSelectedProject(e.target.value)}
              aria-label="起動中のセッションが無いディレクトリで絞り込む"
            >
              <option value="">他のディレクトリ…</option>
              {otherProjects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <RestorableBanner
        restorable={restorable}
        sensitive={sensitive}
        shareMode={shareMode}
        onResume={onResumeRestorable}
        onDismiss={onDismissRestorable}
      />

      {error && (
        <div className="home-error">
          <span className="home-error-text">{error}</span>
          <button className="home-error-close" onClick={onDismissError} title="閉じる">
            ×
          </button>
        </div>
      )}

      {notice && (
        <div className="home-notice">
          <span className="home-error-text">{notice}</span>
          <button className="home-error-close" onClick={onDismissNotice} title="閉じる">
            ×
          </button>
        </div>
      )}

      {filteredAnnotated.length === 0 ? (
        <p className="home-empty">
          {loading
            ? '読み込み中...'
            : emptyMessageFor(
                '起動中の Claude セッションはありません（tmux やターミナルで claude を起動すると表示されます）',
              )}
        </p>
      ) : (
        <div className="home-grid">
          {filteredAnnotated.map((r) => {
            // タブとして開いていればその表示名をそのまま使い、カードとタブの見出しを一致させる
            const label = r.openTab?.name || tabName(r);
            const starredNow = isStarred(starred, r.sessionId);
            const sensitiveNow = isSensitive(sensitive, r.sessionId);
            // Bridge 未接続（タブとして開いていない）は大半が接続済みなので、未接続の側だけ見た目を変える
            const linked = !!r.openTab;
            const waiting = !!r.waitingFor;
            const dotClass = waiting ? 'waiting' : statusClass(r.status);
            const dotTitle = waiting ? (r.waitingFor === 'permission prompt' ? '許可待ち' : '回答待ち') : r.status;
            return (
              <div
                key={r.sessionId}
                className={`home-card${linked ? '' : ' unlinked'}${r.openTab?.id === activeSessionId ? ' current' : ''}`}
                onClick={() => handleCardClick(r)}
                title={[
                  r.sessionId,
                  `pid ${r.pid}`,
                  r.tmuxTarget && `tmux ${r.tmuxTarget}`,
                  r.kind !== 'interactive' && r.kind,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <div className="home-card-top">
                  <PathLine cwd={r.cwd} branch={r.gitBranch} color={dirColorOf(r.cwd)} />
                  {/* 例外の印だけを右端に置く（ホバー中はアクションのアイコンが上に重なる） */}
                  <span className="home-card-marks">
                    {starredNow && <TbStarFilled className="home-mark-star" aria-label="Star" />}
                    {sensitiveNow && <TbLock className="home-mark-lock" aria-label="センシティブ指定" />}
                    {!linked && (
                      <span className="home-unlinked-mark">
                        <TbPlugConnectedX aria-hidden="true" />
                        未接続
                      </span>
                    )}
                  </span>
                </div>

                <div className="home-card-name" title={label}>
                  <span className={`home-status home-status-${dotClass}`} title={dotTitle || 'unknown'} />
                  <span className="home-card-name-text">{label}</span>
                  <ModelLabel usage={r.contextUsage} defaultModel={defaultModel} className="home-model" />
                </div>

                <div className="home-card-snippets">
                  <Snippet icon={TbUser} label="直近の指示" text={r.lastUserMessage || r.firstUserMessage} />
                  <Snippet icon={TbSparkles} label="応答" text={r.lastAssistantMessage} role="assistant" />
                </div>

                <div className="home-card-meta">
                  <UsageBar usage={r.contextUsage} />
                  <CompletionBadge session={r} running />
                  <ArtifactCount artifacts={r.artifacts} />
                  <span className="home-card-time">{formatElapsed(r.updatedAt)}</span>
                </div>

                {/* 操作は右上のアイコンとしてホバー時だけ出す（重ねるだけなのでカードの高さは変わらない） */}
                <div className="home-card-actions" onClick={(e) => e.stopPropagation()}>
                  {!linked && (
                    <button
                      className="home-action primary"
                      onClick={() => (r.paneId ? openTmux(r) : openReadonly(r))}
                      title={r.paneId ? 'tmux ペインに接続してタブで開く' : '閲覧タブで開く（tmux 外で起動中）'}
                    >
                      <TbPlugConnected aria-hidden="true" />
                      Bridge に接続
                    </button>
                  )}
                  <StarButton on={starredNow} onToggle={() => onToggleStar(r.sessionId)} />
                  <SensitiveButton on={sensitiveNow} onToggle={() => onToggleSensitive(r.sessionId)} />
                  {r.projectDir && (
                    <button
                      className="home-icon-action"
                      onClick={() => openDetail(r)}
                      title="詳細（指示ごとのトークン・コミット・PR）"
                      aria-label="詳細"
                    >
                      <TbListDetails />
                    </button>
                  )}
                  {r.paneId && onTerminateTmux && (
                    <button
                      className="home-icon-action home-action danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTerminateTmux({
                          paneId: r.paneId,
                          claudeSessionId: r.sessionId,
                          name: label,
                          status: r.status,
                          target: r.tmuxTarget,
                        });
                      }}
                      title="claude を終了してペインを閉じる"
                      aria-label="終了"
                    >
                      <TbPower />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <HiddenNote count={hiddenRunning.length} />

      <div className="home-section">
        <div className="home-header">
          <h3 className="home-subtitle">
            {recentPeriod
              ? `直近のセッション（${recentPeriod.label} に活動）`
              : '直近のセッション（起動していないもの）'}
          </h3>
          <div className="home-header-actions">
            <div className="home-days">
              {/* 期間で絞っている間は日数モードではないのでプリセットを光らせない。
                  押されたら絞り込みを解除して日数モードへ戻す */}
              {DAY_PRESETS.map((d) => (
                <button
                  key={d}
                  className={`home-day ${!recentPeriod && d === recentDays ? 'active' : ''}`}
                  onClick={() => {
                    onChangeRecentDays(d);
                    onChangeRecentPeriod(null);
                  }}
                >
                  {d}日
                </button>
              ))}
            </div>
            {recentPeriod && (
              <span className="home-period-chip">
                {recentPeriod.label}
                <button
                  className="home-period-clear"
                  onClick={() => onChangeRecentPeriod(null)}
                  title="期間の絞り込みを解除"
                >
                  ×
                </button>
              </span>
            )}
            {/* `claude -p` のセッション（スケジュール実行など）は数が多く一覧を埋めるので既定で隠す */}
            <button
              className={`home-day home-headless-toggle ${includeHeadless ? 'active' : ''}`}
              onClick={() => onChangeIncludeHeadless(!includeHeadless)}
              aria-pressed={!!includeHeadless}
              title={
                includeHeadless
                  ? 'claude -p（非対話実行）のセッションを表示中。クリックで隠す'
                  : 'claude -p（非対話実行）のセッションは隠しています。クリックで表示'
              }
            >
              claude -p
            </button>
            {/* 状態ごとの件数はプルダウン 1 つに畳む（件数はプロジェクト・検索で絞った後の母数） */}
            <select
              className={`home-completion-filter${completionFilter ? ' active' : ''}`}
              value={completionFilter}
              onChange={(e) => setCompletionFilter(e.target.value)}
              aria-label="状態で絞り込む"
              title={completionFilter ? COMPLETION_STATES[completionFilter].title : '状態で絞り込む'}
            >
              <option value="">状態: すべて</option>
              {FILTERABLE_STATES.map((state) => (
                <option key={state} value={state}>
                  {COMPLETION_STATES[state].label} {completionCounts[state] || 0}
                </option>
              ))}
            </select>
            <span className="home-count">
              {isFilteringRecent ? `${filteredRecent.length} / ${recent.length} 件` : `${recent.length} 件`}
            </span>
          </div>
        </div>

        {filteredRecent.length === 0 ? (
          <p className="home-empty">
            {recentLoading
              ? '読み込み中...'
              : completionFilter
                ? `「${COMPLETION_STATES[completionFilter].label}」のセッションはありません`
                : emptyMessageFor(
                    recentPeriod
                      ? `${recentPeriod.label} に活動したセッションはありません`
                      : `直近 ${recentDays} 日に動いていたセッションはありません`,
                  )}
          </p>
        ) : (
          // 直近は「見比べる」より「探す」一覧なので、カードではなく列の揃った行で出す
          <div className="home-rows">
            {/* 列名。行と同じ grid を共有するので列位置がずれない */}
            <div className="home-rows-header">
              <span />
              <span />
              <span>プロジェクト</span>
              <span>タイトル</span>
              <span />
              <span>直近の指示</span>
              <span>応答</span>
              <span>Artifact</span>
              <span>状態</span>
              <span>Ctx</span>
              <span className="home-row-time">更新</span>
            </div>
            {filteredRecent.map((s) => {
              const label = s.openTab?.name || tabName(s);
              const starredNow = isStarred(starred, s.sessionId);
              const snippet = s.lastUserMessage || s.firstUserMessage;
              // やり残し・途中で終了の行は、応答の代わりに Claude Code の離席要約（現状と次の一手）を出す
              const state = classifyCompletion(s);
              const away = AWAY_STATES.has(state) && s.awaySummary?.text;
              return (
                <div
                  key={s.sessionId}
                  className={`home-row${s.openTab?.id === activeSessionId ? ' current' : ''}`}
                  onClick={() => (s.openTab ? onSelectTab(s.openTab.id) : openReadonly(s))}
                >
                  <StarButton on={starredNow} onToggle={() => onToggleStar(s.sessionId)} />
                  <SensitiveButton
                    on={isSensitive(sensitive, s.sessionId)}
                    onToggle={() => onToggleSensitive(s.sessionId)}
                  />
                  <PathLine cwd={s.cwd} branch={s.gitBranch} color={dirColorOf(s.cwd)} />
                  <span className="home-row-name" title={label}>
                    <span className="home-row-name-text">{label}</span>
                    <ModelLabel usage={s.contextUsage} defaultModel={defaultModel} className="home-model" />
                  </span>
                  {/* 直近のやりとりのポップオーバー。タイトルの右隣に置く。行ホバーで重なる
                      .home-row-actions（left: 65px から）より前面に出す（z-index は CSS 側） */}
                  <span className="home-row-peek">
                    {s.projectDir && (
                      <RecentPeek
                        data={recentExchanges?.[s.sessionId]}
                        onRequest={() =>
                          onRequestRecentExchanges?.({
                            sessionId: s.sessionId,
                            projectDir: s.projectDir,
                            updatedAt: s.updatedAt,
                          })
                        }
                      />
                    )}
                  </span>
                  <span className="home-row-snippet" title={snippet}>
                    {snippet}
                  </span>
                  {away ? (
                    <span className="home-row-snippet assistant away" title={`現状: ${away}`}>
                      <span className="home-row-away-label">現状</span>
                      {away}
                    </span>
                  ) : (
                    <span className="home-row-snippet assistant" title={s.lastAssistantMessage}>
                      {s.lastAssistantMessage}
                    </span>
                  )}
                  {/* タイトル列に混ぜると .home-row-actions（ホバーで left: 65px から重なる）に
                      隠れて押せなくなるので、右端寄りの独立した列に置く */}
                  <span className="home-row-artifacts">
                    <HomeArtifactChips artifacts={s.artifacts} compact />
                  </span>
                  <span className="home-row-completion">
                    <CompletionBadge session={s} />
                  </span>
                  <ContextCell usage={s.contextUsage} />
                  <span className="home-row-time" title={`${Math.round((s.size || 0) / 1024)} KB · ${s.sessionId}`}>
                    {openLabel(s.openTab) || formatElapsed(s.updatedAt)}
                  </span>

                  <div className="home-row-actions" onClick={(e) => e.stopPropagation()}>
                    {s.openTab ? (
                      <button className="home-action" onClick={() => onSelectTab(s.openTab.id)}>
                        タブへ移動
                      </button>
                    ) : (
                      <button className="home-action" onClick={() => openReadonly(s)}>
                        閲覧
                      </button>
                    )}
                    <button
                      className="home-action primary"
                      onClick={() => resumeInTmux(s)}
                      title="tmux に新しい window を作って claude --resume で起こす。ブリッジを落としても生き残り、ターミナルからも操作できる"
                    >
                      tmux で再開
                    </button>
                    <button
                      className="home-action"
                      onClick={() => openDetail(s)}
                      title="指示ごとのトークン・コミット・PR"
                    >
                      詳細
                    </button>
                    <button
                      className="home-action"
                      onClick={() => resume(s)}
                      title="ブリッジ内で claude を起動（サーバーを落とすと終了・ブラウザからのみ操作）"
                    >
                      内蔵
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <HiddenNote count={hiddenRecent.length} />
      </div>

      {(otherTabs.length > 0 || hiddenOtherTabs.length > 0) && (
        <div className="home-section">
          <h3 className="home-subtitle">その他の開いているタブ（一覧に紐づかないもの）</h3>
          <div className="home-tab-list">
            {otherTabs.map((s) => (
              // ボタンの入れ子を避けるため、センシティブ指定のトグルはタブ本体の隣に並べる
              <div key={s.id} className="home-tab-row">
                <button
                  className={`home-tab-item ${s.id === activeSessionId ? 'active' : ''} ${s.alive ? '' : 'dead'}`}
                  onClick={() => s.alive && onSelectTab(s.id)}
                  disabled={!s.alive}
                >
                  <span className="home-tab-name">{s.name}</span>
                  <span className="home-tab-cwd" title={s.cwd}>
                    {(s.cwd || '').split('/').pop()}
                  </span>
                  {s.type && s.type !== 'pty' && <span className="home-badge kind">{s.type}</span>}
                  {!s.alive && <span className="home-badge closed-badge">終了</span>}
                </button>
                {/* 印は claudeSessionId に付けるので、未解決のタブには出さない */}
                {s.claudeSessionId && (
                  <SensitiveButton
                    on={isSensitive(sensitive, s.claudeSessionId)}
                    onToggle={() => onToggleSensitive(s.claudeSessionId)}
                  />
                )}
              </div>
            ))}
          </div>
          <HiddenNote count={hiddenOtherTabs.length} />
        </div>
      )}
      {detailTarget && (
        <SessionDetailDrawer
          target={detailTarget}
          data={sessionTurns}
          onRequest={onRequestSessionTurns}
          onOpen={openSession}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
