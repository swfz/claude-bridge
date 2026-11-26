// コードブロック（pre の中の code）に data-block を付ける rehype プラグイン。
// react-markdown は言語の無いフェンス（```）の code に className を付けないので、MdCode の「className が無い＝
// インラインコード」という判定ではブロックと見分けられず、中身のパス（`path:行` など）がピルになってしまう。
// react-markdown に渡すプラグインはモジュール定数にすること
export function rehypeMarkBlockCode() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.tagName === 'pre') {
        for (const child of node.children || []) {
          if (child.type === 'element' && child.tagName === 'code') {
            child.properties = { ...child.properties, 'data-block': 'true' };
          }
        }
      }
      (node.children || []).forEach(visit);
    };
    visit(tree);
  };
}

export default rehypeMarkBlockCode;
