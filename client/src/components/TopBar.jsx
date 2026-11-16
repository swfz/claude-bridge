import { useEffect, useRef, useState } from 'react';
import { TbBell, TbBellOff, TbCheck, TbEye, TbEyeOff, TbMoon, TbSun } from 'react-icons/tb';
import { parseCwd } from '../utils/cwdLabel.js';
import UsageMeter from './UsageMeter.jsx';
import './TopBar.css';

// テーマの切り替え。メニューに挟まずアイコン 1 つで切り替える（今がダークなら太陽＝ライトへ）
function ThemeToggle({ appTheme, onToggleTheme }) {
  const dark = appTheme !== 'light';
  const label = dark ? 'ライトテーマにする' : 'ダークテーマにする';
  return (
    <button
      type="button"
      className="topbar-icon-btn theme-toggle"
      onClick={onToggleTheme}
      aria-label={label}
      title={label}
    >
      {dark ? <TbSun /> : <TbMoon />}
    </button>
  );
}

const COPIED_MS = 1500;

// claude の session ID（先頭 8 文字だけ薄く出し、クリックで全文をコピー）。
// `claude --resume <id>` や新規作成ダイアログの ID 検索に貼るため。
// コピー済みの印は同じ幅の中で文字と入れ替えるだけにして、隣を押し動かさない
function SessionIdCopy({ id }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => {
    setCopied(false);
  }, [id]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (err) {
      console.warn('[copy] failed', err);
    }
  };

  const label = `session ID: ${id}（クリックでコピー）`;
  return (
    <button type="button" className="topbar-session-id" onClick={handleCopy} title={label} aria-label={label}>
      <span className={copied ? 'topbar-session-id-text hidden' : 'topbar-session-id-text'}>{id.slice(0, 8)}</span>
      {copied && <TbCheck className="topbar-session-id-copied" aria-hidden />}
    </button>
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
      {session.claudeSessionId && <SessionIdCopy id={session.claudeSessionId} />}
    </div>
  );
}

// アプリのトップバー。要素を性質ごとにまとめて並べる:
// 左＝接続状態のドット・ブランド名・今のセッション / 中央＝表示の切り替え・パネルのタブ /
// 右＝使用量・モード（共有・通知）・テーマ切り替え。
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
          <ThemeToggle appTheme={appTheme} onToggleTheme={onToggleTheme} />
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
