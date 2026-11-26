import { useEffect, useState } from 'react';
import { TbFile } from 'react-icons/tb';
import { PREVIEWABLE_EXTS, getExt } from '../utils/previewExts.js';
import { lineSuffix } from '../utils/fileLineRef.js';
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

// line（と endLine）を渡すと `path:行` のピルになり、名前のクリックで差分ドロワーのその行へ飛ぶ（onOpenDiffAt）。
// 行が無いピル・onOpenDiffAt が無い場所（ドロワーの外の描画）では従来どおりプレビューを開く。
// bare は地の文に裸で書かれていたもの（remarkFileLineRefs）で、ファイルが無ければ code ではなく素の文字（raw）に戻す
export default function FilePreview({
  href,
  cwd,
  line,
  endLine,
  bare,
  raw,
  onOpenPreview,
  onOpenFileReview,
  onOpenDiffAt,
}) {
  const localPath = extractLocalPath(href);
  const fileName = localPath.split('/').pop();
  const ext = getExt(localPath);
  const canPreview = PREVIEWABLE_EXTS.includes(ext);
  const [exists, setExists] = useState(null);
  const hasLine = Number.isInteger(line) && line > 0;
  const jumps = hasLine && !!onOpenDiffAt;

  useEffect(() => {
    let cancelled = false;
    checkFileExists(localPath).then((ok) => {
      if (!cancelled) setExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [localPath]);

  // 地の文から拾ったもの（bare）は、存在すると分かるまで素の文字で出す（「Node.js:18 以上」のような誤検出が
  // ピル → 素の文字と変わって折り返しが動かないように。インラインコードの経路は従来どおり先にピルで出す）
  if (bare && exists !== true) return <>{raw}</>;
  // 存在しないパスはプレビュー不可として扱う（Claude の地の文中の略称ファイル名など）
  if (exists === false) {
    return <code className="inline-code">{hasLine ? `${fileName}${lineSuffix({ line, endLine })}` : fileName}</code>;
  }

  const handleClick = () => {
    if (jumps) onOpenDiffAt({ path: localPath, line, endLine: endLine || null });
    else if (canPreview) onOpenPreview?.(localPath);
  };

  // 本文の流れの中に置く 1 行の表記（チャットのツール行と同じ作法）: アイコン＋薄いディレクトリ＋ファイル名。
  // 箱・ピンク・常時のボタンは持たず、名前のクリックでプレビュー（行付きなら差分のその行）、レビューはホバーで出す。
  // フルパスは title
  const { dir, name } = splitFilePath(localPath, cwd);
  const suffix = hasLine ? lineSuffix({ line, endLine }) : '';
  return (
    <span
      className={`file-preview-inline${canPreview || jumps ? '' : ' disabled'}`}
      title={jumps ? `${localPath}${suffix}（クリックで差分のこの行へ）` : localPath}
    >
      <TbFile className="file-icon" aria-hidden="true" />
      {/* .file-link は p キー（ピック中のファイルを開く）の目印。行付きなら差分へ飛ぶ */}
      <button
        className="file-link"
        onClick={handleClick}
        data-line={hasLine ? line : undefined}
        aria-label={jumps ? `${fileName}${suffix} を差分で開く` : `${fileName} をプレビュー`}
      >
        {dir && <span className="file-dir">{dir}</span>}
        <span className="file-name">{name || fileName}</span>
        {suffix && <span className="file-line">{suffix}</span>}
      </button>
      {canPreview && onOpenFileReview && (
        <button className="file-btn-review" onClick={() => onOpenFileReview(localPath)}>
          <span className="file-btn-review-label">レビュー</span>
        </button>
      )}
    </span>
  );
}
