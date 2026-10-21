import { useEffect, useMemo, useRef, useState } from 'react';
import { filesToMarkdown, isModified, relativeToCwd } from '../utils/sessionFiles.js';
import './FileList.css';

// 「コピーしました」を出しておく時間
const COPIED_RESET_MS = 1500;

// 変更 = edit / write / artifact が 1 以上、参照のみ = read だけ
const OP_FILTERS = [
  { value: 'all', label: 'すべて', test: () => true },
  { value: 'modified', label: '変更', test: (f) => isModified(f) },
  { value: 'readonly', label: '参照のみ', test: (f) => !isModified(f) },
];

// op バッジ（0 のものは出さない）
const OP_BADGES = [
  { key: 'read', label: '読' },
  { key: 'edit', label: '編集' },
  { key: 'write', label: '作成' },
  { key: 'artifact', label: 'Artifact' },
];

function splitPath(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? { dir: '', name: relPath } : { dir: relPath.slice(0, i), name: relPath.slice(i + 1) };
}

// セッション中に Claude が触ったファイルの一覧の一覧（Refs ドロワーのタブの中身）。
// files は utils/sessionFiles.js の collectSessionFiles() の結果（チャットの messages からクライアント側で抽出したもの）
export default function FileList({ files, cwd, onOpenPreview, onJumpToMessage }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  // 変更 / 参照のみ の絞り込み（その場限りで保存しない）
  const [opFilter, setOpFilter] = useState('all');
  const filterRef = useRef(null);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);


  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const { test } = OP_FILTERS.find((o) => o.value === opFilter) || OP_FILTERS[0];
    return (files || []).filter((f) => test(f) && (!query || f.path.toLowerCase().includes(query)));
  }, [files, filter, opFilter]);

  // トグルに添える件数（文字の絞り込みは反映しない全体の内訳）
  const opCounts = useMemo(() => {
    const counts = {};
    for (const { value, test } of OP_FILTERS) {
      counts[value] = (files || []).filter(test).length;
    }
    return counts;
  }, [files]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(filesToMarkdown(visibleFiles, cwd));
      setCopied(true);
    } catch (err) {
      console.warn('[FileList] クリップボードへのコピーに失敗しました', err);
    }
  };

  const total = (files || []).length;

  return (
    <>
        <div className="file-drawer-toolbar">
          <input
            ref={filterRef}
            className="file-drawer-filter"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="パスで絞り込み"
          />
          <button className="file-drawer-copy" onClick={handleCopy} disabled={visibleFiles.length === 0}>
            {copied ? 'コピーしました' : 'パスをコピー'}
          </button>
        </div>

        <div className="file-drawer-ops">
          {OP_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              className={`file-op-toggle ${opFilter === value ? 'active' : ''}`}
              onClick={() => setOpFilter(value)}
              aria-pressed={opFilter === value}
            >
              {label} {opCounts[value]}
            </button>
          ))}
        </div>

        <div className="file-drawer-body">
          {total === 0 ? (
            <div className="file-drawer-empty">ファイルはまだありません</div>
          ) : visibleFiles.length === 0 ? (
            <div className="file-drawer-empty">一致するファイルはありません</div>
          ) : (
            visibleFiles.map((file) => {
              const { dir, name } = splitPath(relativeToCwd(file.path, cwd));
              return (
                <div className="file-row" key={file.path}>
                  <div className="file-row-main">
                    <button
                      className="file-row-name"
                      title={file.path}
                      onClick={() => {
                        onOpenPreview(file.path);
                      }}
                    >
                      {name}
                    </button>
                    {dir && (
                      <div className="file-row-dir" title={file.path}>
                        {dir}
                      </div>
                    )}
                    <div className="file-row-meta">
                      {OP_BADGES.filter(({ key }) => file.ops[key] > 0).map(({ key, label }) => (
                        <span className="file-badge" key={key}>
                          {label} ×{file.ops[key]}
                        </span>
                      ))}
                    </div>
                  </div>
                  {file.lastUuid && (
                    <button className="file-row-jump" onClick={() => onJumpToMessage(file.lastUuid)}>
                      会話へ
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
    </>
  );
}
