// 差分ドロワーの「確認済み」（ファイル単位）。localStorage に置く。
//
// キーは sessionKey ＋ patch のハッシュ ＋ パス。中身が変わればハッシュが変わり、確認済みは自然に外れる。
// patch を持たないファイル（バイナリ・大きすぎて省略・名前やモードの変更のみ）は中身の変化を見分けられないので、
// 確認済みを付けられない（canMarkReviewed）。

export const REVIEWED_STORAGE_KEY = 'diffReviewed';
// 覚えておく件数の上限（古いものから捨てる）
export const REVIEWED_MAX = 1000;

// FNV-1a（32bit）。衝突しても「確認済みが外れない」だけなので暗号的な強さは要らない
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function canMarkReviewed(file) {
  return !!file && typeof file.patch === 'string' && /^@@ /m.test(file.patch);
}

// パスは | を含み得るので最後に置く
export function reviewedKey(sessionKey, file) {
  return `${sessionKey}|${hashText(`${file.status || ''}\u0000${file.oldPath || ''}\u0000${file.patch || ''}`)}|${file.path}`;
}

export function parseReviewed(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

// 付け外し。付けたものは末尾へ（上限を超えたら先頭＝古いものから捨てる）
export function toggleReviewed(list, key, on) {
  const rest = list.filter((k) => k !== key);
  if (!on) return rest;
  const next = [...rest, key];
  return next.length > REVIEWED_MAX ? next.slice(next.length - REVIEWED_MAX) : next;
}

// sessionKey がブリッジ ID から claudeSessionId に変わったとき（tmux タブ）に付け替える。変わらなければ同じ配列
export function migrateReviewed(list, from, to) {
  if (!from || !to || from === to) return list;
  const prefix = `${from}|`;
  if (!list.some((k) => k.startsWith(prefix))) return list;
  const moved = list.map((k) => (k.startsWith(prefix) ? `${to}|${k.slice(prefix.length)}` : k));
  return [...new Set(moved)];
}

export function loadReviewed(storage = globalThis.localStorage) {
  try {
    return parseReviewed(storage?.getItem(REVIEWED_STORAGE_KEY));
  } catch {
    return [];
  }
}

// 書き込みの購読。差分ドロワーはメインと小窓の 2 つが同時に開き得るので、片方（や App の付け替え）が書いたら
// もう片方が読み直せるようにする。戻り値は購読の解除
const listeners = new Set();
export function subscribeReviewed(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveReviewed(list, storage = globalThis.localStorage) {
  try {
    storage?.setItem(REVIEWED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 保存できなくても画面上の確認済みは効かせる
  }
  for (const listener of [...listeners]) listener(list);
}
