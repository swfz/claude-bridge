// ファイラのルート（起点ディレクトリ）。cwd 以外（~/tmp など）も見られるようにするための純粋関数。
// サーバー側のサンドボックス（home / /tmp 配下のみ）が最終的な可否を決めるので、ここは表示と記憶だけ。

export const FILER_ROOT_KEY = 'filerRoot';
export const FILER_CUSTOM_ROOTS_KEY = 'filerCustomRoots';

// cwd はセッションによって変わるので、パスではなくこの sentinel で覚える
export const CWD_ROOT = 'cwd';

const MAX_CUSTOM_ROOTS = 5;

// 入力パスの正規化。`~` は home に展開し、末尾スラッシュを落とす。
// 絶対パスにならないもの（空・相対パス）は選べないので null。
export function normalizeRootInput(input, home) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let path = raw;
  if (home && (path === '~' || path.startsWith('~/'))) {
    path = path === '~' ? home : `${home}/${path.slice(2)}`;
  }
  if (!path.startsWith('/')) return null;
  // 連続スラッシュを畳んでから末尾スラッシュを落とす（`/` 自身は残す）
  path = path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return path;
}

// 表示用にホーム配下を `~` に畳む
export function rootLabel(path, home) {
  if (!path) return '';
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

// セレクトに出す候補。cwd → ~/tmp → ~ → /tmp の順で、あとに保存済みのカスタムを足す。
export function buildRootOptions({ cwd, home, homeTmp, customRoots }) {
  const options = [];
  if (cwd) options.push({ value: CWD_ROOT, label: `cwd: ${rootLabel(cwd, home)}`, path: cwd });
  if (homeTmp) options.push({ value: homeTmp, label: rootLabel(homeTmp, home), path: homeTmp });
  if (home) options.push({ value: home, label: '~', path: home });
  options.push({ value: '/tmp', label: '/tmp', path: '/tmp' });
  for (const path of customRoots || []) {
    if (options.some((o) => o.path === path)) continue;
    options.push({ value: path, label: rootLabel(path, home), path });
  }
  return options;
}

// 選択値から実際に開くパスを決める。cwd が無いセッション（閲覧など）では home に落とす。
export function resolveRootPath(value, { cwd, home }) {
  if (!value || value === CWD_ROOT) return cwd || home || '/tmp';
  return value;
}

// 手入力したパスの履歴。新しいものを先頭に積み、プリセットと重複するものは持たない。
export function addCustomRoot(customRoots, path, presetPaths = []) {
  const list = customRoots || [];
  if (!path || presetPaths.includes(path)) return list;
  return [path, ...list.filter((p) => p !== path)].slice(0, MAX_CUSTOM_ROOTS);
}

export function loadRoot() {
  return localStorage.getItem(FILER_ROOT_KEY) || CWD_ROOT;
}

export function saveRoot(value) {
  localStorage.setItem(FILER_ROOT_KEY, value || CWD_ROOT);
}

export function loadCustomRoots() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILER_CUSTOM_ROOTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
  } catch {
    // 壊れた値は捨てる（履歴は失っても入力し直せる）
    return [];
  }
}

export function saveCustomRoots(list) {
  localStorage.setItem(FILER_CUSTOM_ROOTS_KEY, JSON.stringify(list || []));
}
