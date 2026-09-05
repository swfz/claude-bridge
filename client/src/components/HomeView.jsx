import { useState } from 'react';
import {
  annotateRunningSessions,
  annotateRecentSessions,
  findUnmatchedTabs,
  statusClass,
  formatElapsed,
} from '../utils/runningSessions.js';
import { isStarred, sortStarredFirst } from '../utils/starredSessions.js';
import { isSensitive, splitSensitive } from '../utils/sensitiveSessions.js';
import { parseCwd } from '../utils/cwdLabel.js';
import { filterBySearch, collectProjects, filterByProject } from '../utils/sessionSearch.js';
import ActivityPanel from './ActivityPanel.jsx';
import HomeArtifactChips from './HomeArtifactChips.jsx';
import { contextColorFor, contextPercent, formatTokens } from '../utils/contextUsage.js';
import './HomeView.css';

// 「その他の開いているタブ」は name/cwd しか持たないので検索対象をこの2つに絞る
const OTHER_TAB_SEARCH_FIELDS = ['name', 'cwd'];

// 「直近のセッション」の期間プリセット
const DAY_PRESETS = [1, 3, 7, 30];

// 既定ブランチは「どのセッションにも付く」＝識別に効かないので出さない
const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD']);

// カード上段のパス行。フルパスは共通プレフィックスばかりで情報量が無いので
// parseCwd で「親/プロジェクト（+ worktree）」まで削り、全体は title に逃がす。
function PathLine({ cwd, branch }) {
  const { parent, project, worktree } = parseCwd(cwd);
  if (!project) return null;
  const shownBranch = branch && !DEFAULT_BRANCHES.has(branch) ? branch : null;
  return (
    <div className="home-card-path" title={[cwd, branch].filter(Boolean).join(' · ')}>
      {parent && <span className="home-path-parent">{parent}/</span>}
      <span className="home-path-project">{project}</span>
      {worktree && <span className="home-path-worktree">⎇ {worktree}</span>}
      {shownBranch && <span className="home-path-branch">{shownBranch}</span>}
    </div>
  );
}

