import { useMemo } from 'react';
import { resolvePins } from '../utils/pins.js';
import './PinList.css';

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Refs ドロワーの「ピン」タブの中身。メッセージヘッダの 📌 で留めたものを会話の順に並べる。
// 外枠（overlay・Esc・タブ）は RefDrawer
export default function PinList({ pins, messages, onJumpToMessage, onUnpin }) {
  const items = useMemo(() => resolvePins(pins, messages), [pins, messages]);

  return (
    <div className="pin-drawer-body">
      {items.length === 0 ? (
        <div className="pin-drawer-empty">
          ピンはまだありません。メッセージ見出しの 📌 で、後から見返したい返答を留められます
        </div>
      ) : (
        items.map((pin) => (
          <div className="pin-row" key={pin.messageUuid}>
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
              <div className="pin-row-excerpt">{pin.excerpt || '（本文なし）'}</div>
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
        ))
      )}
    </div>
  );
}
