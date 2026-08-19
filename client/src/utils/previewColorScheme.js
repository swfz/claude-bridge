// HTML プレビュー iframe 内ドキュメントへ注入する color-scheme を決める純粋関数群。
//
// 背景だけダークにして文字色を書いていない HTML（黒文字が沈む）や、
// 明るい文字だけ指定して背景が透過の HTML（白地で文字が消える）を救うため、
// ページ自身が color-scheme を宣言していない場合に限り、実際の背景色の明暗
// （背景が透過ならプレビュー側の明暗）に合わせた color-scheme を root に与える。
// color-scheme が付くと UA 既定の文字色・キャンバス色がその明暗に追従する。

// getComputedStyle が返す "rgb(...)" / "rgba(...)" をパースする
export function parseCssColor(str) {
  const m = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)/.exec(str || '');
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) {
    a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  }
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

// 相対輝度（簡易）で暗い色かどうか
export function isDarkColor({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

// body → html の順で「実際に塗られている背景」を返す（ほぼ透過なら null）
export function effectiveBackground(bodyBg, htmlBg) {
  for (const s of [bodyBg, htmlBg]) {
    const c = parseCssColor(s);
    if (c && c.a >= 0.5) return c;
  }
  return null;
}

// 注入すべき color-scheme を返す。ページ自身が宣言済みなら null（触らない）。
// - declared: root の computed color-scheme（未宣言なら "normal"）
// - ownInjected: 過去に自分が注入した値（data 属性）。再判定を許すため
// - previewScheme: プレビュー側の明暗 ("light" | "dark")
export function resolveInjectedScheme({ declared, ownInjected, bodyBg, htmlBg, previewScheme }) {
  if (declared && declared !== 'normal' && !ownInjected) return null;
  const bg = effectiveBackground(bodyBg, htmlBg);
  if (bg) return isDarkColor(bg) ? 'dark' : 'light';
  return previewScheme === 'light' ? 'light' : 'dark';
}
