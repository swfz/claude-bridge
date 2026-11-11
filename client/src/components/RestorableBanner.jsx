import { useState } from 'react';
import { parseCwd } from '../utils/cwdLabel.js';
import { isSensitive } from '../utils/sensitiveSessions.js';
import './RestorableBanner.css';

// 前回（ブリッジ / PC・WSL の再起動前）tmux で動いていたのに、いま動いていないセッションの一覧。
// サーバーの restorable_tabs をそのまま描き、「まとめて tmux で再開」で元の tmux セッション名・window 名に作り直す。
// 勝手に claude を起こさないよう、再開はボタンを押したときだけ。
export default function RestorableBanner({ restorable, sensitive, shareMode, onResume, onDismiss }) {
  const [open, setOpen] = useState(false);
  const all = restorable?.tabs ?? [];
  if (all.length === 0) return null;
  const resuming = Boolean(restorable.resuming);
  // 共有モードではセンシティブ指定のものは名前もパスも出さない（件数にだけ含める）
  const visible = shareMode ? all.filter((t) => !isSensitive(sensitive, t.claudeSessionId)) : all;
  const hiddenCount = all.length - visible.length;

  return (
    <div className="restorable-banner" data-testid="restorable-banner">
      <div className="restorable-head">
        <span className="restorable-text">
          前回 tmux で動いていた <strong>{all.length} 件</strong>のセッションが停止しています
        </span>
        <button type="button" className="restorable-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '一覧を閉じる' : '一覧'}
        </button>
        <button type="button" className="restorable-resume" disabled={resuming} onClick={() => onResume()}>
          {resuming ? '再開中…' : 'まとめて tmux で再開'}
        </button>
        <button
          type="button"
          className="restorable-dismiss"
          disabled={resuming}
          onClick={() => onDismiss()}
          title="再開せずに一覧から消す"
        >
          破棄
        </button>
      </div>
      {open && (
        <ul className="restorable-list">
          {visible.map((t) => (
            <li key={t.claudeSessionId} className="restorable-item">
              <span className="restorable-name">{t.name || t.windowName || t.claudeSessionId.slice(0, 8)}</span>
              {t.wasTab && <span className="restorable-badge">タブ</span>}
              <span className="restorable-meta" title={shareMode ? undefined : t.cwd || undefined}>
                {t.tmuxSession ? `${t.tmuxSession}${t.windowName ? ` / ${t.windowName}` : ''}` : 'tmux（既定の場所）'}
                {t.cwd ? ` · ${parseCwd(t.cwd).project}` : ''}
              </span>
              <button
                type="button"
                className="restorable-item-action"
                disabled={resuming}
                onClick={() => onResume([t.claudeSessionId])}
              >
                再開
              </button>
              <button
                type="button"
                className="restorable-item-action"
                disabled={resuming}
                onClick={() => onDismiss([t.claudeSessionId])}
              >
                破棄
              </button>
            </li>
          ))}
          {hiddenCount > 0 && <li className="restorable-item restorable-hidden">他 {hiddenCount} 件（非表示）</li>}
        </ul>
      )}
    </div>
  );
}
