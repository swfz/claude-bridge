// 差分ドロワーの表示まわりの純粋関数（左右に並べる表示・構文ハイライト・表示モード）。
// 行モデル（parseDiffRows の rows）が唯一の正で、ここではその「並べ方」と「色付け」だけを決める。
// 指摘・範囲・カーソルは表示モードに関わらず rows と（側, 行番号）で扱う。
import { splitHighlightedLines } from './codeLines.js';
import { rowCode } from './diffView.js';

// ── 表示モード ─────────────────────────────────────────────
export const DIFF_VIEW_MODES = [
  { value: 'unified', label: '1列' },
  { value: 'split', label: '左右' },
];
export const DIFF_VIEW_STORAGE_KEY = 'diffDrawerView';

export function normalizeViewMode(value) {
  return value === 'split' ? 'split' : 'unified';
}

// 左右に並べるのに要る差分の列の幅（px）。これより狭ければ 1 列に倒す（片側 360px 弱でコードを読める下限）
export const SPLIT_MIN_WIDTH = 720;

export function effectiveViewMode(mode, width) {
  return normalizeViewMode(mode) === 'split' && width >= SPLIT_MIN_WIDTH ? 'split' : 'unified';
}

// ── 左右に並べる対応づけ ─────────────────────────────────────
// rows を表示行の並びにする。
//   {type: 'hunk', idx}                  hunk 見出し（左右をまたぐ 1 行）
//   {type: 'pair', left, right}          左＝旧、右＝新の行の添字（片側だけなら反対は null）
// 文脈行は left === right（同じ行を左右に出す）。続く削除と追加は上から順に横に並べ、余った方は反対を空ける。
// `\ No newline at end of file`（meta）は直前の行の側に付ける（削除と追加の間に来ても区切らない）。
// 文脈行の後ろの meta は left === right の 1 行にする。
export function pairSplitRows(rows) {
  const lines = [];
  let dels = [];
  let adds = [];
  let last = null;
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) lines.push({ type: 'pair', left: dels[k] ?? null, right: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  (rows || []).forEach((row, i) => {
    if (row.kind === 'del') {
      // 追加の後にまた削除が来たら、別の塊として並べ直す
      if (adds.length) flush();
      dels.push(i);
      last = 'del';
    } else if (row.kind === 'add') {
      adds.push(i);
      last = 'add';
    } else if (row.kind === 'meta' && last === 'del') {
      dels.push(i);
    } else if (row.kind === 'meta' && last === 'add') {
      adds.push(i);
    } else {
      flush();
      lines.push(row.kind === 'hunk' ? { type: 'hunk', idx: i } : { type: 'pair', left: i, right: i });
      last = row.kind;
    }
  });
  flush();
  return lines;
}

// 行の添字 → 表示行の添字（指摘欄を「その行を含む表示行」の直後に出すため）
export function splitLineIndex(lines) {
  const map = new Map();
  lines.forEach((line, k) => {
    if (line.type === 'hunk') map.set(line.idx, k);
    else {
      if (line.left != null) map.set(line.left, k);
      if (line.right != null) map.set(line.right, k);
    }
  });
  return map;
}

// ── 構文ハイライト ─────────────────────────────────────────
// 1 行ずつ色付けすると、複数行にまたがるコメント・文字列が崩れる。新側（文脈＋追加）と旧側（文脈＋削除）を
// それぞれ連結して色付けし、行に戻す（hunk の境目で状態がずれるのは許容）。
// highlight(text) は HTML を返す関数（hljs。テストでは差し替える）。返り値は rows と同じ長さの HTML の配列で、
// 色付けできなかった行は null（呼び出し側はエスケープした素のテキストを出す。null を HTML として扱わない）。
// 大きいもの（行数・文字数・極端に長い 1 行）は色付けしない
export const HIGHLIGHT_MAX_ROWS = 3000;
export const HIGHLIGHT_MAX_CHARS = 300000;
export const HIGHLIGHT_MAX_LINE = 2000;

export function highlightDiffRows(rows, highlight) {
  if (!highlight || !Array.isArray(rows) || rows.length === 0 || rows.length > HIGHLIGHT_MAX_ROWS) return null;
  const sides = { new: [], old: [] };
  let chars = 0;
  rows.forEach((row, i) => {
    if (row.kind !== 'add' && row.kind !== 'del' && row.kind !== 'ctx') return;
    const code = rowCode(row);
    chars += code.length;
    if (code.length > HIGHLIGHT_MAX_LINE) chars = Infinity;
    if (row.kind !== 'del') sides.new.push([i, code]);
    if (row.kind !== 'add') sides.old.push([i, code]);
  });
  if (chars > HIGHLIGHT_MAX_CHARS) return null;
  const out = new Array(rows.length).fill(null);
  for (const [side, list] of Object.entries(sides)) {
    if (list.length === 0) continue;
    let html;
    try {
      html = highlight(list.map(([, code]) => code).join('\n'));
    } catch {
      html = null;
    }
    const lines = splitHighlightedLines(html);
    if (!lines || lines.length !== list.length) continue;
    list.forEach(([i], k) => {
      // 文脈行は新側の色付けを使う（旧側は削除行にだけ当てる）
      if (side === 'new' || rows[i].kind === 'del') out[i] = lines[k];
    });
  }
  return out;
}

// パスの拡張子（小文字）。ハイライトの言語を引くのに使う
export function extOf(path) {
  const name = (path || '').split('/').pop();
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}
