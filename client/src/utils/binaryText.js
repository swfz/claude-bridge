// 「テキストとして表示してよいか」の判定（純粋関数）。
//
// 未知の拡張子はテキストとして読みに行く（プレビュー非対応で何も見えないより良い）が、
// 実行ファイルや画像を流し込むと文字化けで画面が埋まるので、その前に弾く。
// 判定は fetch で読んだ文字列に対して行うので、UTF-8 として解釈できなかったバイトが
// 置換文字（U+FFFD）になっている割合も手がかりに使う。

// 見るのは先頭 8KB だけ（バイナリなら冒頭で分かる）
const HEAD_CHARS = 8192;
// 置換文字がこの割合を超えたらバイナリと見なす
const REPLACEMENT_RATIO = 0.05;

export function looksBinary(text) {
  const head = String(text ?? '').slice(0, HEAD_CHARS);
  if (head.length === 0) return false;
  // NUL が混ざっているものはテキストではない
  if (head.includes('\u0000')) return true;
  const replacements = (head.match(/\uFFFD/g) || []).length;
  return replacements / head.length > REPLACEMENT_RATIO;
}
