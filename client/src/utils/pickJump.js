// ピック中の Ctrl+D / Ctrl+U（半画面分の移動）。
//
// 「対象を半画面分先へ飛ばす」を、要素の画面上の位置から決める純粋関数。
// items は画面上の並び順（上から下）で `{ n, top }`（n = ピック番号、top = 画面上の y）。
// current の位置から direction（'down' = 画面の下方向 / 'up' = 上方向）に見ていき、
// 最初に half 以上離れた要素の n を返す。そこまで行かずに端に着いたら端の n を返す。
// 動ける要素が無ければ current をそのまま返す。current が無ければ端から始める。
export function halfScreenJump({ items, current, half, direction }) {
  if (!Array.isArray(items) || items.length === 0) return current ?? null;
  const dir = direction === 'up' ? -1 : 1;
  let i = items.findIndex((it) => it.n === current);
  if (i < 0) {
    // 未選択なら、進む方向の手前の端から始める（下方向なら一番上、上方向なら一番下）
    return dir > 0 ? items[0].n : items[items.length - 1].n;
  }
  const startTop = items[i].top;
  let last = items[i].n;
  for (let j = i + dir; j >= 0 && j < items.length; j += dir) {
    last = items[j].n;
    if (Math.abs(items[j].top - startTop) >= half) return last;
  }
  return last;
}
