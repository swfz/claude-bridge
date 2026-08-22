// 「最下部にいる」と見なす余白（px）。行の途中で止めていても追従を続けられる程度の緩さ。
export const BOTTOM_THRESHOLD_PX = 80;

// スクロールコンテナが最下部付近にいるか。
// el は { scrollHeight, scrollTop, clientHeight } を持つものならよい（テスト用にプレーンオブジェクトでも可）。
export function isScrolledToBottom(el, threshold = BOTTOM_THRESHOLD_PX) {
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
