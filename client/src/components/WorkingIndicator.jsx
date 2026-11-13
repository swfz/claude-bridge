import { useEffect, useState } from 'react';
import { backgroundLabel, formatElapsed, workingStateOf } from '../utils/working.js';
import { toolDescription } from '../utils/toolLines.js';
import './WorkingIndicator.css';

// 本家 TUI の「✻ Thinking…」に相当する、入力欄の直上の 1 行。
// 記号の明滅と経過時間で「今まさに推論・実行している」ことを示す。
// ターンが終わっても裏でサブエージェント・シェルが動いている間（status: 'shell'）は「裏で実行中…」を出す。
// 行は常に置き、高さは CSS で固定する（記号の字形で行の高さが揺れないようにも）
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export default function WorkingIndicator({ status, waitingFor, messages, pendingSince, runningAgents, runningShells }) {
  const [now, setNow] = useState(() => Date.now());
  const state = workingStateOf({
    status,
    waitingFor,
    messages,
    pendingSince,
    background: { agents: runningAgents, shells: runningShells },
    now,
  });
  // 時刻を進める（記号の明滅・経過時間の更新）のは動かすときだけ
  const ticking = !!state?.animated;

  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, [ticking]);

  // 出ていないときも同じ高さの空の行を置く（出し入れでチャット欄の高さが変わり、本文が上下に動くのを防ぐ）
  if (!state) return <div className="working-indicator working-idle" role="status" aria-live="polite" />;
  const glyph = state.animated ? GLYPHS[Math.floor(now / 150) % GLYPHS.length] : GLYPHS[0];
  const toolName = state.tool?.name;
  const isBackground = state.mode === 'background';
  const detail = isBackground ? backgroundLabel(state.background) : state.tool ? toolDescription(state.tool) : '';
  const label = isBackground ? '裏で実行中…' : toolName ? `${toolName} 実行中…` : '考え中…';
  const elapsed = state.since != null ? formatElapsed(now - state.since) : '';

  return (
    <div
      className={`working-indicator${isBackground ? ' working-background' : ''}${state.animated ? '' : ' working-static'}`}
      role="status"
      aria-live="polite"
      title={detail || label}
    >
      <span className="working-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="working-label">{label}</span>
      {detail && detail !== toolName && <span className="working-detail">{detail}</span>}
      {elapsed && (
        <span className="working-elapsed" aria-hidden="true">
          {elapsed}
        </span>
      )}
    </div>
  );
}
