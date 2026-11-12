// 差分ドロワー（入力欄の /diff）の整形。データはサーバーの session_diff
// （server/session-diff.js）で、files: [{path, oldPath?, status, binary, additions, deletions, patch, tooLarge?}]

export const DIFF_SCOPES = [
  { value: 'all', label: '全体' },
  { value: 'session', label: 'このセッション' },
];

export const DIFF_SCOPE_STORAGE_KEY = 'diffDrawerScope';

// 既定で畳む 1 ファイルの変更行数（大きなファイルで他のファイルを押し流さない）
export const COLLAPSE_LINES = 300;

export function normalizeDiffScope(value) {
  return value === 'session' ? 'session' : 'all';
}

// ブリッジが横取りするコマンドか（送信せずにドロワーを開く）。引数は付けられない
export function isDiffCommand(text) {
  return typeof text === 'string' && text.trim() === '/diff';
}

const STATUS_LABELS = {
  added: '新規',
  deleted: '削除',
  renamed: '名前変更',
  untracked: '未追跡',
  committed: '差分なし（コミット済み）',
  missing: '差分なし（ファイルなし）',
};

// 既定の modified は出さない（例外だけ表示する）
export function diffStatusLabel(status) {
  return STATUS_LABELS[status] || null;
}

// patch の中身（最初の @@ 以降）を行ごとに種類付きで返す。ヘッダ（diff --git / index / --- / +++）は落とす
export function patchBodyLines(patch) {
  if (!patch) return [];
  const lines = patch.replace(/\n$/, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return [];
  return lines.slice(start).map((text) => ({ kind: diffLineKind(text), text }));
}

export function diffLineKind(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('\\')) return 'meta';
  return 'ctx';
}

export function summarizeDiff(files) {
  let additions = 0;
  let deletions = 0;
  let changed = 0;
  for (const file of files || []) {
    additions += file.additions || 0;
    deletions += file.deletions || 0;
    if (file.status !== 'committed' && file.status !== 'missing') changed++;
  }
  return { changed, additions, deletions };
}

export function shouldCollapseFile(file) {
  return (file.additions || 0) + (file.deletions || 0) > COLLAPSE_LINES;
}

// リポジトリルートからの相対パスをプレビュー用の絶対パスにする
export function absolutePath(root, path) {
  if (!root || !path) return null;
  return `${root.replace(/\/+$/, '')}/${path}`;
}

export function splitPath(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
