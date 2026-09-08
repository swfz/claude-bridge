// プレビュー可能なファイル拡張子の唯一の定義。
// FileExplorer / FilePreview / ChatView / PreviewDrawer はすべてここを参照する
// （拡張子を増やすときはこの1ファイルだけ直せばよい）。

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
export const HTML_EXTS = ['.html', '.htm'];
export const PDF_EXTS = ['.pdf'];
// 動画は <video> でストリーミング再生する（Range 対応の /preview 経由）
export const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
// テキストとして読み込み・シンタックスハイライト対象にする拡張子
export const TEXT_EXTS = [
  '.md',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.py',
  '.rb',
  '.go',
  '.sh',
  '.sql',
  '.sqlx',
];
export const MARKDOWN_EXTS = ['.md'];
// テキストとしても読めるが、表としても描ける区切りテキスト（TEXT_EXTS の部分集合）
export const TABLE_EXTS = ['.csv', '.tsv'];

// プレビューボタンを出す / ファイラで「対応形式」として扱う対象（画像・HTML・PDF・動画・テキスト）
export const PREVIEWABLE_EXTS = [...IMAGE_EXTS, ...HTML_EXTS, ...PDF_EXTS, ...VIDEO_EXTS, ...TEXT_EXTS];

// パスから拡張子（先頭ドット付き・小文字）を取り出す。無ければ ""。
export function getExt(path) {
  const match = (path || '').match(/\.(\w+)$/);
  return match ? `.${match[1].toLowerCase()}` : '';
}

export function isPreviewable(path) {
  return PREVIEWABLE_EXTS.includes(getExt(path));
}
