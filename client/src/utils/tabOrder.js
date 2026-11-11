// サイドバーのタブの並び（D&D で入れ替えたもの）。localStorage だけで持つ。
// キーは claudeSessionId 優先（ブリッジの id はサーバー再起動で変わるため）、無ければブリッジの id。
// claudeSessionId は後から解決されることがあるので、照合は id / claudeSessionId のどちらでも当てる。

export const TAB_ORDER_KEY = 'sidebarTabOrder';

export function tabKeyOf(session) {
  return session?.claudeSessionId || session?.id || null;
}

function indexIn(order, session) {
  let idx = order.indexOf(session.id);
  if (idx < 0 && session.claudeSessionId) idx = order.indexOf(session.claudeSessionId);
  return idx;
}

// 保存済みの並びを当てる。並びに無いタブ（新しく開いたもの）はサーバーの順のまま末尾に回す。
export function applyTabOrder(sessions, order) {
  const list = sessions || [];
  if (!order?.length) return list;
  const known = [];
  const rest = [];
  list.forEach((session) => {
    const idx = indexIn(order, session);
    if (idx < 0) rest.push(session);
    else known.push({ session, idx });
  });
  known.sort((a, b) => a.idx - b.idx);
  return [...known.map((k) => k.session), ...rest];
}

// fromId のタブを targetId の前（after なら後ろ）へ動かし、保存用のキー列を返す。
// 返すのは今あるタブのキーだけ（閉じたタブのキーは溜めない）。
export function moveTab(sessions, fromId, targetId, after = false) {
  const list = [...(sessions || [])];
  const from = list.findIndex((s) => s.id === fromId);
  if (from < 0 || fromId === targetId) return list.map(tabKeyOf);
  const [moved] = list.splice(from, 1);
  const target = list.findIndex((s) => s.id === targetId);
  if (target < 0) {
    list.splice(from, 0, moved);
  } else {
    list.splice(after ? target + 1 : target, 0, moved);
  }
  return list.map(tabKeyOf);
}

export function loadTabOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveTabOrder(order) {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order || []));
  } catch {
    // 保存できなくても並べ替え自体はその場で効く
  }
}