// 「未解決／続きをやる」の印。カードのクリック（＝開く）とは分けたいので伝播を止める。
function StarButton({ on, onToggle }) {
  return (
    <button
      className={`home-star ${on ? 'on' : ''}`}
      title={on ? 'Star を外す' : '未解決（続きをやる）として Star を付ける'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

// 画面共有で見せたくないセッションの印。Star と同じくカードのクリックとは分ける。
function SensitiveButton({ on, onToggle }) {
  return (
    <button
      className={`home-sensitive ${on ? 'on' : ''}`}
      title={on ? 'センシティブ指定を外す' : 'センシティブ指定（共有モードで隠す）'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? '🔒' : '🔓'}
    </button>
  );
}

// 共有モードで隠した件数の注記（何件か分かれば十分なので中身は出さない）
function HiddenNote({ count }) {
  if (!count) return null;
  return <div className="home-hidden-note">🔒 {count} 件を非表示中（共有モード）</div>;
}

// カード内の会話抜粋（直近のやりとり）。1 行に clamp して全カードの高さを揃える。
function Snippet({ label, text, role }) {
  if (!text) return null;
  return (
    <div className={`home-snippet ${role || ''}`} title={text}>
      <span className="home-snippet-label">{label}</span>
      <span className="home-snippet-text">{text}</span>
    </div>
  );
}

// メタ行の区切り（"·"）。空の項目は落として区切りが余らないようにする。
function Meta({ items, title }) {
  const parts = items.filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="home-card-meta" title={title}>
      {parts.map((part, i) => (
        <span key={i} className="home-meta-item">
          {part}
        </span>
      ))}
    </div>
  );
}

// コンテキスト使用量のツールチップ（内訳）。カード・行で共用する。
function contextTitle(usage) {
  return `コンテキスト ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)}\ninput ${formatTokens(usage.inputTokens)} · cache 作成 ${formatTokens(usage.cacheCreationTokens)} · cache 読み込み ${formatTokens(usage.cacheReadTokens)}`;
}

// 行リストの Ctx 列。使用率だけを色付きで出し、内訳は tooltip に逃がす。
function ContextCell({ usage }) {
  if (!usage) return <span className="home-row-ctx" />;
  const pct = contextPercent(usage);
  return (
    <span className="home-row-ctx" style={{ color: contextColorFor(pct) }} title={contextTitle(usage)}>
      {pct}%
    </span>
  );
}

// ホーム画面。今このマシンで起動している Claude セッションと、
// 直近 N 日に動いていた（終了済みを含む）セッションを一覧する。
export default function HomeView({
  runningSessions,
  recentSessions,
  recentDays,
  onChangeRecentDays,
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
  error,
  onDismissError,
  onRefresh,
  onSelectTab,
  onAttachTmux,
  onOpenReadonly,
  onResume,
  onResumeInTmux,
  onNew,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProject, setSelectedProject] = useState('');

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

  // プロジェクトチップの選択肢（起動中・直近の両方から集める）
  const projects = collectProjects(annotated, recent);

  // プロジェクト絞り込み → テキスト検索の順で AND 適用
  const filteredAnnotated = filterBySearch(filterByProject(annotated, selectedProject), searchQuery);
  const filteredRecent = filterBySearch(filterByProject(recent, selectedProject), searchQuery);
  const otherTabs = filterBySearch(
    filterByProject(otherTabsVisible, selectedProject),
    searchQuery,
    OTHER_TAB_SEARCH_FIELDS,
  );

  const isFiltering = searchQuery.trim().length > 0 || !!selectedProject;
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
    });
  };

  // カード全体のクリックは「一番やりたいこと」に割り当てる:
  // 開いていればそのタブへ移動、tmux ペインがあれば接続、無ければ閲覧で開く。
  const handleCardClick = (r) => {
    if (r.openTab) onSelectTab(r.openTab.id);
    else if (r.paneId) openTmux(r);
    else openReadonly(r);
  };

  // 左の縦帯（レール）は「ブリッジとの関係」だけを表す。
  // プロセスの状態（busy / idle）はタイトル左のドットが持つので、色を二重に使わない。
  const railClass = (r) => {
    if (!r.openTab) return '';
    return r.openTab.id === activeSessionId ? 'rail-active' : 'rail-open';
  };

  // 「タブで表示中」は帯の色で分かるが、色だけだと凡例が要るのでメタ行に短く添える。
  const openLabel = (openTab) => {
    if (!openTab) return null;
    const suffix = openTab.type === 'readonly' ? '・閲覧' : openTab.type === 'tmux' ? '・tmux' : '';
    return <span className="home-open-mark">タブ{suffix}</span>;
  };

  return (
    <div className="home-view">
      {/* 草は一覧のどのセクションにも属さないので、見出しより前・画面の最上段に置く */}
      <ActivityPanel data={heatmap} loading={heatmapLoading} onRefresh={onRefreshHeatmap} />

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

      {projects.length > 1 && (
        <div className="home-projects">
          <button
            className={`home-project-chip ${selectedProject ? '' : 'active'}`}
            onClick={() => setSelectedProject('')}
          >
            すべて
          </button>
          {projects.map((project) => (
            <button
              key={project}
              className={`home-project-chip ${selectedProject === project ? 'active' : ''}`}
              onClick={() => setSelectedProject((prev) => (prev === project ? '' : project))}
            >
              {project}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="home-error">
          <span className="home-error-text">{error}</span>
          <button className="home-error-close" onClick={onDismissError} title="閉じる">
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
            // 見出しに使わなかった側の名前（スラッグ）はメタ行に落として 1 行分を節約する
            const sub = [r.title, r.name].find((t) => t && t !== label);
            return (
              <div
                key={r.sessionId}
                className={`home-card ${railClass(r)} ${starredNow ? 'starred' : ''}`}
                onClick={() => handleCardClick(r)}
              >
                <div className="home-card-top">
                  <PathLine cwd={r.cwd} branch={r.gitBranch} />
                  <StarButton on={starredNow} onToggle={() => onToggleStar(r.sessionId)} />
                  <SensitiveButton
                    on={isSensitive(sensitive, r.sessionId)}
                    onToggle={() => onToggleSensitive(r.sessionId)}
                  />
                </div>

                <div className="home-card-name" title={label}>
                  <span className={`home-status home-status-${statusClass(r.status)}`} title={r.status || 'unknown'} />
                  {label}
                </div>

                <div className="home-card-snippets">
                  <Snippet label="直近" text={r.lastUserMessage || r.firstUserMessage} />
                  <Snippet label="応答" text={r.lastAssistantMessage} role="assistant" />
                </div>

                <div className="home-card-artifacts">
                  <HomeArtifactChips artifacts={r.artifacts} />
                </div>

                <Meta
                  items={[
                    openLabel(r.openTab),
                    r.kind !== 'interactive' && r.kind,
                    r.contextUsage && `ctx ${contextPercent(r.contextUsage)}%`,
                    formatElapsed(r.updatedAt),
                    sub,
                  ]}
                  title={[`pid ${r.pid}`, r.tmuxTarget && `tmux ${r.tmuxTarget}`, r.status].filter(Boolean).join(' · ')}
                />

                <div className="home-card-actions" onClick={(e) => e.stopPropagation()}>
                  {r.openTab ? (
                    <button className="home-action primary" onClick={() => onSelectTab(r.openTab.id)}>
                      タブへ移動
                    </button>
                  ) : (
                    <>
                      {r.paneId && (
                        <button className="home-action primary" onClick={() => openTmux(r)}>
                          tmux で開く
                        </button>
                      )}
                      <button className="home-action" onClick={() => openReadonly(r)}>
                        閲覧で開く
                      </button>
                    </>
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
          <h3 className="home-subtitle">直近のセッション（起動していないもの）</h3>
          <div className="home-header-actions">
            <div className="home-days">
              {DAY_PRESETS.map((d) => (
                <button
                  key={d}
                  className={`home-day ${d === recentDays ? 'active' : ''}`}
                  onClick={() => onChangeRecentDays(d)}
                >
                  {d}日
                </button>
              ))}
            </div>
            <span className="home-count">
              {isFiltering ? `${filteredRecent.length} / ${recent.length} 件` : `${recent.length} 件`}
            </span>
          </div>
        </div>

        {filteredRecent.length === 0 ? (
          <p className="home-empty">
            {recentLoading
              ? '読み込み中...'
              : emptyMessageFor(`直近 ${recentDays} 日に動いていたセッションはありません`)}
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
              <span>直近の指示</span>
              <span>応答</span>
              <span>Artifact</span>
              <span>Ctx</span>
              <span className="home-row-time">更新</span>
            </div>
            {filteredRecent.map((s) => {
              const label = s.openTab?.name || tabName(s);
              const starredNow = isStarred(starred, s.sessionId);
              const snippet = s.lastUserMessage || s.firstUserMessage;
              return (
                <div
                  key={s.sessionId}
                  className={`home-row ${railClass(s)}`}
                  onClick={() => (s.openTab ? onSelectTab(s.openTab.id) : openReadonly(s))}
                >
                  <StarButton on={starredNow} onToggle={() => onToggleStar(s.sessionId)} />
                  <SensitiveButton
                    on={isSensitive(sensitive, s.sessionId)}
                    onToggle={() => onToggleSensitive(s.sessionId)}
                  />
                  <PathLine cwd={s.cwd} branch={s.gitBranch} />
                  <span className="home-row-name" title={label}>
                    {label}
                  </span>
                  <span className="home-row-snippet" title={snippet}>
                    {snippet}
                  </span>
                  <span className="home-row-snippet assistant" title={s.lastAssistantMessage}>
                    {s.lastAssistantMessage}
                  </span>
                  {/* タイトル列に混ぜると .home-row-actions（ホバーで left: 65px から重なる）に
                      隠れて押せなくなるので、右端寄りの独立した列に置く */}
                  <span className="home-row-artifacts">
                    <HomeArtifactChips artifacts={s.artifacts} compact />
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
    </div>
  );
}
