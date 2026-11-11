// サイドバーのタブのグループ分け。localStorage だけで持つ。
// 既定は cwd のプロジェクト（parseCwd の parent/project。worktree は元リポジトリ側）で自動にまとめ、
// タブを別のグループへ D&D すると手動の割り当て（assign）で上書きする。
// グループのキーは自動が `p:<parent>/<project>`、手動で作ったものが `g:<id>`。
// assign のキーはタブの並びと同じ tabKeyOf（claudeSessionId 優先）で、照合は id / claudeSessionId の両方で当てる。
import { parseCwd } from './cwdLabel.js';
import { tabKeyOf } from './tabOrder.js';

export const TAB_GROUPS_KEY = 'sidebarTabGroups';

const EMPTY_STATE = Object.freeze({ groups: [], assign: {}, collapsed: [] });

export function autoGroupKeyOf(session) {
  const { parent, project } = parseCwd(session?.cwd);
  if (!project) return 'p:';
  return `p:${parent ? `${parent}/` : ''}${project}`;
}

// 自動グループのキーから見出しを作る（同名プロジェクトの区別は title に回す）
export function autoGroupLabel(key) {
  const path = key.slice(2);
  if (!path) return 'その他';
  return path.split('/').pop();
}

function assignedKeyOf(session, assign, validKeys) {
  const candidates = [session.id, session.claudeSessionId].filter(Boolean);
  for (const k of candidates) {
    const g = assign?.[k];
    if (g && validKeys(g)) return g;
  }
  return null;
}

export function groupKeyOf(session, state) {
  const manualIds = new Set((state?.groups || []).map((g) => `g:${g.id}`));
  const valid = (g) => g.startsWith('p:') || manualIds.has(g);
  return assignedKeyOf(session, state?.assign, valid) || autoGroupKeyOf(session);
}

// 並び済みのタブ（applyTabOrder の結果）をグループに分ける。
// 手動グループは作った順に先頭へ（空でも出す＝D&D の落とし先になるため）、自動グループは最初のタブの出現順。
// グループ内の並びは渡されたタブの順のまま。
export function buildTabGroups(sessions, state) {
  const st = state || EMPTY_STATE;
  const collapsed = new Set(st.collapsed || []);
  const byKey = new Map();
  for (const g of st.groups || []) {
    const key = `g:${g.id}`;
    byKey.set(key, { key, label: g.name, manual: true, collapsed: collapsed.has(key), sessions: [] });
  }
  const autoOrder = [];
  for (const session of sessions || []) {
    const key = groupKeyOf(session, st);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: autoGroupLabel(key), manual: false, collapsed: collapsed.has(key), sessions: [] };
      byKey.set(key, group);
      autoOrder.push(group);
    }
    group.sessions.push(session);
  }
  const manual = (st.groups || []).map((g) => byKey.get(`g:${g.id}`));
  return [...manual, ...autoOrder];
}

// 表示順（グループ順に並べ直したタブ）。Alt+数字 などのタブ移動をサイドバーの見た目と揃えるため
export function flattenTabGroups(groups) {
  return groups.flatMap((g) => g.sessions);
}

// タブを groupKey のグループへ移す。自動で入るグループと同じなら割り当てを外す
export function assignTabToGroup(state, session, groupKey) {
  const key = tabKeyOf(session);
  if (!key) return state;
  const assign = { ...(state.assign || {}) };
  delete assign[session.id];
  if (session.claudeSessionId) delete assign[session.claudeSessionId];
  if (groupKey && groupKey !== autoGroupKeyOf(session)) assign[key] = groupKey;
  return { ...state, assign };
}

export function createGroup(state, name, id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return state;
  return { ...state, groups: [...(state.groups || []), { id, name: trimmed }] };
}

export function renameGroup(state, id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return state;
  return { ...state, groups: (state.groups || []).map((g) => (g.id === id ? { ...g, name: trimmed } : g)) };
}

// 手動グループを消す。入っていたタブは自動のグループへ戻る
export function deleteGroup(state, id) {
  const key = `g:${id}`;
  const assign = Object.fromEntries(Object.entries(state.assign || {}).filter(([, g]) => g !== key));
  return {
    ...state,
    groups: (state.groups || []).filter((g) => g.id !== id),
    assign,
    collapsed: (state.collapsed || []).filter((k) => k !== key),
  };
}

export function toggleGroupCollapsed(state, groupKey) {
  const list = state.collapsed || [];
  return {
    ...state,
    collapsed: list.includes(groupKey) ? list.filter((k) => k !== groupKey) : [...list, groupKey],
  };
}

export function loadTabGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAB_GROUPS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return EMPTY_STATE;
    const groups = Array.isArray(raw.groups)
      ? raw.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')
      : [];
    const assign =
      raw.assign && typeof raw.assign === 'object'
        ? Object.fromEntries(Object.entries(raw.assign).filter(([, v]) => typeof v === 'string'))
        : {};
    const collapsed = Array.isArray(raw.collapsed) ? raw.collapsed.filter((k) => typeof k === 'string') : [];
    return { groups, assign, collapsed };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveTabGroups(state) {
  try {
    localStorage.setItem(TAB_GROUPS_KEY, JSON.stringify(state || EMPTY_STATE));
  } catch {
    // 保存できなくてもその場では効く
  }
}

// 畳んだグループは表示中のタブだけ残す（どこを見ているか分からなくならないように）。
// サイドバーの表示と Alt+数字 などのタブ移動で同じ規則を使う
export function visibleTabsOf(group, activeId) {
  return group.collapsed ? group.sessions.filter((s) => s.id === activeId) : group.sessions;
}

// セッション行にディレクトリを出すか。既定値（グループの代表ディレクトリと同じ）は出さず、例外だけ出す。
// 手動グループは代表ディレクトリを持たないので全行に出す。自動グループでは別のディレクトリから
// D&D で移ってきたタブだけが該当する
export function shouldShowDir(session, group) {
  if (!group) return false;
  return Boolean(group.manual) || autoGroupKeyOf(session) !== group.key;
}

// 自動グループの代表ディレクトリ（元になったリポジトリのフルパス）。worktree はリポジトリ側に戻す。
// ホーム配下は `~` に畳む。手動グループや cwd 不明は null
export function representativeDirOf(group) {
  if (!group || group.manual) return null;
  const source = group.sessions?.find((s) => s.cwd && autoGroupKeyOf(s) === group.key);
  if (!source) return null;
  const { project } = parseCwd(source.cwd);
  const cwd = source.cwd.replace(/\/+$/, '');
  const i = cwd.lastIndexOf(`/${project}/`);
  const root = i >= 0 ? cwd.slice(0, i + project.length + 1) : cwd;
  return root.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}
