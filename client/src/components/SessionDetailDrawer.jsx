import { useEffect, useMemo } from 'react';
import { contextColorFor, contextPercent, formatTokens } from '../utils/contextUsage.js';
import { formatDuration, formatTurnTime, mainRepository, prLabel, relativeToCwd } from '../utils/sessionTurns.js';
import './SessionDetailDrawer.css';

// ホームの「セッション詳細」。ユーザーの指示 1 件を 1 ターンとして、時刻・トークン・
// 所要時間・コンテキスト量と、そのターンで作ったコミット・PR・編集したファイルを並べる。
// 「この時間に何をしていたか」を開かずに振り返るためのもので、データはパネルを開いたときに取る。
export default function SessionDetailDrawer({ target, data, onRequest, onOpen, onClose }) {
  const sessionId = target?.sessionId;
  const projectDir = target?.projectDir;

  useEffect(() => {
    if (sessionId && projectDir) onRequest({ sessionId, projectDir });
  }, [sessionId, projectDir, onRequest]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = data && data.sessionId === sessionId ? data : null;
  const turns = useMemo(() => current?.turns || [], [current]);
  const repository = useMemo(() => mainRepository(turns), [turns]);
  const totals = current?.totals;

  return (
    <div className="session-detail-overlay" onClick={onClose}>
      <aside className="session-detail" onClick={(e) => e.stopPropagation()}>
        <header className="session-detail-header">
          <div className="session-detail-title-area">
            <span className="session-detail-title">{target.title || sessionId.slice(0, 8)}</span>
            <span className="session-detail-cwd" title={target.cwd}>
              {target.cwd}
            </span>
          </div>
          <button className="home-action primary" onClick={() => onOpen(target)}>
            開く
          </button>
          <button className="session-detail-close" onClick={onClose} title="閉じる（Esc）">
            ×
          </button>
        </header>

        {totals && (
          <div className="session-detail-totals">
            <span>指示 {totals.prompts}</span>
            <span>{formatTokens(totals.tokens)} tok</span>
            {totals.durationMs > 0 && <span>{formatDuration(totals.durationMs)}</span>}
            <span>コミット {totals.commits}</span>
            <span>PR {totals.prs}</span>
            <span>変更 {totals.editedFiles} ファイル</span>
          </div>
        )}

        <div className="session-detail-body">
          {current?.error ? (
            <p className="session-detail-empty">{current.error}</p>
          ) : !current ? (
            <p className="session-detail-empty">読み込み中…</p>
          ) : turns.length === 0 ? (
            <p className="session-detail-empty">指示がありません</p>
          ) : (
            <ol className="session-turns">
              {turns.map((turn, i) => {
                const pct = turn.contextUsage ? contextPercent(turn.contextUsage) : null;
                return (
                  <li key={`${turn.startedAt}-${i}`} className="session-turn">
                    <div className="session-turn-head">
                      <span className="session-turn-index">{i + 1}.</span>
                      <span className="session-turn-time">
                        {formatTurnTime(turn.startedAt, turns[i - 1]?.startedAt)}
                      </span>
                      <span className="session-turn-prompt" title={turn.prompt}>
                        {turn.prompt}
                      </span>
                      <span className="session-turn-stats">
                        {turn.tokens.total > 0 && <span>{formatTokens(turn.tokens.total)} tok</span>}
                        {turn.durationMs > 0 && <span>{formatDuration(turn.durationMs)}</span>}
                        {pct !== null && <span style={{ color: contextColorFor(pct) }}>ctx {pct}%</span>}
                      </span>
                    </div>
                    {(turn.commits.length > 0 || turn.prs.length > 0 || turn.editedFiles.length > 0) && (
                      <ul className="session-turn-outcomes">
                        {turn.commits.map((commit, j) => (
                          <li key={`c${j}`} className="session-turn-commit">
                            <span className="session-turn-hash">{commit.hash || '-------'}</span>
                            {commit.subject}
                          </li>
                        ))}
                        {(turn.prs.length > 0 || turn.editedFiles.length > 0) && (
                          <li className="session-turn-misc">
                            {turn.prs.map((pr) => (
                              <a
                                key={pr.url}
                                href={pr.url}
                                target="_blank"
                                rel="noreferrer"
                                className="session-turn-pr"
                              >
                                PR {prLabel(pr, repository)}
                              </a>
                            ))}
                            {turn.editedFiles.length > 0 && (
                              <span
                                className="session-turn-files"
                                title={turn.editedFiles.map((f) => relativeToCwd(f, target.cwd)).join('\n')}
                              >
                                変更 {turn.editedFiles.length} ファイル
                              </span>
                            )}
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}
