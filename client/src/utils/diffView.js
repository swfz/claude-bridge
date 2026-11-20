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

// ── 行モデル（差分の行へ指摘を書くための土台）─────────────────────────────
// patch を行ごとに {kind, text, oldLine, newLine, hunk} にする。
// add は newLine のみ、del は oldLine のみ、ctx は両方、hunk / meta（`\ No newline …`）は null。
// hunk は 0 始まりの hunk 番号（範囲選択を同じ hunk に閉じるため）。hunk 見出しより前の行（ヘッダ）は落とす。
// 本文が `--` / `++` で始まる行（`---x` など）も hunk の中では先頭 1 文字だけで種類を決める。
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkHeader(line) {
  const m = HUNK_RE.exec(line || '');
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

export function parseDiffRows(patch) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let hunk = -1;
  for (const { kind, text } of patchBodyLines(patch)) {
    if (kind === 'hunk') {
      hunk++;
      const h = parseHunkHeader(text);
      // 件数 0 の側（-0,0 や +0,0）は開始が 0 だが、その側の行は来ないので番号は使われない
      oldNo = h ? h.oldStart : 0;
      newNo = h ? h.newStart : 0;
      rows.push({ kind, text, oldLine: null, newLine: null, hunk });
    } else if (kind === 'meta') {
      rows.push({ kind, text, oldLine: null, newLine: null, hunk });
    } else if (kind === 'add') {
      rows.push({ kind, text, oldLine: null, newLine: newNo++, hunk });
    } else if (kind === 'del') {
      rows.push({ kind, text, oldLine: oldNo++, newLine: null, hunk });
    } else {
      rows.push({ kind, text, oldLine: oldNo++, newLine: newNo++, hunk });
    }
  }
  return rows;
}

// 指摘を付けられる行か（hunk 見出しと meta は付けられない）
export function isCommentableRow(row) {
  return !!row && (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx');
}

// 行の「側」と行番号。追加・文脈行は新ファイル側（new）、削除行は旧ファイル側（old）
export function rowAnchor(row) {
  if (!isCommentableRow(row)) return null;
  return row.kind === 'del' ? { side: 'old', line: row.oldLine } : { side: 'new', line: row.newLine };
}

// 行の本文（先頭の +/-/空白を外す）
export function rowCode(row) {
  return row && typeof row.text === 'string' ? row.text.slice(1) : '';
}

// 側と行番号から行を引く。無ければ -1
export function findRowIndex(rows, side, line) {
  return (rows || []).findIndex((row) => {
    const a = rowAnchor(row);
    return !!a && a.side === side && a.line === line;
  });
}

// i〜j（両端を含む）の行が全部 side の側か。old なら間が全部削除行、new なら間に削除行を挟まない
// （hunk 見出し・meta も挟まない）＝その側の行番号が途切れずに続く区間
export function isContiguousSide(rows, i, j, side) {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  for (let k = lo; k <= hi; k++) {
    if (rowAnchor(rows[k])?.side !== side) return false;
  }
  return true;
}

// 2 つの行（添字）から範囲を作る。同じ側の行が途切れずに続くときだけ範囲にし、それ以外は b の 1 行にする
// （削除行と追加行は行番号の体系が違う。間に別の側の行を挟むと、範囲の行番号が挟まった行と食い違う。
// 例: -a 旧30 / 文脈 旧31 / -b 旧32 で -a〜-b を「旧L30-L32」にすると文脈行まで含んでしまう）。
// 戻り値は {side, start, end}（start <= end）か null
export function rangeFromRows(rows, aIdx, bIdx) {
  const b = rows?.[bIdx];
  const bAnchor = rowAnchor(b);
  if (!bAnchor) return null;
  const a = aIdx == null ? null : rows[aIdx];
  const aAnchor = rowAnchor(a);
  if (!aAnchor || aAnchor.side !== bAnchor.side || !isContiguousSide(rows, aIdx, bIdx, bAnchor.side)) {
    return { side: bAnchor.side, start: bAnchor.line, end: bAnchor.line };
  }
  return {
    side: bAnchor.side,
    start: Math.min(aAnchor.line, bAnchor.line),
    end: Math.max(aAnchor.line, bAnchor.line),
  };
}

// 指摘（{side, start, end}）が今の rows のどこに当たるか。{startIdx, endIdx} か null（対象行が無い）。
// 範囲の両端の行が見つかり、間がその側の行だけで続いているときだけ当たりとする
export function locateRange(rows, { side, start, end }) {
  const startIdx = findRowIndex(rows, side, start);
  const endIdx = start === end ? startIdx : findRowIndex(rows, side, end);
  if (startIdx < 0 || endIdx < 0 || !isContiguousSide(rows, startIdx, endIdx, side)) return null;
  return { startIdx, endIdx };
}

// 引用の上限（行ごとに trim、複数行は ⏎ でつなぐ）
export const QUOTE_MAX = 120;

export function truncateQuote(text) {
  const t = (text || '').trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}…` : t;
}

export function quoteRows(rows, { side, start, end }) {
  const parts = [];
  for (const row of rows || []) {
    const a = rowAnchor(row);
    if (a && a.side === side && a.line >= start && a.line <= end) parts.push(rowCode(row).trim());
  }
  return truncateQuote(parts.filter(Boolean).join(' ⏎ '));
}

// 指摘が今の rows のどこに当たるか。行番号に加えて、書いたときの引用と今の本文が同じことを確かめる
// （取り直しで行がずれると、同じ行番号が別の行を指すため。ずれたもの・消えたものは null＝対象行が見つからない）
export function locateComment(rows, comment) {
  const loc = locateRange(rows, comment);
  if (!loc) return null;
  if (typeof comment.quote === 'string' && quoteRows(rows, comment) !== comment.quote) return null;
  return loc;
}

// 行番号の表記。new は `L12` / `L12-L15`、old は `旧L30` / `旧L30-L31`
export function lineLabel({ side, start, end }) {
  const prefix = side === 'old' ? '旧L' : 'L';
  return start === end ? `${prefix}${start}` : `${prefix}${start}-L${end}`;
}

// 送信本文の 1 項目。Claude が現ファイルの別の行と取り違えないよう、必ず側を書く。
//   追加・文脈行: `path:L12 「引用」について:\n指摘`
//   削除行:       `oldPath（削除された行 旧L30）「引用」について:\n指摘`（rename なら旧パス）
// stale（差分を取り直して対象行が見つからない）は、書いたときの行番号であることを添える。
// 番号と [レビュー N件] はサーバー（submit_review）が付ける
export function formatDiffComment({ path, oldPath, side, start, end, quote, text, stale }) {
  const range = { side, start, end };
  const where =
    side === 'old' ? `${oldPath || path}（削除された行 ${lineLabel(range)}）` : `${path}:${lineLabel(range)}`;
  const note = stale ? '（差分を取り直す前の行番号）' : '';
  const q = truncateQuote(quote);
  const head = q ? `${where}${note} 「${q}」について:` : `${where}${note} について:`;
  return `${head}\n${(text || '').trim()}`;
}
