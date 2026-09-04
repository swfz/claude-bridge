import { useEffect } from 'react';
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import './ShellOutputDrawer.css';

// 実行中の Bash 出力を取り直す間隔（TUI のライブ表示に相当する更新）
const OUTPUT_POLL_INTERVAL = 2000;

// 実行中／終了済みの Bash 出力を右サイドのドロワーで見せる。
// 本文はプレーンテキストなので Markdown 描画はせず <pre> にそのまま流す。
export default function ShellOutputDrawer({
  taskId,
  label,
  status,
  exitCode,
  text,
  truncated,
  onRequestOutput,
  onClose,
}) {
  // 最下部にいる間だけ新着に追従する（上を読んでいる最中に引き戻さない）
  const { scrollRef: bodyRef, onScroll, hasNew, scrollToBottom } = useStickToBottom(text, taskId);

  // 開いた直後は即取得し、実行中の間だけポーリングで追いかける
  useEffect(() => {
    if (!taskId) return;
    onRequestOutput(taskId);
    if (status !== 'running') return;
    const timer = setInterval(() => onRequestOutput(taskId), OUTPUT_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [taskId, status, onRequestOutput]);

  const running = status === 'running';
  // 前景の Bash は終了で出力ファイルが消えるので、終了コードは分からない（最後に読めた本文だけ残る）
  const gone = status === 'gone';

  return (
    <div className="shell-drawer-overlay" onClick={onClose}>
      <div className="shell-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="shell-drawer-header">
          <div className="shell-drawer-title-area">
            <span className="shell-drawer-title">{label || taskId}</span>
            <div className="shell-drawer-meta">
              <span className="shell-badge">{taskId}</span>
              <span className={`shell-badge shell-badge-status ${running ? 'running' : 'done'}`}>
                {running ? '実行中' : gone ? '終了（出力ファイルは削除済み）' : `終了 (code ${exitCode ?? '?'})`}
              </span>
              {truncated && <span className="shell-badge shell-badge-truncated">先頭を省略</span>}
            </div>
          </div>
          <button className="shell-drawer-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="shell-drawer-body" ref={bodyRef} onScroll={onScroll}>
          {text ? (
            <pre className="shell-output-text">{text}</pre>
          ) : (
            <div className="shell-drawer-empty">
              {running ? '出力を待っています...' : gone ? '終了して出力ファイルが消えました' : '出力がありません'}
            </div>
          )}

          {hasNew && (
            <button className="scroll-to-latest" onClick={scrollToBottom}>
              ↓ 新しい出力
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
