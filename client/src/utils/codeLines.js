// コードプレビューを「1 行 1 要素」の HTML に組み立てる純粋関数。
//
// 行番号ガター（`.drawer-code-line::before` の `content: attr(data-line)`）と
// 行ピックのターゲット強調は行要素の矩形から位置を出すので、行が要素として分かれている必要がある。
// 一方で選択範囲から行・列を割り出す処理は `pre` の textContent がソースと一致していることに
// 依存しているため、行の区切りは実際の改行文字のままにし、行番号は疑似要素で描く（textContent に入れない）。

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// highlight.js の出力を行ごとに切り分ける。
// span がブロックコメントのように複数行にまたがることがあるので、行末でいったん閉じて
// 次の行で開き直す（単純に "\n" で split するとタグが片方だけの行ができてしまう）。
export function splitHighlightedLines(html) {
  if (html == null) return null;
  const lines = [];
  const stack = [];
  let cur = '';

  const pushText = (text) => {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        for (let k = stack.length - 1; k >= 0; k--) cur += `</${stack[k].name}>`;
        lines.push(cur);
        cur = stack.map((t) => t.open).join('');
      }
      cur += part;
    });
  };

  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const tag = m[0];
    if (tag.startsWith('</')) {
      const name = tag.slice(2, -1).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.splice(k, 1);
          break;
        }
      }
      cur += tag;
    } else if (tag.endsWith('/>')) {
      cur += tag;
    } else {
      stack.push({
        name: tag
          .slice(1)
          .split(/[\s/>]/)[0]
          .toLowerCase(),
        open: tag,
      });
      cur += tag;
    }
  }
  pushText(html.slice(last));
  lines.push(cur);
  return lines;
}

// ソース全文（＋あればハイライト済み HTML）から、行要素を並べた HTML を作る。
// 行数が食い違うハイライトは使わず、素のテキストにフォールバックする（textContent の一致を優先）。
export function buildCodeLinesHtml(text, highlightedHtml) {
  const lines = String(text ?? '').split('\n');
  const highlighted = splitHighlightedLines(highlightedHtml);
  const useHighlight = highlighted != null && highlighted.length === lines.length;
  return lines
    .map((line, i) => {
      const inner = useHighlight ? highlighted[i] : escapeHtml(line);
      return `<span class="drawer-code-line" data-line="${i + 1}">${inner}</span>`;
    })
    .join('\n');
}
