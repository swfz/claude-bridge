import { useEffect, useMemo, useRef, useState } from 'react';
import { linksToMarkdown } from '../utils/links.js';
import './LinkDrawer.css';

// 「コピーしました」を出しておく時間
const COPIED_RESET_MS = 1500;

// sources の値をバッジの文言にする
function sourceLabel(source) {
  if (source === 'human') return '指示';
  if (source === 'assistant') return '応答';
  if (source === 'artifact') return 'Artifact';
  if (source.startsWith('tool:')) return source.slice('tool:'.length);
  return source;
}

function matchesFilter(link, query) {
  if (!query) return true;
  return [link.url, link.label, link.host].some((v) => (v || '').toLowerCase().includes(query));
}

// セッション内でやり取りされた URL の一覧を右サイドのドロワーで見せる。
// links は utils/links.js の collectLinks() の結果（チャットの messages からクライアント側で抽出したもの）
export default function LinkDrawer({ links, onJumpToMessage, onClose }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const filterRef = useRef(null);

  // 開いた直後は絞り込みに入力できるようにする
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  // Escape で閉じる（絞り込み欄にフォーカスがあっても閉じる）
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // コピー表示を戻すタイマー
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const visibleLinks = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (links || []).filter((link) => matchesFilter(link, query));
  }, [links, filter]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linksToMarkdown(visibleLinks));
      setCopied(true);
    } catch (err) {
      console.warn('[LinkDrawer] クリップボードへのコピーに失敗しました', err);
    }
  };

  const total = (links || []).length;

  return (
    <div className="link-drawer-overlay" onClick={onClose}>
      <div className="link-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="link-drawer-header">
          <span className="link-drawer-title">リンク {total} 件</span>
          <button className="link-drawer-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="link-drawer-toolbar">
          <input
            ref={filterRef}
            className="link-drawer-filter"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="URL / ラベル / ホストで絞り込み"
          />
          <button className="link-drawer-copy" onClick={handleCopy} disabled={visibleLinks.length === 0}>
            {copied ? 'コピーしました' : 'Markdown でコピー'}
          </button>
        </div>

        <div className="link-drawer-body">
          {total === 0 ? (
            <div className="link-drawer-empty">リンクはまだありません</div>
          ) : visibleLinks.length === 0 ? (
            <div className="link-drawer-empty">一致するリンクはありません</div>
          ) : (
            visibleLinks.map((link) => (
              <div className="link-row" key={link.url}>
                <span className="link-row-icon">🔗</span>
                <div className="link-row-main">
                  <a
                    className="link-row-anchor"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={link.url}
                  >
                    {link.label || link.url}
                  </a>
                  <div className="link-row-meta">
                    {link.host && <span className="link-row-host">{link.host}</span>}
                    {link.sources.map((source) => (
                      <span className="link-badge" key={source}>
                        {sourceLabel(source)}
                      </span>
                    ))}
                    {link.count > 1 && <span className="link-row-count">×{link.count}</span>}
                  </div>
                </div>
                {link.lastUuid && (
                  <button className="link-row-jump" onClick={() => onJumpToMessage(link.lastUuid)}>
                    会話へ
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
