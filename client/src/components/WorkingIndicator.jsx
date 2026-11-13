import { useEffect, useState } from 'react';
import { formatElapsed, workingStateOf } from '../utils/working.js';
import { toolDescription } from '../utils/toolLines.js';
import './WorkingIndicator.css';

// 本家 TUI の「✻ Thinking…」に相当する、入力欄の直上の 1 行。
// 記号の明滅と経過時間で「今まさに推論・実行している」ことを示す
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export default function WorkingIndicator({ status, waitingFor, messages, pendingSince }) {
  const [now, setNow] = useState(() => Date.now());
  const state = workingStateOf({ status, waitingFor, messages, pendingSince, now });
  const visible = !!state;

  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, [visible]);

  if (!state) return null;
  const glyph = GLYPHS[Math.floor(now / 150) % GLYPHS.length];
  const toolName = state.tool?.name;
  const detail = state.tool ? toolDescription(state.tool) : '';
  const label = toolName ? `${toolName} 実行中…` : '考え中…';
  const elapsed = state.since != null ? formatElapsed(now - state.since) : '';

  return (
    <div className="working-indicator" role="status" aria-live="polite" title={detail || label}>
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
