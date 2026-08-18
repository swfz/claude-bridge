import { useEffect, useState } from "react";
import "./RateLimitMeter.css";

// この時間より fetchedAt が古ければ「停止中かも」として stale 表示にする
const STALE_MS = 10 * 60 * 1000;
// stale 判定を更新するための tick 間隔（データ自体はサーバー側 push 任せ）
const TICK_INTERVAL_MS = 60_000;

// 使用率に応じたバー色（テーマ変数に合わせる。50%未満=success, 80%以上=accent）
function colorFor(utilization) {
  if (utilization >= 80) return "var(--accent)";
  if (utilization >= 50) return "var(--warning)";
  return "var(--success)";
}

// resetsAt までの残り時間を "2h13m" / "3d1h28m" 形式で返す。過去なら "now"
export function formatRemaining(iso, now = new Date()) {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

function windowLine(label, window, now) {
  if (!window || window.utilization === null) return null;
  const remaining = formatRemaining(window.resetsAt, now);
  const resetText = window.resetsAt
    ? `${new Date(window.resetsAt).toLocaleString()}${remaining ? `（残り${remaining}）` : ""}`
    : "リセット時刻不明";
  // 元データに浮動小数点ノイズ（28.000000000000004 等）が乗ることがあるので丸める
  return `${label}: ${Number(window.utilization.toFixed(1))}% ・ ${resetText}`;
}

function buildTooltip(usage, fetchedAt, isStale) {
  const now = new Date();
  const lines = [
    windowLine("5h", usage.fiveHour, now),
    windowLine("7d", usage.sevenDay, now),
    ...(usage.extras || []).map((extra) => windowLine(extra.label, extra, now)),
  ].filter(Boolean);
  if (fetchedAt) {
    const updated = new Date(fetchedAt);
    const hhmm = `${String(updated.getHours()).padStart(2, "0")}:${String(
      updated.getMinutes()
    ).padStart(2, "0")}`;
    lines.push(isStale ? `更新: ${hhmm}（停止中: セッション非稼働?）` : `更新: ${hhmm}`);
  }
  return lines.join("\n");
}

function Meter({ label, window }) {
  if (!window || window.utilization === null) return null;
  const pct = Math.min(100, Math.max(0, window.utilization));
  return (
    <div className="rate-limit-meter">
      <span className="rate-limit-label">{label}</span>
      <span className="rate-limit-bar">
        <span
          className="rate-limit-bar-fill"
          style={{ width: `${pct}%`, background: colorFor(pct) }}
        />
      </span>
      <span className="rate-limit-value">{Math.round(window.utilization)}%</span>
    </div>
  );
}

export default function RateLimitMeter({ rateLimits }) {
  // stale 判定（fetchedAt が古いか）を時間経過で再評価するための tick。
  // データ自体はサーバーからの push 任せで、ここでは再描画のトリガーだけを持つ。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!rateLimits) return;
    const timer = setInterval(() => setTick((t) => t + 1), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rateLimits]);

  if (!rateLimits?.usage) return null;
  const { usage, fetchedAt } = rateLimits;
  const isStale = !!fetchedAt && Date.now() - fetchedAt > STALE_MS;

  return (
    <div
      className={`rate-limit-group${isStale ? " stale" : ""}`}
      title={buildTooltip(usage, fetchedAt, isStale)}
    >
      <Meter label="5h" window={usage.fiveHour} />
      <Meter label="7d" window={usage.sevenDay} />
    </div>
  );
}
