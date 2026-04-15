import { useEffect, useState } from "react";
import "./FilePreview.css";

const PREVIEWABLE = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".html", ".htm", ".pdf",
  ".md", ".txt", ".csv", ".json", ".js", ".css", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".sh",
];

function getExt(path) {
  const match = path.match(/\.(\w+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function extractLocalPath(url) {
  if (url.startsWith("file://wsl.localhost/")) {
    return url.replace(/^file:\/\/wsl\.localhost\/[^/]+/, "");
  }
  if (url.startsWith("file:///")) {
    return url.slice(7);
  }
  if (url.startsWith("file://")) {
    return url.slice(7);
  }
  return url;
}

// 同一パスに対する存在確認をメモ化（セッション内で使い回し）
const existsCache = new Map();

function checkFileExists(path) {
  if (existsCache.has(path)) {
    return existsCache.get(path);
  }
  const promise = fetch(`/file-exists?path=${encodeURIComponent(path)}`)
    .then((r) => (r.ok ? r.json() : { exists: false }))
    .then((data) => !!data.exists)
    .catch(() => false);
  existsCache.set(path, promise);
  return promise;
}

export default function FilePreview({ href, onOpenPreview, onOpenFileReview }) {
  const localPath = extractLocalPath(href);
  const fileName = localPath.split("/").pop();
  const ext = getExt(localPath);
  const canPreview = PREVIEWABLE.includes(ext);
  const [exists, setExists] = useState(null);

  useEffect(() => {
    let cancelled = false;
    checkFileExists(localPath).then((ok) => {
      if (!cancelled) setExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [localPath]);

  // 存在しないパスはプレビュー不可として扱う（Claude の地の文中の略称ファイル名など）
  if (exists === false) {
    return <code className="inline-code">{fileName}</code>;
  }

  return (
    <span className="file-preview-inline">
      <span className="file-link-group">
        <span className="file-icon">
          {ext === ".md" ? "M" : ext === ".html" ? "H" : "F"}
        </span>
        <button
          className="file-link"
          onClick={() => canPreview && onOpenPreview(localPath)}
          title={localPath}
        >
          {fileName}
        </button>
        {canPreview && (
          <>
            <button
              className="file-btn file-btn-preview"
              onClick={() => onOpenPreview(localPath)}
            >
              プレビュー
            </button>
            {onOpenFileReview && (
              <button
                className="file-btn file-btn-review"
                onClick={() => onOpenFileReview(localPath)}
              >
                レビュー
              </button>
            )}
          </>
        )}
      </span>
      <span className="file-path-display">{localPath}</span>
    </span>
  );
}
