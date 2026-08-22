// プレビュー上のテキスト選択範囲から、レビュー送信時に Claude が
// 「どこの何を指すか」を一意に特定できる位置情報を組み立てるユーティリティ。
// 同名トークン（例: useState）が複数出てきても判別できるよう、
// 行・列・前後コンテキスト・出現順・直近見出しを必要に応じて返す。

// rootEl 配下のテキストノードを文書順に走査し、指定 (node, offsetInNode) までの
// 累積文字数を返す。rootEl が node を含まない場合は -1。
export function getRootTextOffset(rootEl, node, offsetInNode) {
  if (!rootEl || !node || !rootEl.contains(node)) return -1;
  // node がテキストノードでない場合は、その node の子の先頭から offsetInNode 番目までの
  // テキスト長を加算する必要がある。Range.startContainer は要素になり得るため対応する。
  if (node.nodeType !== Node.TEXT_NODE) {
    let total = 0;
    const children = Array.from(node.childNodes).slice(0, offsetInNode);
    for (const c of children) total += textLengthOf(c);
    return getRootTextOffset(rootEl, node, 0) + total;
  }
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  let total = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + offsetInNode;
    total += current.nodeValue.length;
  }
  return -1;
}

function textLengthOf(node) {
  return node.nodeType === Node.TEXT_NODE ? node.nodeValue.length : node.textContent.length;
}

// テキスト先頭から offset 位置の {line, column}（共に 1-based）。
export function offsetToLineCol(text, offset) {
  if (offset < 0) return { line: 1, column: 1 };
  const clamped = Math.min(offset, text.length);
  const upto = text.slice(0, clamped);
  const idx = upto.lastIndexOf('\n');
  const line = (upto.match(/\n/g) || []).length + 1;
  const column = idx === -1 ? clamped + 1 : clamped - idx;
  return { line, column };
}

// 選択範囲 [start, end) の前後 span 文字を抜き出す。改行は空白に潰して1行表記に。
export function getContext(text, startOffset, endOffset, span = 30) {
  const beforeStart = Math.max(0, startOffset - span);
  const afterEnd = Math.min(text.length, endOffset + span);
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  return {
    before: squash(text.slice(beforeStart, startOffset)),
    after: squash(text.slice(endOffset, afterEnd)),
  };
}

// needle が text 内で何番目に出現したか、および総出現数を返す。
// startOffset と一致する出現を index として返す（1-based、見つからなければ 0）。
export function getOccurrenceIndex(text, needle, startOffset) {
  if (!needle) return { index: 0, total: 0 };
  let total = 0;
  let index = 0;
  let pos = 0;
  while (pos <= text.length) {
    const found = text.indexOf(needle, pos);
    if (found === -1) break;
    total++;
    if (found === startOffset) index = total;
    pos = found + 1;
  }
  return { index, total };
}

// source 上で needle の targetIndex 番目（1-based）の出現位置を返す。見つからなければ -1。
// Markdown プレビューのように rendered DOM と source が同形でない場合、DOM 上での出現順から
// source 上の位置を推定するのに使う。
export function findOccurrenceOffset(sourceText, needle, targetIndex) {
  if (!needle || targetIndex < 1) return -1;
  let pos = 0;
  let count = 0;
  while (pos <= sourceText.length) {
    const found = sourceText.indexOf(needle, pos);
    if (found === -1) return -1;
    count++;
    if (count === targetIndex) return found;
    pos = found + 1;
  }
  return -1;
}

// 文書順で node より前にある最後の見出し要素（h1-h6）を返す。
// Markdown プレビューで「どのセクションの選択か」を補足するのに使う。
export function findNearestHeading(node, rootEl) {
  if (!rootEl || !node || !rootEl.contains(node)) return null;
  const headings = rootEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let last = null;
  for (const h of headings) {
    const pos = h.compareDocumentPosition(node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      // h が node より前にある
      last = h;
    } else if (h === node) {
      last = h;
    } else {
      // 後続の見出しに来たら打ち切り
      break;
    }
  }
  if (!last) return null;
  return {
    level: parseInt(last.tagName[1], 10),
    text: last.textContent.trim(),
  };
}

// 選択 Range と、その選択の「ソーステキスト」（コードファイルなら fileContent、
// Markdown プレビューなら markdown ソース）を渡し、レビュー送信用の位置ラベルと
// 前後コンテキストを構築する。
// kind: "code" | "markdown" | "text" | "html"
export function buildLocationInfo({ kind, sourceText, selectedText, sourceStart, sourceEnd, heading }) {
  const info = { contextBefore: '', contextAfter: '', label: '' };
  if (sourceText && sourceStart >= 0 && sourceEnd >= sourceStart) {
    const ctx = getContext(sourceText, sourceStart, sourceEnd);
    info.contextBefore = ctx.before;
    info.contextAfter = ctx.after;
  }
  const occ = sourceText ? getOccurrenceIndex(sourceText, selectedText, sourceStart) : { index: 0, total: 0 };

  if ((kind === 'code' || kind === 'text' || kind === 'html') && sourceText && sourceStart >= 0) {
    const { line, column } = offsetToLineCol(sourceText, sourceStart);
    info.label = occ.total > 1 ? `L${line}:C${column}, ${occ.index}/${occ.total}箇所目` : `L${line}:C${column}`;
  } else if (kind === 'markdown') {
    const parts = [];
    if (heading) parts.push(`「${heading.text}」セクション`);
    if (occ.total > 1) parts.push(`${occ.index}/${occ.total}箇所目`);
    info.label = parts.join(', ');
  }
  return info;
}
