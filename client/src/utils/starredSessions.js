// ホーム画面の Star（「未解決／続きをやる」の印）。
// サーバーには持たせず localStorage だけで管理する（claudeSessionId のリスト）。

export const STARRED_KEY = 'homeStarredSessions';

// localStorage に入れるので Set ではなく配列で持つ（件数は多くならない想定）。
export function isStarred(starred, sessionId) {
  return !!sessionId && (starred || []).includes(sessionId);
}

// Star の付け外し。新しく付けたものを先頭に積む。
export function toggleStarred(starred, sessionId) {
  const list = starred || [];
  if (!sessionId) return list;
  return list.includes(sessionId) ? list.filter((id) => id !== sessionId) : [sessionId, ...list];
}

// Star 付きを先頭に寄せる（Star 内・非 Star 内の相対順序は保つ）。
export function sortStarredFirst(items, starred, keyOf = (item) => item.sessionId) {
  const starredItems = [];
  const rest = [];
  for (const item of items || []) {
    (isStarred(starred, keyOf(item)) ? starredItems : rest).push(item);
  }
  return [...starredItems, ...rest];
}

export function loadStarred() {
  try {
    const raw = JSON.parse(localStorage.getItem(STARRED_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  } catch {
    // 壊れた値は捨てる（Star は失っても復帰できる情報）
    return [];
  }
}

export function saveStarred(list) {
  localStorage.setItem(STARRED_KEY, JSON.stringify(list || []));
}
