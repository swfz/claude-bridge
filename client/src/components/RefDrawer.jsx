import { useCallback, useEffect, useState } from 'react';
import LinkList from './LinkList.jsx';
import FileList from './FileList.jsx';
import PinList from './PinList.jsx';
import './RefDrawer.css';

const TAB_STORAGE_KEY = 'refDrawerTab';
const TABS = ['links', 'files', 'pins'];

function loadTab() {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (TABS.includes(saved)) return saved;
  } catch {
    // localStorage が使えなくても既定で動く
  }
  return 'links';
}

// このセッションでやり取りしたリンク・ファイルと、ピン留めしたメッセージを右サイドのドロワーで見せる（ヘッダの「Refs」トグル）。
// 外枠（overlay・Esc・ヘッダのタブ）だけを持ち、中身は LinkList / FileList / PinList に任せる。
// links / files は App がチャットの messages からクライアント側で抽出したもの。pins はサーバー保存分
export default function RefDrawer({
  links,
  files,
  pins,
  messages,
  cwd,
  onOpenPreview,
  onJumpToMessage,
  onUnpin,
  onClose,
}) {
  const [tab, setTab] = useState(loadTab);

  const selectTab = useCallback((next) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // 保存できなくても表示には影響しない
    }
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

  // ファイル名のクリックはプレビューを開く（ドロワーは閉じる）
  const handleOpenPreview = useCallback(
    (path) => {
      onOpenPreview(path);
      onClose();
    },
    [onOpenPreview, onClose],
  );

  const linkCount = (links || []).length;
  const fileCount = (files || []).length;
  const pinCount = (pins || []).length;

  return (
    <div className="ref-drawer-overlay" onClick={onClose}>
      <div className="ref-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ref-drawer-header">
          <div className="ref-drawer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'links'}
              className={`ref-drawer-tab ${tab === 'links' ? 'active' : ''}`}
              onClick={() => selectTab('links')}
            >
              リンク {linkCount}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'files'}
              className={`ref-drawer-tab ${tab === 'files' ? 'active' : ''}`}
              onClick={() => selectTab('files')}
            >
              ファイル {fileCount}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'pins'}
              className={`ref-drawer-tab ${tab === 'pins' ? 'active' : ''}`}
              onClick={() => selectTab('pins')}
            >
              ピン {pinCount}
            </button>
          </div>
          <button className="ref-drawer-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        {tab === 'links' && <LinkList links={links} onJumpToMessage={onJumpToMessage} />}
        {tab === 'files' && (
          <FileList files={files} cwd={cwd} onOpenPreview={handleOpenPreview} onJumpToMessage={onJumpToMessage} />
        )}
        {tab === 'pins' && (
          <PinList pins={pins} messages={messages} onJumpToMessage={onJumpToMessage} onUnpin={onUnpin} />
        )}
      </div>
    </div>
  );
}
