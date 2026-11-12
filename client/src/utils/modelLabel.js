// セッションが使っているモデルの表示用ユーティリティ（純粋関数）。
// データ源は contextUsage.model（server/jsonl-utils.js の extractContextUsage が
// 直近の assistant レコードの message.model から取ったもの）。

const FAMILY_RE = /^(opus|sonnet|haiku|fable|mythos|instant)$/;

// `claude-opus-5-5` → `opus 5.5`、`claude-sonnet-4-5-20250929` → `sonnet 4.5`、
// `claude-3-5-haiku-20241022` → `haiku 3.5`、`claude-opus-4-6[1m]` → `opus 4.6 1M`。
// 形が読めないものはそのまま返し、空・`<synthetic>` は null
export function shortModelName(model) {
  if (typeof model !== 'string') return null;
  let s = model.trim();
  if (!s || s.startsWith('<')) return null;
  const is1m = /\[1m\]/i.test(s);
  s = s.replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '');
  const tokens = s.split('-').filter((t) => !/^\d{8}$/.test(t));
  const family = tokens.find((t) => FAMILY_RE.test(t));
  if (!family) return model.trim();
  const version = tokens.filter((t) => /^\d{1,2}$/.test(t)).join('.');
  return [family, version, is1m ? '1M' : ''].filter(Boolean).join(' ');
}

// tooltip に添える 1 行（モデル不明なら空文字）
export function modelTitleLine(model) {
  return typeof model === 'string' && model && !model.startsWith('<') ? `\nモデル: ${model}` : '';
}
