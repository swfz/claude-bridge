// 新規セッションの作業ディレクトリ候補（直近 90 日のセッションの cwd）の絞り込みと表示整形。

export const DIR_SUGGEST_LIMIT = 50;

// home 配下は `~` に畳んで見せる（表示だけ。送るのは絶対パス）
export function displayDir(cwd, home) {
  if (!home) return cwd;
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

// 入力の `~` を絶対パスに戻す（`~user` は扱わない）
export function expandHome(input, home) {
  if (!home) return input;
  if (input === '~') return home;
  return input.startsWith('~/') ? `${home}${input.slice(1)}` : input;
}

const baseName = (cwd) => cwd.split('/').filter(Boolean).pop() || cwd;

// 空白区切りの語をすべて含むものだけ残し、ディレクトリ名（末尾）に当たるものを先に出す。
// 同じ順位の中ではサーバーの並び（最近使った順）を保つ。
export function filterDirSuggestions(dirs, query, { home = '', limit = DIR_SUGGEST_LIMIT } = {}) {
  const list = Array.isArray(dirs) ? dirs : [];
  const terms = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list.slice(0, limit);
  const last = terms[terms.length - 1];
  const ranked = [];
  list.forEach((d, i) => {
    const full = d.cwd.toLowerCase();
    const shown = displayDir(d.cwd, home).toLowerCase();
    if (!terms.every((t) => full.includes(t) || shown.includes(t))) return;
    const base = baseName(d.cwd).toLowerCase();
    const rank = base.startsWith(last) ? 0 : base.includes(last) ? 1 : 2;
    ranked.push({ d, i, rank });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.slice(0, limit).map((r) => r.d);
}

// 名前を省いたときのセッション名（作業ディレクトリ名）
export function defaultSessionName(cwd) {
  const trimmed = (cwd || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '~') return 'New Session';
  return baseName(trimmed);
}
