// 差分ドロワーのキーボード操作（行カーソル）の純粋関数。
//
// カーソルは添字ではなく {path, side, line} で持つ（差分を取り直すと添字はずれるため。指摘のキーと同じ考え方）。
// 移動の順は「開いているファイルの、指摘を付けられる行」を行モデルの並び（rows の順）に並べたもの。
// 左右に並べる表示でも同じ順にする（削除の塊を上から読み、続けて追加の塊を読む）。
import { isContiguousSide, rowAnchor } from './diffView.js';

// files: [{path, rows}]（開いていて行を出しているファイルだけ、表示順）
// → [{path, idx, side, line, hunkStart, fileStart}]
export function buildNavList(files) {
  const nav = [];
  for (const { path, rows } of files || []) {
    let fileStart = true;
    let hunkStart = false;
    (rows || []).forEach((row, idx) => {
      if (row.kind === 'hunk') {
        hunkStart = true;
        return;
      }
      const a = rowAnchor(row);
      if (!a) return;
      nav.push({ path, idx, side: a.side, line: a.line, hunkStart: hunkStart || fileStart, fileStart });
      fileStart = false;
      hunkStart = false;
    });
  }
  return nav;
}

// カーソル（{path, side, line}）の位置。無ければ -1
export function findNavIndex(nav, cursor) {
  if (!cursor) return -1;
  return nav.findIndex((n) => n.path === cursor.path && n.side === cursor.side && n.line === cursor.line);
}

export function navCursor(item) {
  return item ? { path: item.path, side: item.side, line: item.line } : null;
}

// 1 行ずつの移動。カーソルが無ければ（どちら向きでも）先頭に置く。端では止まる
export function stepNav(nav, index, delta) {
  if (nav.length === 0) return -1;
  if (index < 0) return 0;
  return Math.max(0, Math.min(nav.length - 1, index + delta));
}

// 次・前の hunk（key: 'hunkStart'）またはファイル（key: 'fileStart'）の先頭へ。無ければ動かない。
// カーソルが無ければ、次へは先頭、前へは最後の区切りへ
export function jumpNav(nav, index, dir, key = 'hunkStart') {
  if (nav.length === 0) return -1;
  if (dir > 0) {
    for (let j = index + 1; j < nav.length; j++) if (nav[j][key]) return j;
    return index < 0 ? 0 : index;
  }
  const from = index < 0 ? nav.length : index;
  for (let j = from - 1; j >= 0; j--) if (nav[j][key]) return j;
  return index < 0 ? 0 : index;
}

// Shift+↑↓ の範囲の広げ方。anchor（範囲の起点の nav 添字）から next までが、同じファイルで
// その側の行が途切れずに続くときだけ広げる（第 1 段階の isContiguousSide と同じ決まり）。広げられなければ null
export function extendNav(nav, rowsByPath, anchor, next) {
  const a = nav[anchor];
  const b = nav[next];
  if (!a || !b || a.path !== b.path || a.side !== b.side) return null;
  const rows = rowsByPath.get(a.path);
  if (!rows || !isContiguousSide(rows, a.idx, b.idx, a.side)) return null;
  return next;
}

// nav 添字の範囲（anchor 〜 index）を {side, start, end} にする（指摘の範囲と同じ形）
export function navRange(nav, anchor, index) {
  const b = nav[index];
  if (!b) return null;
  const a = anchor == null ? b : nav[anchor] || b;
  if (a.path !== b.path || a.side !== b.side) return { side: b.side, start: b.line, end: b.line };
  return { side: b.side, start: Math.min(a.line, b.line), end: Math.max(a.line, b.line) };
}
