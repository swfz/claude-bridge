// 左端のつまみで幅を変えるドロワーの、幅の計算（純粋関数）。DOM への取り付けは hooks/useResizableWidth.js。
//
// 幅は「ユーザーが選んだ幅」（保存する値）と「今の画面で使える幅」（表示する値）を分けて持つ。
// 画面を狭めて上限を超えたら表示だけ詰め、広げ直せば選んだ幅に戻る。
// 上限より下限が大きくなる狭い画面では、画面からはみ出さない方（上限）を優先する。

// 上限: 画面幅に対する割合と、画面の端から残す余白の小さい方
export function maxWidthFor(viewport, { maxRatio = 0.95, margin = 0 } = {}) {
  const vw = Math.max(0, Number(viewport) || 0);
  return Math.max(0, Math.floor(Math.min(vw * maxRatio, vw - margin)));
}

export function clampWidth(width, viewport, { min = 400, maxRatio = 0.95, margin = 0 } = {}) {
  const max = maxWidthFor(viewport, { maxRatio, margin });
  return Math.round(Math.min(max, Math.max(Math.min(min, max), width)));
}

// 左端をつまんで動かした幅（左へ動かすと広がる）
export function widthFromDrag(startWidth, startX, x) {
  return startWidth + (startX - x);
}

// ←/→ キーでの幅（つまみは左端なので ← で広がる）。Shift で大きく動かす。対象外のキーは null
export const KEY_STEP = 32;
export const KEY_STEP_LARGE = 160;
export function widthFromKey(width, e) {
  const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  if (e.key === 'ArrowLeft') return width + step;
  if (e.key === 'ArrowRight') return width - step;
  return null;
}

// 保存した値を読む。数値として読めない・正でないものは null（CSS の既定幅を使う）
export function parseStoredWidth(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
