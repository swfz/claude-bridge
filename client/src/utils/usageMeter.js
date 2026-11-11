// トップバーの使用量メーター（ctx / 5h / 7d）の整形。純粋関数だけを置き、描画は UsageMeter.jsx。
// 普段はラベルと細いバーだけ、しきい値（contextUsage.js の USAGE_WARN / USAGE_DANGER）を超えたものだけ
// 数値と注意色を出す。リセット時刻・残り時間はクリックで開くポップオーバーに回す。
import { contextPercent, formatTokens, isUsageNotable, usageColor } from './contextUsage.js';

// この時間より fetchedAt が古ければ「statusline 連携が止まっている（セッション非稼働?）」として薄く出す
export const RATE_LIMIT_STALE_MS = 10 * 60 * 1000;

// resetsAt までの残り時間を "2h13m" / "3d1h28m" 形式で返す。過去なら "now"
export function formatRemaining(iso, now = new Date()) {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return 'now';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

// 時刻を "14:30" 形式で返す
export function formatClock(iso) {
  if (iso === null || iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// リセット時刻の表記。今日なら "14:30"、それ以外は "11/14 14:30"
export function formatResetAt(iso, now = new Date()) {
  const clock = formatClock(iso);
  if (!clock) return null;
  const d = new Date(iso);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

export function isRateLimitStale(fetchedAt, now = Date.now()) {
  return Boolean(fetchedAt) && now - fetchedAt > RATE_LIMIT_STALE_MS;
}

function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function meter(key, label, pct, detail) {
  const rounded = Math.round(pct);
  return { key, label, pct, value: rounded, notable: isUsageNotable(rounded), color: usageColor(rounded), detail };
}

function windowMeter(key, label, window, now) {
  const pct = clampPct(window?.utilization);
  if (pct === null) return null;
  const resetAt = formatResetAt(window.resetsAt, now);
  const remaining = formatRemaining(window.resetsAt, now);
  return meter(key, label, pct, {
    resetAt,
    remaining,
    text: resetAt ? `リセット ${resetAt}${remaining ? `（残り ${remaining}）` : ''}` : 'リセット時刻不明',
  });
}

// メーターの並び（ctx → 5h → 7d → モデル別などの追加分）。データの無いものは落とす。
// contextUsage は今見ているセッションの分（ホーム表示中は null）、rateLimits はサーバーの rate_limits
export function buildUsageMeters({ contextUsage, rateLimits, now = new Date() } = {}) {
  const meters = [];
  if (contextUsage) {
    const pct = contextPercent(contextUsage);
    meters.push(
      meter('ctx', 'ctx', pct, {
        text: `${formatTokens(contextUsage.contextTokens)} / ${formatTokens(contextUsage.contextWindow)} トークン`,
        sub: `input ${formatTokens(contextUsage.inputTokens)} · cache 作成 ${formatTokens(contextUsage.cacheCreationTokens)} · cache 読み込み ${formatTokens(contextUsage.cacheReadTokens)}${contextUsage.model ? ` · ${contextUsage.model}` : ''}`,
      }),
    );
  }
  const usage = rateLimits?.usage;
  if (usage) {
    meters.push(windowMeter('5h', '5h', usage.fiveHour, now));
    meters.push(windowMeter('7d', '7d', usage.sevenDay, now));
    for (const extra of usage.extras || []) {
      // 追加分（モデル別 weekly など）はポップオーバーにだけ出す
      const m = windowMeter(`extra:${extra.label}`, extra.label, extra, now);
      if (m) meters.push({ ...m, extra: true });
    }
  }
  return meters.filter(Boolean);
}
