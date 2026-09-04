// レンダリング済み Markdown の要素と「元ソースの行番号」を対応づけるユーティリティ。
// rehypeSourceLine が付けた data-source-line を読む。
// プレビュー（PreviewDrawer）とチャット（ChatView）の行ピックで共用する。

// data-source-line を持つ要素のうち「末端ブロック」(tr/li/p/見出し等) を優先して行に対応づける。
// コンテナ(ul/ol/table/div) を選ぶと範囲が広すぎて、どの行を指しているのか分からなくなる。
export const LEAF_BLOCKS = new Set(['TR', 'LI', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE']);
export const ANY_BLOCK = new Set([...LEAF_BLOCKS, 'TABLE', 'UL', 'OL', 'DL', 'DIV']);

// root 配下の data-source-line 要素を行番号の昇順で集める。
// sort は安定なので、同じ行の要素は DOM 順（＝浅い方が先）のまま残る。
export function collectSourceBlocks(root) {
  return [...root.querySelectorAll('[data-source-line]')]
    .map((el) => ({ el, line: parseInt(el.getAttribute('data-source-line'), 10) }))
    .filter((x) => x.line > 0)
    .sort((a, b) => a.line - b.line);
}

// 指定行に対応するブロック要素。同一行に複数（ネスト）あれば DOM 順で最も深いものを選ぶ。
// exactOnly でなければ、完全一致が無いときその行を含む直近のブロック（line 以下で最大）を返す。
export function blockForLine(blocks, line, { exactOnly = false } = {}) {
  const exact = blocks.filter((x) => x.line === line);
  if (exact.length) {
    const leaves = exact.filter((x) => LEAF_BLOCKS.has(x.el.tagName));
    return (leaves.length ? leaves[leaves.length - 1] : exact.find((x) => ANY_BLOCK.has(x.el.tagName)) || exact[0]).el;
  }
  if (exactOnly) return null;
  let chosen = null;
  for (const x of blocks) {
    if (x.line <= line) chosen = x;
    else break;
  }
  return chosen?.el || null;
}
