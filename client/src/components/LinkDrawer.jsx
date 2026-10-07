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
  // タスク通知・system-reminder などのタグ注入、isMeta の user レコード
  if (source === 'system') return '通知';
  if (source.startsWith('tool:')) return source.slice('tool:'.length);
  return source;
}

// 行頭アイコンと絞り込みトグルの文言（origin は collectLinks() が最初の出現から決める）
const ORIGIN_ICONS = {
  user: { icon: '👤', title: '自分が渡した' },
  claude: { icon: '🤖', title: 'Claude が探した' },
};
const ORIGIN_FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'user', label: '自分' },
  { value: 'claude', label: 'Claude' },
];

function matchesFilter(link, query, origin = 'all') {
  if (origin !== 'all' && link.origin !== origin) return false;
  if (!query) return true;
  return [link.url, link.label, link.title, link.context, link.host].some((v) =>
    (v || '').toLowerCase().includes(query),
  );
}

// WebFetch の HTTP ステータスが 2xx 以外（リダイレクト等）か
function isNonOkStatus(code) {
  return typeof code === 'number' && (code < 200 || code >= 300);
}

// セッション内でやり取りされた URL の一覧を右サイドのドロワーで見せる。
// links は utils/links.js の collectLinks() の結果（チャットの messages からクライアント側で抽出したもの）。
// 各行はアンカー（label → WebFetch のタイトル → URL）、その下に URL が出てきた行の文脈、meta 行の順
export default function LinkDrawer({ links, onJumpToMessage, onClose }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  // 自分が渡した / Claude が探した の絞り込み（その場限りで保存しない）
  const [origin, setOrigin] = useState('all');
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
    return (links || []).filter((link) => matchesFilter(link, query, origin));
  }, [links, filter, origin]);

  // トグルに添える件数（文字の絞り込みは反映しない全体の内訳）
  const originCounts = useMemo(() => {
    const counts = { all: 0, user: 0, claude: 0 };
    for (const link of links || []) {
      counts.all += 1;
      if (counts[link.origin] !== undefined) counts[link.origin] += 1;
    }
    return counts;
  }, [links]);

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
            placeholder="URL / ラベル / タイトル / 文脈で絞り込み"
          />
          <button className="link-drawer-copy" onClick={handleCopy} disabled={visibleLinks.length === 0}>
            {copied ? 'コピーしました' : 'Markdown でコピー'}
          </button>
        </div>

        <div className="link-drawer-origin">
          {ORIGIN_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              className={`link-origin-toggle ${origin === value ? 'active' : ''}`}
              onClick={() => setOrigin(value)}
              aria-pressed={origin === value}
            >
              {label} {originCounts[value]}
            </button>
          ))}
        </div>

        <div className="link-drawer-body">
          {total === 0 ? (
            <div className="link-drawer-empty">リンクはまだありません</div>
          ) : visibleLinks.length === 0 ? (
            <div className="link-drawer-empty">一致するリンクはありません</div>
          ) : (
            visibleLinks.map((link) => (
              <div className="link-row" key={link.url}>
                <span className="link-row-icon" title={(ORIGIN_ICONS[link.origin] || ORIGIN_ICONS.claude).title}>
                  {(ORIGIN_ICONS[link.origin] || ORIGIN_ICONS.claude).icon}
                </span>
                <div className="link-row-main">
                  <a
                    className="link-row-anchor"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={link.url}
                  >
                    {link.label || link.title || link.url}
                  </a>
                  {link.context && (
                    <div className="link-row-context" title={link.context}>
                      {link.context}
                    </div>
                  )}
                  <div className="link-row-meta">
                    {link.host && <span className="link-row-host">{link.host}</span>}
                    {/* label がアンカーを占めているときだけ、WebFetch で読んだタイトルを別に出す */}
                    {link.label && link.title && (
                      <span className="link-row-fetched" title={link.title}>
                        🌐 {link.title}
                      </span>
                    )}
                    {isNonOkStatus(link.code) && <span className="link-badge link-badge-http">HTTP {link.code}</span>}
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
