import { useEffect, useState } from 'react';
import { TbChevronDown, TbChevronRight, TbRefresh } from 'react-icons/tb';
import {
  DIFF_SCOPES,
  absolutePath,
  diffStatusLabel,
  patchBodyLines,
  shouldCollapseFile,
  splitPath,
  summarizeDiff,
} from '../utils/diffView.js';
import './DiffDrawer.css';

// 入力欄の /diff で開く差分ドロワー。Claude Code の /diff は TUI 内のモーダルで
// ブラウザからは見えないので、ブリッジがサーバーで git diff を取って出す。
// data: { loading, files, truncated, error, root, outside } | null
export default function DiffDrawer({ scope, data, onChangeScope, onRefresh, onOpenPreview, onClose }) {
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const files = data?.files || [];
  const summary = summarizeDiff(files);

  return (
    <div className="diff-drawer-overlay" onClick={onClose}>
      <div className="diff-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="diff-drawer-header">
          <div className="diff-drawer-title-area">
            <span className="diff-drawer-title">未コミットの差分</span>
            <div className="diff-drawer-meta">
              {!data?.loading && !data?.error && (
                <span className="diff-drawer-summary">
                  {summary.changed} ファイル <span className="diff-add">+{summary.additions}</span>{' '}
                  <span className="diff-del">−{summary.deletions}</span>
                </span>
              )}
              {data?.root && (
                <span className="diff-drawer-root" title={data.root}>
                  {data.root.split('/').pop()}
                </span>
              )}
            </div>
          </div>
          <div className="diff-drawer-scope" role="group" aria-label="差分の範囲">
            {DIFF_SCOPES.map((s) => (
              <button
                key={s.value}
                className={`diff-scope-btn${scope === s.value ? ' active' : ''}`}
                onClick={() => onChangeScope(s.value)}
                aria-pressed={scope === s.value}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button className="diff-drawer-icon" onClick={onRefresh} title="取り直す" aria-label="取り直す">
            <TbRefresh aria-hidden="true" />
          </button>
          <button className="diff-drawer-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="diff-drawer-body">
          {data?.loading && <div className="diff-drawer-empty">読み込み中...</div>}
          {data?.error && <div className="diff-drawer-error">{data.error}</div>}
          {!data?.loading && !data?.error && files.length === 0 && (
            <div className="diff-drawer-empty">
              {scope === 'session' ? 'このセッションで編集したファイルはありません' : '未コミットの変更はありません'}
            </div>
          )}
          {!data?.loading && data?.outside > 0 && (
            <div className="diff-drawer-note">リポジトリ外のファイル {data.outside} 件は対象外です</div>
          )}
          {!data?.loading &&
            files.map((file) => (
              <DiffFile key={`${scope}:${file.path}`} file={file} root={data.root} onOpenPreview={onOpenPreview} />
            ))}
          {data?.truncated && (
            <div className="diff-drawer-note">差分が大きいため、一部のファイルは中身を省略しています</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffFile({ file, root, onOpenPreview }) {
  const [open, setOpen] = useState(() => !shouldCollapseFile(file));
  const label = diffStatusLabel(file.status);
  const { dir, name } = splitPath(file.path);
  const lines = open ? patchBodyLines(file.patch) : [];
  const noChange = file.status === 'committed' || file.status === 'missing';
  const previewPath = file.status === 'deleted' || file.status === 'missing' ? null : absolutePath(root, file.path);

  return (
    <div className={`diff-file${noChange ? ' no-change' : ''}`}>
      <div className="diff-file-header">
        <button
          className="diff-file-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={noChange}
          aria-expanded={open}
          aria-label={open ? '畳む' : '開く'}
        >
          {open ? <TbChevronDown aria-hidden="true" /> : <TbChevronRight aria-hidden="true" />}
        </button>
        <button
          className="diff-file-path"
          onClick={() => previewPath && onOpenPreview(previewPath)}
          disabled={!previewPath}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          <span className="diff-file-dir">{dir}</span>
          <span className="diff-file-name">{name}</span>
        </button>
        {label && <span className="diff-file-label">{label}</span>}
        {!noChange && (
          <span className="diff-file-stat">
            <span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span>
          </span>
        )}
      </div>
      {open && !noChange && (
        <div className="diff-file-body">
          {file.symlink ? (
            <div className="diff-file-note">シンボリックリンク（リンク先の中身は表示しません）</div>
          ) : file.sensitive ? (
            <div className="diff-file-note">資格情報の置き場のため中身は表示しません</div>
          ) : file.binary ? (
            <div className="diff-file-note">バイナリファイル</div>
          ) : file.tooLarge ? (
            <div className="diff-file-note">差分が大きいため省略しました</div>
          ) : lines.length === 0 ? (
            <div className="diff-file-note">中身の差分はありません（モードや名前の変更のみ）</div>
          ) : (
            <pre className="diff-lines">
              {lines.map((line, i) => (
                <div key={i} className={`diff-line ${line.kind}`}>
                  {line.text || ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
