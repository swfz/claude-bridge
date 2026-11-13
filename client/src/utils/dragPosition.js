// ドラッグで動かすポップオーバーの位置計算（純粋関数）

// 箱の左上 (x, y) を画面内に収める。箱が画面より大きければ左上を 0 に寄せる（見出し＝掴む所を見失わないため）
export function clampToViewport({ x, y, width, height }, { width: vw, height: vh }, margin = 4) {
  const maxX = Math.max(margin, vw - width - margin);
  const maxY = Math.max(margin, vh - height - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

// ドラッグ開始時の箱の矩形と、ポインタの移動量から、新しい左上を返す
export function dragTo(startRect, dx, dy, viewport, margin) {
  return clampToViewport(
    { x: startRect.left + dx, y: startRect.top + dy, width: startRect.width, height: startRect.height },
    viewport,
    margin,
  );
}
