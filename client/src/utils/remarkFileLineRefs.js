import { findFileLineRefs } from './fileLineRef.js';

// 地の文に裸で書かれた `path:行`（Claude Code は `file_path:line_number` の形でよく書く）を、インラインコードの
// ノードに切り出す remark プラグイン。描画は ChatView の MdCode が受け持ち、data-bare の印で「元は地の文」と分かる
// （ファイルが無ければ code ではなく素の文字に戻す）。
// コードブロック・インラインコード・リンク（ラベル）・HTML の中は触らない。
// react-markdown に渡すプラグインはモジュール定数にすること（作り直すと本文が毎回再マウントされる）
const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);

export function splitTextNode(node) {
  const refs = findFileLineRefs(node.value);
  if (refs.length === 0) return null;
  const out = [];
  let pos = 0;
  for (const ref of refs) {
    if (ref.start > pos) out.push({ type: 'text', value: node.value.slice(pos, ref.start) });
    out.push({ type: 'inlineCode', value: ref.raw, data: { hProperties: { 'data-bare': 'true' } } });
    pos = ref.end;
  }
  if (pos < node.value.length) out.push({ type: 'text', value: node.value.slice(pos) });
  return out;
}

export function remarkFileLineRefs() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children || SKIP.has(node.type)) return;
      const next = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === 'text') {
          const parts = splitTextNode(child);
          if (parts) {
            next.push(...parts);
            changed = true;
            continue;
          }
        } else {
          walk(child);
        }
        next.push(child);
      }
      if (changed) node.children = next;
    };
    walk(tree);
  };
}

export default remarkFileLineRefs;
