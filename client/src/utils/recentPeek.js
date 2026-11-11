// ホームの行リストの「直近のやりとり」ポップオーバーの位置計算。
// アイコンの左下を基本にし、下に入らなければ上、左右も画面内（余白 margin）に収める。
// anchorRect / popSize / viewport は DOM の値をそのまま渡せる形（{left, top, right, bottom} / {width, height}）
export function peekPosition(anchorRect, popSize, viewport, { gap = 6, margin = 8 } = {}) {
  const width = Math.min(popSize.width, viewport.width - margin * 2);
  const height = Math.min(popSize.height, viewport.height - margin * 2);

  // 左右: アイコンの左端に揃え、右にはみ出すなら左へずらす。それでも入らなければ左端に寄せる
  let left = anchorRect.left;
  if (left + width > viewport.width - margin) left = viewport.width - margin - width;
  if (left < margin) left = margin;

  // 上下: 下に入るなら下、入らなければ上。どちらにも入らなければ広い側に置いて画面内に収める
  const below = anchorRect.bottom + gap;
  const above = anchorRect.top - gap - height;
  let top;
  let placement;
  if (below + height <= viewport.height - margin) {
    top = below;
    placement = 'below';
  } else if (above >= margin) {
    top = above;
    placement = 'above';
  } else {
    const roomBelow = viewport.height - anchorRect.bottom;
    placement = roomBelow >= anchorRect.top ? 'below' : 'above';
    top = Math.max(margin, Math.min(placement === 'below' ? below : above, viewport.height - margin - height));
  }
  return { left, top, placement };
}
