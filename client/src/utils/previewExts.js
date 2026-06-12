// プレビュー可能なファイル拡張子の唯一の定義。
// FileExplorer / FilePreview / ChatView / PreviewDrawer はすべてここを参照する
// （拡張子を増やすときはこの1ファイルだけ直せばよい）。

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"];
export const HTML_EXTS = [".html", ".htm"];
export const PDF_EXTS = [".pdf"];
// テキストとして読み込み・シンタックスハイライト対象にする拡張子
export const TEXT_EXTS = [
  ".md", ".txt", ".csv", ".json",
  ".js", ".jsx", ".ts", ".tsx",
  ".css", ".py", ".rb", ".go", ".sh",
  ".sql", ".sqlx",
];
export const MARKDOWN_EXTS = [".md"];

// プレビューボタンを出す / ファイラでクリック可能にする対象（画像・HTML・PDF・テキスト）
export const PREVIEWABLE_EXTS = [
  ...IMAGE_EXTS,
  ...HTML_EXTS,
  ...PDF_EXTS,
  ...TEXT_EXTS,
];

// パスから拡張子（先頭ドット付き・小文字）を取り出す。無ければ ""。
export function getExt(path) {
  const match = (path || "").match(/\.(\w+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function isPreviewable(path) {
  return PREVIEWABLE_EXTS.includes(getExt(path));
}
