import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TbMessage, TbSparkles, TbUser } from 'react-icons/tb';
import { peekPosition } from '../utils/recentPeek.js';
import { formatTurnTime } from '../utils/sessionTurns.js';
import './RecentPeek.css';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;

// ホームの行リストに置く「直近のやりとり」アイコン。ホバーで直近 3 往復をポップオーバーに出す。
// - データ（data = {exchanges, error} | undefined）は開いたときだけ onRequest で取りに行く
//   （一覧を描いた時点で全行分取りに行かない）。undefined は読み込み中の意味
// - ポップオーバーは document.body に portal で出す。.home-rows は overflow: clip で
//   sticky ヘッダーもあるので、行の中に置くと切れる・隠れる
// - portal でも React のイベントは行まで伝播し、行の onClick でセッションが開いてしまうので
//   アイコンとポップオーバー上の click / mousedown は止める
export default function RecentPeek({ data, onRequest }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const popRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  // 親は行ごとに inline の関数を渡すので、最新のものを ref で持つ（effect の依存にしない）
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
    setPos(null);
  }, []);

  useEffect(() => clearTimers, []);

  // 開いた時点で取りに行く（キャッシュの判断は親側）
  useEffect(() => {
    if (open) onRequestRef.current?.();
  }, [open]);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const pop = popRef.current;
    if (!button || !pop) return;
    const anchor = button.getBoundingClientRect();
    const size = pop.getBoundingClientRect();
    setPos(
      peekPosition(
        anchor,
        { width: size.width, height: size.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);

  // 中身（読み込み中 → 本文）で高さが変わるので、データが届くたびに測り直す
  useLayoutEffect(() => {
    if (open) place();
  }, [open, data, place]);

  // スクロール・リサイズではアイコンについていく。固定表示中の外側クリックと Esc で閉じる
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    // 別の行のアイコンは mousedown を止めるので、capture で拾う
    const onDown = (e) => {
      if (!pinned) return;
      if (buttonRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [open, pinned, place, close]);

  const handleEnter = () => {
    clearTimeout(closeTimer.current);
    if (open) return;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };

  const handleLeave = () => {
    clearTimeout(openTimer.current);
    if (pinned) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (pinned) {
      close();
      return;
    }
    clearTimers();
    setOpen(true);
    setPinned(true);
  };

  const stop = (e) => e.stopPropagation();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`recent-peek-button ${open ? 'open' : ''} ${pinned ? 'pinned' : ''}`}
        aria-label="直近のやりとり"
        aria-expanded={open}
        title="直近のやりとり"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onMouseDown={stop}
        onClick={handleClick}
      >
        <TbMessage aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`recent-peek ${pinned ? 'pinned' : ''}`}
            role="dialog"
            aria-label="直近のやりとり"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
            onMouseDown={stop}
            onClick={stop}
          >
            <div className="recent-peek-header">
              <span>直近のやりとり</span>
              {pinned && (
                <button type="button" className="recent-peek-close" aria-label="閉じる" onClick={close}>
                  ×
                </button>
              )}
            </div>
            <RecentPeekBody data={data} />
          </div>,
          document.body,
        )}
    </>
  );
}

function RecentPeekBody({ data }) {
  if (!data) return <p className="recent-peek-status">読み込み中…</p>;
  if (data.error) return <p className="recent-peek-status error">{data.error}</p>;
  const exchanges = data.exchanges || [];
  if (exchanges.length === 0) return <p className="recent-peek-status">やりとりがありません</p>;
  let previous = null;
  // 日付は直前の時刻と変わったときだけ付ける（formatTurnTime と同じ流儀）
  const timeOf = (iso) => {
    if (!iso) return '';
    const label = formatTurnTime(iso, previous);
    previous = iso;
    return label;
  };
  return (
    <div className="recent-peek-list">
      {exchanges.map((ex, i) => {
        const promptAt = timeOf(ex.promptAt);
        const replyAt = timeOf(ex.replyAt);
        return (
          <div key={`${ex.promptAt}-${i}`} className="recent-peek-exchange">
            <div className="recent-peek-turn user">
              <div className="recent-peek-meta">
                <span className="recent-peek-who">
                  <TbUser aria-hidden="true" />
                  You
                </span>
                {promptAt && <span> · {promptAt}</span>}
              </div>
              <div className="recent-peek-text">
                {ex.prompt}
                {ex.promptTruncated && <span className="recent-peek-more">…（続きはセッションで）</span>}
              </div>
            </div>
            <div className="recent-peek-turn claude">
              <div className="recent-peek-meta">
                <span className="recent-peek-who">
                  <TbSparkles aria-hidden="true" />
                  Claude
                </span>
                {replyAt && <span> · {replyAt}</span>}
                {ex.toolCount > 0 && <span className="recent-peek-tools">ツール {ex.toolCount} 回</span>}
              </div>
              {ex.reply ? (
                <div className="recent-peek-text">
                  {ex.reply}
                  {ex.replyTruncated && <span className="recent-peek-more">…（続きはセッションで）</span>}
                </div>
              ) : (
                <div className="recent-peek-text empty">（応答なし）</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
