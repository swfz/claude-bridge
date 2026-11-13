import { useState, useEffect, useMemo, useRef } from 'react';
import { TbFolder } from 'react-icons/tb';
import { displayDir, expandHome, filterDirSuggestions, defaultSessionName } from '../utils/recentDirs.js';
import './NewSessionDialog.css';

const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.[\]-]{0,63}$/;
const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]'];
const LAUNCH_KEY = 'newSessionLaunch';

function loadLaunch() {
  try {
    return localStorage.getItem(LAUNCH_KEY) === 'pty' ? 'pty' : 'tmux';
  } catch {
    return 'tmux';
  }
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${Math.max(min, 0)}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

// 作業ディレクトリの入力欄＋候補（直近 90 日のセッションの cwd）。
// focus で候補を開き、↑↓ で選んで Enter / Tab で確定、Esc で畳む。
function DirCombobox({ value, onChange, recentDirs, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef(null);
  const home = recentDirs?.home || '';
  const suggestions = useMemo(() => filterDirSuggestions(recentDirs?.dirs, value, { home }), [recentDirs, value, home]);
  const showList = open && suggestions.length > 0;

  useEffect(() => {
    if (highlight < 0 || !listRef.current) return;
    listRef.current.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const choose = (d) => {
    onChange(displayDir(d.cwd, home));
    setOpen(false);
    setHighlight(-1);
  };

  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) {
        setOpen(true);
        return;
      }
      const n = suggestions.length;
      setHighlight((h) => (e.key === 'ArrowDown' ? (h + 1) % n : h <= 0 ? n - 1 : h - 1));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && showList && highlight >= 0) {
      e.preventDefault();
      choose(suggestions[highlight]);
    } else if (e.key === 'Escape' && showList) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="dir-combobox">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        autoFocus={autoFocus}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder={recentDirs ? '$HOME（デフォルト）· 入力で候補を絞り込み' : '$HOME（デフォルト）'}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {showList && (
        <ul className="dir-suggest" role="listbox" ref={listRef}>
          {suggestions.map((d, i) => {
            const shown = displayDir(d.cwd, home);
            const cut = shown.lastIndexOf('/');
            return (
              <li
                key={d.cwd}
                role="option"
                aria-selected={i === highlight}
                className={`dir-suggest-item ${i === highlight ? 'active' : ''}`}
                // blur より先に選ぶ
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(d);
                }}
                onMouseEnter={() => setHighlight(i)}
                title={d.cwd}
              >
                <TbFolder className="dir-suggest-icon" aria-hidden />
                <span className="dir-suggest-path">
                  {cut > 0 && <span className="cwd-parent">{shown.slice(0, cut + 1)}</span>}
                  <span className="cwd-base">{cut > 0 ? shown.slice(cut + 1) : shown}</span>
                </span>
                <span className="dir-suggest-meta">
                  {d.count}件 · {relativeTime(d.lastUsedAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function NewSessionDialog({
  onClose,
  onCreate,
  onResume,
  onAttachTmux,
  onOpenReadonly,
  onRequestClaudeSessions,
  onRequestTmuxPanes,
  claudeSessions,
  tmuxPanes,
  recentDirs,
  onRequestRecentDirs,
  error,
  initialValues,
}) {
  const [tab, setTab] = useState('new'); // "new" | "resume" | "tmux"
  const [name, setName] = useState(initialValues?.name || '');
  const [cwd, setCwd] = useState(initialValues?.cwd || '');
  const [filter, setFilter] = useState('');
  const [worktree, setWorktree] = useState(!!initialValues?.worktree);
  const [worktreeName, setWorktreeName] = useState(initialValues?.worktreeName || '');
  const [launch, setLaunch] = useState(initialValues?.launch || loadLaunch);
  const [model, setModel] = useState(initialValues?.model || '');
  const [prompt, setPrompt] = useState(initialValues?.prompt || '');

  useEffect(() => {
    onRequestRecentDirs?.();
  }, [onRequestRecentDirs]);

  const worktreeNameInvalid = worktree && worktreeName.trim() !== '' && !WORKTREE_NAME_RE.test(worktreeName.trim());
  const modelInvalid = model.trim() !== '' && !MODEL_RE.test(model.trim());
  const invalid = worktreeNameInvalid || modelInvalid;

  const chooseLaunch = (value) => {
    setLaunch(value);
    try {
      localStorage.setItem(LAUNCH_KEY, value);
    } catch {
      // 保存できなくても今回の選択は効く
    }
  };

  useEffect(() => {
    if (tab === 'resume' && onRequestClaudeSessions) {
      onRequestClaudeSessions();
    }
    if (tab === 'tmux' && onRequestTmuxPanes) {
      onRequestTmuxPanes();
    }
  }, [tab, onRequestClaudeSessions, onRequestTmuxPanes]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (invalid) return;
    const home = recentDirs?.home || '';
    const dir = expandHome(cwd.trim(), home);
    onCreate({
      name: name.trim() || defaultSessionName(cwd),
      cwd: dir || undefined,
      launch,
      worktree,
      worktreeName: worktree ? worktreeName.trim() || undefined : undefined,
      model: model.trim() || undefined,
      prompt: prompt.trim() || undefined,
    });
  };

  const filteredSessions = (claudeSessions || []).filter((s) => {
    if (!filter) return true;
    const lower = filter.toLowerCase();
    return (
      s.cwd.toLowerCase().includes(lower) ||
      s.firstUserMessage.toLowerCase().includes(lower) ||
      s.sessionId.includes(lower)
    );
  });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-tabs">
          <button className={`dialog-tab ${tab === 'new' ? 'active' : ''}`} onClick={() => setTab('new')}>
            新規作成
          </button>
          <button className={`dialog-tab ${tab === 'resume' ? 'active' : ''}`} onClick={() => setTab('resume')}>
            既存セッションを再開
          </button>
          <button className={`dialog-tab ${tab === 'tmux' ? 'active' : ''}`} onClick={() => setTab('tmux')}>
            tmux ペイン
          </button>
        </div>

        {tab === 'tmux' ? (
          <div className="resume-panel">
            <div className="session-list">
              {!tmuxPanes ? (
                <p className="session-list-empty">読み込み中...</p>
              ) : tmuxPanes.length === 0 ? (
                <p className="session-list-empty">Claude を実行中の tmux ペインが見つかりません</p>
              ) : (
                tmuxPanes.map((p) => {
                  const label = p.sessionName || p.slug || `tmux: ${p.target}`;
                  const cwdParts = p.cwd.split('/');
                  const cwdBase = cwdParts.pop();
                  const cwdParent = cwdParts.join('/');
                  return (
                    <div
                      key={p.paneId}
                      className="session-list-item"
                      onClick={() =>
                        onAttachTmux({
                          paneId: p.paneId,
                          name: label,
                          cwd: p.cwd,
                          target: p.target,
                          claudePid: p.claudePid,
                          claudeSessionId: p.claudeSessionId,
                          status: p.status,
                        })
                      }
                    >
                      <div className="session-item-main">
                        <span className="session-item-name">
                          {p.status && <span className={`pane-status pane-status-${p.status}`} title={p.status} />}
                          {label}
                          {!p.sessionName && <span className="pane-unrenamed">未rename</span>}
                        </span>
                        <span className="session-item-time">{p.target}</span>
                      </div>
                      <div className="session-item-meta">
                        <span className="cwd-path" title={p.cwd}>
                          {cwdParent && <span className="cwd-parent">{cwdParent}/</span>}
                          <span className="cwd-base">{cwdBase}</span>
                        </span>
                        <span className="meta-pane">pane: {p.paneId}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                キャンセル
              </button>
            </div>
          </div>
        ) : tab === 'new' ? (
          <form onSubmit={handleSubmit}>
            <div className="dialog-field">
              <label>作業ディレクトリ</label>
              <DirCombobox value={cwd} onChange={setCwd} recentDirs={recentDirs} autoFocus />
            </div>
            <div className="dialog-field">
              <label>セッション名</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="省略時は作業ディレクトリ名"
              />
            </div>
            <div className="dialog-field dialog-option">
              <label className="dialog-check">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                <code>-w</code> git worktree を作って起動
              </label>
              {worktree && (
                <input
                  type="text"
                  className={worktreeNameInvalid ? 'invalid' : ''}
                  value={worktreeName}
                  onChange={(e) => setWorktreeName(e.target.value)}
                  placeholder="worktree 名（省略で自動）"
                  title="英数字と . _ - だけ（64 文字まで）"
                  spellCheck={false}
                />
              )}
            </div>
            <div className="dialog-field">
              <label htmlFor="new-session-model">モデル</label>
              <input
                id="new-session-model"
                type="text"
                list="new-session-models"
                className={modelInvalid ? 'invalid' : ''}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="既定（設定のモデル）"
                spellCheck={false}
              />
              <datalist id="new-session-models">
                {MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="dialog-field">
              <label htmlFor="new-session-prompt">最初の指示</label>
              <textarea
                id="new-session-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // 本文の Enter は改行。Ctrl/Cmd+Enter で作成
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="省略可。起動と同時に送る（Ctrl+Enter で作成）"
              />
            </div>
            <div className="dialog-field">
              <label>起動先</label>
              <div className="dialog-segmented" role="radiogroup" aria-label="起動先">
                {[
                  ['tmux', 'tmux', 'tmux の新しい window で起動。ブリッジを落としても残り、ターミナルからも触れる'],
                  ['pty', '内蔵', 'ブリッジの子プロセスとして起動。ブリッジを落とすと終了する'],
                ].map(([value, label, help]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={launch === value}
                    className={`dialog-segment ${launch === value ? 'active' : ''}`}
                    onClick={() => chooseLaunch(value)}
                    title={help}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {error && <p className="dialog-error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                キャンセル
              </button>
              <button type="submit" className="btn btn-primary" disabled={invalid}>
                作成
              </button>
            </div>
          </form>
        ) : (
          <div className="resume-panel">
            <div className="dialog-field">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="セッションを検索（パス、メッセージ、ID）..."
                autoFocus
              />
            </div>
            <div className="session-list">
              {filteredSessions.length === 0 ? (
                <p className="session-list-empty">
                  {claudeSessions === null ? '読み込み中...' : 'セッションが見つかりません'}
                </p>
              ) : (
                filteredSessions.map((s) => {
                  const name = s.firstUserMessage ? s.firstUserMessage.slice(0, 40) : s.sessionId.slice(0, 8);
                  const payload = {
                    claudeSessionId: s.sessionId,
                    name,
                    cwd: s.cwd,
                    projectDir: s.projectDir,
                  };
                  return (
                    <div key={s.sessionId} className="session-list-item session-list-item-static">
                      <div className="session-item-main">
                        <span className="session-item-cwd">{s.cwd}</span>
                        <span className="session-item-time">{new Date(s.updatedAt).toLocaleString('ja-JP')}</span>
                      </div>
                      <div className="session-item-message">{s.firstUserMessage || '(メッセージなし)'}</div>
                      <div className="session-item-id">{s.sessionId}</div>
                      <div className="session-item-actions">
                        <button
                          className="session-resume-btn"
                          onClick={() => onResume(payload)}
                          data-tooltip="claude を起動して再開。直接やりとりできる（プロセス起動）"
                        >
                          再開
                        </button>
                        <button
                          className="session-readonly-btn"
                          onClick={() => onOpenReadonly(payload)}
                          data-tooltip="起動せず閲覧。コメント＆送信は inbox 経由（相手が生きていれば届く）"
                        >
                          閲覧（コメント）
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
