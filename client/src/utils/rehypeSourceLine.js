// レンダリング後の各ブロック要素に、元 Markdown ソースの開始行を data-source-line として付ける
// rehype プラグイン。これで「レンダリング表示のままどの行由来か」を特定でき、
// コメントの行マーカーや行ピックのバッジを置ける。
// プレビュー（PreviewDrawer）とチャット（ChatView）で共用するのでモジュール定数として渡すこと。
export function rehypeSourceLine() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.position?.start?.line) {
        node.properties = node.properties || {};
        node.properties['data-source-line'] = node.position.start.line;
      }
      (node.children || []).forEach(visit);
    };
    visit(tree);
  };
}

export default rehypeSourceLine;
