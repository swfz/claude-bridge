// セッションの「今のコンテキスト使用量」の表示用ユーティリティ（純粋関数）。
// データ源はサーバー（server/jsonl-utils.js の extractContextUsage）が
// 直近の assistant レコードの usage から作った contextUsage。

// メッセージ列の末尾から contextUsage を持つものを探す。
// 末尾が human（＝送信直後）でも直前の応答の値が残るので、これが「今の文脈量」になる。
export function latestContextUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.contextUsage;
    if (usage) return usage;
  }
  return null;
}

// コンテキスト窓に対する使用率（0〜100 の整数）
export function contextPercent(usage) {
  if (!usage || !usage.contextWindow) return 0;
  const pct = (usage.contextTokens / usage.contextWindow) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

// トークン数の短縮表記（1000 未満はそのまま / 123.4k / 1.0M）
export function formatTokens(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

// バー色。しきい値は RateLimitMeter と揃える（50%未満=success, 80%以上=accent）
export function contextColorFor(pct) {
  if (pct >= 80) return 'var(--accent)';
  if (pct >= 50) return 'var(--warning)';
  return 'var(--success)';
}

// 使用率（コンテキスト・レート制限）のしきい値。サイドバー・ホーム・トップバーで共通にし、
// 「普段と違う」ものだけが目に入るよう早めに色を変える
export const USAGE_WARN = 40;
export const USAGE_DANGER = 60;
// 旧名（サイドバーで使い始めた名前）。中身は共通のしきい値
export const SIDEBAR_USAGE_WARN = USAGE_WARN;
export const SIDEBAR_USAGE_DANGER = USAGE_DANGER;

export function usageColor(pct) {
  if (pct >= USAGE_DANGER) return 'var(--danger)';
  if (pct >= USAGE_WARN) return 'var(--warning)';
  return 'var(--success)';
}

export const sidebarUsageColor = usageColor;

// 数値や注意色を出すか（しきい値未満はバーだけで足りる）
export function isUsageNotable(pct) {
  return Number.isFinite(pct) && pct >= USAGE_WARN;
}
