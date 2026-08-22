// センシティブ指定（画面共有中に見せたくないセッションの印）と共有モードの ON/OFF。
// Star と同じくサーバーには持たせず localStorage だけで管理する（claudeSessionId のリスト）。

export const SENSITIVE_KEY = 'homeSensitiveSessions';
export const SHARE_MODE_KEY = 'bridgeShareMode';

// localStorage に入れるので Set ではなく配列で持つ（件数は多くならない想定）。
export function isSensitive(sensitive, sessionId) {
  return !!sessionId && (sensitive || []).includes(sessionId);
}

// センシティブ指定の付け外し。新しく付けたものを先頭に積む。
export function toggleSensitive(sensitive, sessionId) {
  const list = sensitive || [];
  if (!sessionId) return list;
  return list.includes(sessionId) ? list.filter((id) => id !== sessionId) : [sessionId, ...list];
}

// 一覧を「出すもの」と「隠すもの」に分ける。共有モードのときだけ使い、
// 以降の集計（プロジェクトチップ・件数・検索）は visible 側だけで行う（隠した情報が漏れないように）。
export function splitSensitive(items, sensitive, keyOf = (item) => item.sessionId) {
  const visible = [];
  const hidden = [];
  for (const item of items || []) {
    (isSensitive(sensitive, keyOf(item)) ? hidden : visible).push(item);
  }
  return { visible, hidden };
}

export function loadSensitive() {
  try {
    const raw = JSON.parse(localStorage.getItem(SENSITIVE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  } catch {
    // 壊れた値は捨てる（付け直せる情報）
    return [];
  }
}

export function saveSensitive(list) {
  localStorage.setItem(SENSITIVE_KEY, JSON.stringify(list || []));
}

export function loadShareMode() {
  try {
    return localStorage.getItem(SHARE_MODE_KEY) === '1';
  } catch {
    // 読めないときは「隠さない」側に倒す（普段の使い方を変えないため）
    return false;
  }
}

export function saveShareMode(on) {
  localStorage.setItem(SHARE_MODE_KEY, on ? '1' : '0');
}
