import { useEffect, useRef, useState } from 'react';
import { TbBell, TbBellOff, TbDots, TbEye, TbEyeOff, TbMoon, TbSun } from 'react-icons/tb';
import { parseCwd } from '../utils/cwdLabel.js';
import UsageMeter from './UsageMeter.jsx';
import './TopBar.css';

// 「…」メニュー（設定）。外側クリック・Esc で閉じる
function MoreMenu({ appTheme, onToggleTheme }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const dark = appTheme !== 'light';
  return (
    <div className="topbar-more" ref={rootRef}>
      <button
        type="button"
        className={`topbar-icon-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="その他の設定"
        aria-expanded={open}
        title="その他の設定"
      >
        <TbDots />
      </button>
      {open && (
        <div className="topbar-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="topbar-menu-item"
            onClick={() => {
              onToggleTheme();
              setOpen(false);
            }}
          >
            {dark ? <TbSun /> : <TbMoon />}
            {dark ? 'ライトテーマにする' : 'ダークテーマにする'}
          </button>
        </div>
      )}
    </div>
  );
}

// 今見ているセッション。ディレクトリ色のドット＋リポジトリ名＋タイトル 1 行（フルパスは tooltip）
function CurrentSession({ session }) {
  if (!session) return null;
  const { project } = parseCwd(session.cwd);
  return (
    <div className="topbar-current" title={[session.title, session.cwd].filter(Boolean).join('\n')}>
      <span
        className={`topbar-dir-dot${session.color ? '' : ' none'}`}
        style={session.color ? { background: session.color } : undefined}
      />
      {project && <span className="topbar-current-dir">{project}</span>}
      <span className="topbar-current-title">{session.title}</span>
    </div>
  );
}

// アプリのトップバー。要素を性質ごとにまとめて並べる:
// 左＝接続状態のドット・ブランド名・今のセッション / 中央＝表示の切り替え・パネルのタブ /
// 右＝使用量・モード（共有・通知）・「…」メニュー。
// panels は [{key, label, icon, active, onClick, count, title}]（App 側で出し分ける）
export default function TopBar({
  connected,
  currentSession,
  viewMode,
  onChangeViewMode,
  panels,
  contextUsage,
  rateLimits,
  shareMode,
  onToggleShareMode,
  hiddenCount,
  notifySupported,
  notifyEnabled,
  onToggleNotify,
  appTheme,
  onToggleTheme,
}) {
  return (
    <>
      <header className={`app-header${shareMode ? ' share-on' : ''}`}>
        <div className="topbar-left">
          {/* 接続中は緑の点だけ、切断時だけ赤＋文字（.connection-status は E2E の目印） */}
          <div
            className={`connection-status ${connected ? 'connected' : 'disconnected'}`}
            title={connected ? 'サーバーに接続中' : 'サーバーとの接続が切れています'}
          >
            <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
            {!connected && <span className="connection-label">Disconnected</span>}
          </div>
          <h1 className="app-title">Claude Bridge</h1>
          <CurrentSession session={currentSession} />
        </div>

        <div className="header-controls">
          {onChangeViewMode && (
            <div className="view-toggle" role="group" aria-label="表示の切り替え">
              <button
                className={`toggle-btn ${viewMode === 'raw' ? 'active' : ''}`}
                onClick={() => onChangeViewMode('raw')}
                aria-pressed={viewMode === 'raw'}
              >
                Raw
              </button>
              <button
                className={`toggle-btn ${viewMode === 'chat' ? 'active' : ''}`}
                onClick={() => onChangeViewMode('chat')}
                aria-pressed={viewMode === 'chat'}
              >
                Chat
              </button>
            </div>
          )}
          {panels.length > 0 && (
            <nav className="topbar-panels" aria-label="パネル">
              {panels.map(({ key, label, icon: Icon, active, onClick, count, title }) => (
                <button
                  key={key}
                  className={`panel-tab${active ? ' active' : ''}`}
                  onClick={onClick}
                  title={title}
                  aria-pressed={!!active}
                >
                  {Icon && <Icon className="panel-tab-icon" aria-hidden="true" />}
                  {label}
                  {count > 0 && <span className="panel-tab-count">{count}</span>}
                </button>
              ))}
            </nav>
          )}
        </div>

        <div className="topbar-right">
          <UsageMeter contextUsage={contextUsage} rateLimits={rateLimits} />
          <div className="topbar-modes">
            <button
              type="button"
              role="switch"
              aria-checked={shareMode}
              className={`mode-toggle share-toggle${shareMode ? ' on' : ''}`}
              onClick={onToggleShareMode}
              title={`共有モード: ロック付き（センシティブ指定）のセッションを画面から隠す（Alt+Shift+S）\n現在: ${shareMode ? 'オン' : 'オフ'}`}
            >
              {shareMode ? <TbEyeOff aria-hidden="true" /> : <TbEye aria-hidden="true" />}
              <span>共有モード</span>
              <span className="mode-switch" aria-hidden="true" />
            </button>
            {notifySupported && (
              <button
                type="button"
                role="switch"
                aria-checked={notifyEnabled}
                aria-label="ターン終了時にデスクトップ通知"
                className={`topbar-icon-btn notify-toggle${notifyEnabled ? ' on' : ''}`}
                onClick={onToggleNotify}
                title={`ターン終了時にデスクトップ通知\n現在: ${notifyEnabled ? 'オン' : 'オフ'}`}
              >
                {notifyEnabled ? <TbBell /> : <TbBellOff />}
              </button>
            )}
          </div>
          <MoreMenu appTheme={appTheme} onToggleTheme={onToggleTheme} />
        </div>
      </header>
      {shareMode && (
        <div className="share-band" role="status">
          <TbEyeOff aria-hidden="true" />
          <span>共有モード中：ロック付きのセッション {hiddenCount} 件を非表示にしています</span>
          <button type="button" className="share-band-off" onClick={onToggleShareMode}>
            解除
          </button>
        </div>
      )}
    </>
  );
}
