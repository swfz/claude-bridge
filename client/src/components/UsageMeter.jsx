import { useEffect, useRef, useState } from 'react';
import { buildUsageMeters, formatClock, isRateLimitStale } from '../utils/usageMeter.js';
import './UsageMeter.css';

// stale 判定とリセットまでの残り時間を時間経過で再評価するための tick 間隔（データ自体はサーバー push 任せ）
const TICK_INTERVAL_MS = 60_000;

// トップバー右側の使用量メーター（ctx / 5h / 7d）を 1 つの塊にしたもの。
// 普段はラベルと細いバーだけで、しきい値を超えたものだけ数値を注意色で出す。
// クリックで各メーターの数値とリセット時刻・残り時間のポップオーバーを開く。
export default function UsageMeter({ contextUsage, rateLimits }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!rateLimits) return;
    const timer = setInterval(() => setTick((t) => t + 1), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rateLimits]);

  // 外側クリック・Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const meters = buildUsageMeters({ contextUsage, rateLimits });
  if (meters.length === 0) return null;
  const shown = meters.filter((m) => !m.extra);
  const stale = isRateLimitStale(rateLimits?.fetchedAt);
  const fetchedClock = formatClock(rateLimits?.fetchedAt);

  return (
    <div className="usage-meter" ref={rootRef}>
      <button
        type="button"
        className={`usage-meter-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="使用量の詳細（リセット時刻）"
      >
        {shown.map((m) => (
          <span
            key={m.key}
            className={`usage-meter-item${m.notable ? ' notable' : ''}${m.key !== 'ctx' && stale ? ' stale' : ''}`}
          >
            <span className="usage-meter-label">{m.label}</span>
            <span className="usage-meter-bar">
              <span className="usage-meter-fill" style={{ width: `${m.pct}%`, background: m.color }} />
            </span>
            {m.notable && (
              <span className="usage-meter-value" style={{ color: m.color }}>
                {m.value}%
              </span>
            )}
          </span>
        ))}
      </button>
      {open && (
        <div className="usage-meter-popover" role="dialog" aria-label="使用量の詳細">
          {meters.map((m) => (
            <div key={m.key} className="usage-meter-row">
              <span className="usage-meter-row-label">{m.label}</span>
              <span className="usage-meter-bar wide">
                <span className="usage-meter-fill" style={{ width: `${m.pct}%`, background: m.color }} />
              </span>
              <span className="usage-meter-row-value" style={m.notable ? { color: m.color } : undefined}>
                {m.value}%
              </span>
              <span className="usage-meter-row-detail">
                {m.detail?.text}
                {m.detail?.sub && <span className="usage-meter-row-sub">{m.detail.sub}</span>}
              </span>
            </div>
          ))}
          {fetchedClock && (
            <div className={`usage-meter-foot${stale ? ' stale' : ''}`}>
              レート制限の更新: {fetchedClock}
              {stale && '（停止中: セッション非稼働?）'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
