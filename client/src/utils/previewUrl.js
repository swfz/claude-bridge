// /preview の URL。PiP 窓（about:blank 由来の document）でも解決できるよう、
// origin を渡されたときは絶対 URL にする。
export function previewUrl(localPath, origin = '') {
  return `${origin}/preview?path=${encodeURIComponent(localPath)}`;
}
