import { useMemo, useState } from 'react';
import { resolvePins } from '../utils/pins.js';
import { MarkdownContent } from './ChatView.jsx';
import './PinList.css';

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const LONG_CHARS = 400;
const LONG_LINES = 8;

function isLong(content) {
  return content.length > LONG_CHARS || content.split('\n').length - 1 > LONG_LINES;
}

function PinRow({ pin, cwd, onOpenPreview, onJumpToMessage, onUnpin }) {
  const [expanded, setExpanded] = useState(false);
  const hasBody = pin.loaded && !!pin.content;
  const long = hasBody && isLong(pin.content);

  return (
    <div className="pin-row">
      <div className="pin-row-main">
        <div className="pin-row-meta">
          <span className="pin-row-role">{pin.label || (pin.role === 'human' ? 'You' : 'Claude')}</span>
          <span className="pin-row-time">{formatTime(pin.messageTimestamp || pin.pinnedAt)}</span>
          {!pin.loaded && (
            <span className="pin-row-badge" title="このメッセージは今の表示に読み込まれていません">
              未読込
            </span>
          )}
        </div>
        {hasBody ? (
          <>
            <div className={`chat-message-body pin-row-body ${long && !expanded ? 'pin-collapsed' : ''}`}>
              <MarkdownContent
                content={pin.content}
                sessionCwd={cwd}
                onOpenPreview={onOpenPreview}
                onOpenFileReview={null}
              />
            </div>
            {long && (
              <button className="pin-row-expand" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '折りたたむ' : '全文表示'}
              </button>
            )}
          </>
        ) : (
          <div className="pin-row-excerpt">{pin.excerpt || '（本文なし）'}</div>
        )}
      </div>
      <div className="pin-row-actions">
        {pin.loaded && (
          <button className="pin-row-jump" onClick={() => onJumpToMessage(pin.messageUuid)}>
            会話へ
          </button>
        )}
        <button className="pin-row-unpin" onClick={() => onUnpin(pin.messageUuid)} title="ピンを外す">
          外す
        </button>
      </div>
    </div>
  );
}

// Refs ドロワーの「ピン」タブの中身。メッセージヘッダの 📌 で留めたものを会話の順に並べる。
// 外枠（overlay・Esc・タブ）は RefDrawer
export default function PinList({ pins, messages, cwd, onOpenPreview, onJumpToMessage, onUnpin }) {
  const items = useMemo(() => resolvePins(pins, messages), [pins, messages]);

  return (
    <div className="pin-drawer-body">
      {items.length === 0 ? (
        <div className="pin-drawer-empty">
          ピンはまだありません。メッセージ見出しの 📌 で、後から見返したい返答を留められます
        </div>
      ) : (
        items.map((pin) => (
          <PinRow
            key={pin.messageUuid}
            pin={pin}
            cwd={cwd}
            onOpenPreview={onOpenPreview}
            onJumpToMessage={onJumpToMessage}
            onUnpin={onUnpin}
          />
        ))
      )}
    </div>
  );
}
