import { useEffect, useState } from 'react';
import { TbFile } from 'react-icons/tb';
import { PREVIEWABLE_EXTS, getExt } from '../utils/previewExts.js';
import { splitFilePath } from '../utils/toolLines.js';
import './FilePreview.css';

export function extractLocalPath(url) {
  if (url.startsWith('file://wsl.localhost/')) {
    return url.replace(/^file:\/\/wsl\.localhost\/[^/]+/, '');
  }
  if (url.startsWith('file:///')) {
    return url.slice(7);
  }
  if (url.startsWith('file://')) {
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

export default function FilePreview({ href, cwd, onOpenPreview, onOpenFileReview }) {
  const localPath = extractLocalPath(href);
  const fileName = localPath.split('/').pop();
  const ext = getExt(localPath);
  const canPreview = PREVIEWABLE_EXTS.includes(ext);
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

  // 本文の流れの中に置く 1 行の表記（チャットのツール行と同じ作法）: アイコン＋薄いディレクトリ＋ファイル名。
  // 箱・ピンク・常時のボタンは持たず、名前のクリックでプレビュー、レビューはホバーで出す。フルパスは title
  const { dir, name } = splitFilePath(localPath, cwd);
  return (
    <span className={`file-preview-inline${canPreview ? '' : ' disabled'}`} title={localPath}>
      <TbFile className="file-icon" aria-hidden="true" />
      {/* .file-link は p キー（ピック中のファイルを開く）の目印 */}
      <button
        className="file-link"
        onClick={() => canPreview && onOpenPreview?.(localPath)}
        aria-label={`${fileName} をプレビュー`}
      >
        {dir && <span className="file-dir">{dir}</span>}
        <span className="file-name">{name || fileName}</span>
      </button>
      {canPreview && onOpenFileReview && (
        <button className="file-btn-review" onClick={() => onOpenFileReview(localPath)}>
          <span className="file-btn-review-label">レビュー</span>
        </button>
      )}
    </span>
  );
}
