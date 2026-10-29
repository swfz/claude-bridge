// ピン留め（後から見返すメッセージのしおり）の純粋関数。保存はサーバー（pins-<sessionKey>.json）

export const PIN_EXCERPT_LENGTH = 200;

// 一覧に出す抜粋。改行・連続空白を 1 つに潰して先頭だけ残す
export function pinExcerpt(content, max = PIN_EXCERPT_LENGTH) {
  const text = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function pinnedUuidSet(pins) {
  return new Set((pins || []).map((p) => p.messageUuid).filter(Boolean));
}

// 一覧の並び: 会話の順（メッセージの時刻が古い順）。時刻が無いものはピンした時刻で代用する
export function sortPins(pins) {
  const at = (p) => Date.parse(p.messageTimestamp || p.pinnedAt || '') || 0;
  return [...(pins || [])].sort((a, b) => at(a) - at(b));
}

// 本文がいま読み込まれているメッセージなら、そちらの最新の本文から抜粋を作り直す
// （ピン時の抜粋は保存時点のもの。読み込まれていなければ保存した抜粋のまま）
export function resolvePins(pins, messages) {
  const byUuid = new Map();
  for (const m of messages || []) if (m?.uuid) byUuid.set(m.uuid, m);
  return sortPins(pins).map((p) => {
    const m = byUuid.get(p.messageUuid);
    return { ...p, loaded: !!m, excerpt: m ? pinExcerpt(m.content) || p.excerpt : p.excerpt };
  });
}
