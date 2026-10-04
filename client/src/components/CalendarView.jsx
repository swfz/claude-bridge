import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLOR_MODES,
  DAY_MS,
  PHASES,
  buildCalendarDays,
  buildLegend,
  earliestOffsetMs,
  formatDayHeader,
  formatHours,
  formatWeekRange,
  phaseOf,
  phaseTotals,
  promptMarkTooltip,
  segmentTooltip,
  shiftWeek,
  startOfWeek,
} from '../utils/calendar.js';
import './CalendarView.css';

const COLOR_MODE_KEY = 'homeCalendarColor';

function loadColorMode() {
  try {
    const saved = localStorage.getItem(COLOR_MODE_KEY);
    return COLOR_MODES.some((m) => m.key === saved) ? saved : 'project';
  } catch {
    return 'project';
  }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pct = (ms) => `${(ms / DAY_MS) * 100}%`;

// 週間カレンダー。縦軸が時刻、横軸が曜日で、セッションの活動区間を帯で並べる。
// 帯は 20 分以上の空きで切れるので、止まっていた区間は空白として見える。
// 帯の左端の点は自分が指示した時刻（分単位）。点の無い区間は Claude が自走していた時間。
// 重なったセッションは横に並べる（並行作業）。
// 色はプロジェクトごとか、10 分枠ごとの「調査 / 実装 / 対話」かを切り替えられる。
export default function CalendarView({ data, loading, weekStartMs, onChangeWeek, onOpenSession, now = Date.now() }) {
  const scrollRef = useRef(null);
  const scrolledWeekRef = useRef(null);
  const [colorMode, setColorMode] = useState(loadColorMode);
  const isPhase = colorMode === 'phase';

  useEffect(() => {
    try {
      localStorage.setItem(COLOR_MODE_KEY, colorMode);
    } catch {
      // 保存できなくても表示は変わらない
    }
  }, [colorMode]);

  // 応答が今の週のものでなければ描かない（週送りを連打したときの取り違え防止）
  const current = data && data.fromMs === weekStartMs ? data : null;
  const slotMs = current?.slotMs || 600000;
  const sessions = useMemo(() => current?.sessions || [], [current]);
  const minuteMs = current?.minuteMs || 60000;
  const days = useMemo(
    () => buildCalendarDays(sessions, { weekStartMs, slotMs, minuteMs }),
    [sessions, weekStartMs, slotMs, minuteMs],
  );
  const legend = useMemo(() => buildLegend(sessions), [sessions]);
  const totals = useMemo(() => phaseTotals(days, slotMs), [days, slotMs]);

  // 週を開いたら一番早い活動の少し上までスクロールする（更新では動かさない）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !current || scrolledWeekRef.current === weekStartMs) return;
    scrolledWeekRef.current = weekStartMs;
    const earliest = earliestOffsetMs(days);
    const offset = earliest === null ? 8 * 60 * 60 * 1000 : Math.max(0, earliest - 30 * 60 * 1000);
    el.scrollTop = (offset / DAY_MS) * el.scrollHeight;
  }, [current, days, weekStartMs]);

  const thisWeek = startOfWeek(now);

  return (
    <div className="cal">
      <div className="cal-toolbar">
        <button className="cal-nav" onClick={() => onChangeWeek(thisWeek)} disabled={weekStartMs === thisWeek}>
          今週
        </button>
        <button className="cal-nav" onClick={() => onChangeWeek(shiftWeek(weekStartMs, -1))} title="前の週">
          ◀
        </button>
        <button
          className="cal-nav"
          onClick={() => onChangeWeek(shiftWeek(weekStartMs, 1))}
          disabled={weekStartMs >= thisWeek}
          title="次の週"
        >
          ▶
        </button>
        <span className="cal-range">{formatWeekRange(weekStartMs)}</span>
        <span className="cal-count">{loading && !current ? '集計中…' : `${sessions.length} セッション`}</span>
        <div className="cal-color-modes">
          {COLOR_MODES.map((mode) => (
            <button
              key={mode.key}
              className={`cal-color-mode ${colorMode === mode.key ? 'active' : ''}`}
              onClick={() => setColorMode(mode.key)}
              title={mode.title}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      {isPhase ? (
        <div className="cal-legend">
          {Object.entries(PHASES).map(([phase, info]) => (
            <span key={phase} className="cal-legend-item" title={info.title}>
              <span className={`cal-swatch phase-${phase}`} />
              {info.label} {formatHours(totals[phase])}
            </span>
          ))}
        </div>
      ) : (
        legend.length > 0 && (
          <div className="cal-legend">
            {legend.map((item) => (
              <span key={item.project} className="cal-legend-item">
                <span className="cal-swatch" style={{ background: `var(--cal-${item.color})` }} />
                {item.project} {item.count}
              </span>
            ))}
          </div>
        )
      )}

      <div className="cal-head">
        <span />
        {days.map((day) => (
          <span
            key={day.dayStartMs}
            className={`cal-day-label ${now >= day.dayStartMs && now < day.dayEndMs ? 'today' : ''}`}
          >
            {formatDayHeader(day.dayStartMs)}
          </span>
        ))}
      </div>

      <div className="cal-scroll" ref={scrollRef}>
        <div className="cal-grid">
          <div className="cal-hours">
            {HOURS.map((h) => (
              <span key={h} className="cal-hour" style={{ top: pct(h * 3600000) }}>
                {h === 0 ? '' : `${h}:00`}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const isToday = now >= day.dayStartMs && now < day.dayEndMs;
            // DST の日は 23/25 時間になるが、縦軸は 24 時間固定で描く（ずれは 1 時間以内）
            return (
              <div key={day.dayStartMs} className={`cal-day ${isToday ? 'today' : ''}`}>
                {day.segments.map((seg) => {
                  const duration = seg.endMs - seg.startMs;
                  return (
                    <button
                      key={seg.key}
                      type="button"
                      tabIndex={-1}
                      className={`cal-seg ${isPhase ? 'phase' : ''}`}
                      style={{
                        // 調査 / 実装の色分けではプロジェクト色を使わない（CSS 側の中立色にする）
                        ...(isPhase ? {} : { '--seg-color': `var(--cal-${seg.color})` }),
                        top: pct(seg.startMs - day.dayStartMs),
                        height: pct(duration),
                        // 隣の帯と接しないよう左右 1px ずつ縮める
                        left: `calc(${(seg.lane / seg.lanes) * 100}% + 1px)`,
                        width: `calc(${100 / seg.lanes}% - 2px)`,
                      }}
                      title={segmentTooltip(seg)}
                      onClick={() => onOpenSession?.(seg)}
                    >
                      {/* 調査 / 実装の色分けは枠ごとに塗る（帯の中の空き枠は塗らない） */}
                      {isPhase &&
                        seg.slots.map((slot) => (
                          <span
                            key={`p${slot.startMs}`}
                            className={`cal-phase phase-${phaseOf(slot)}`}
                            style={{
                              top: `${((slot.startMs - seg.startMs) / duration) * 100}%`,
                              height: `${(slotMs / duration) * 100}%`,
                            }}
                          />
                        ))}
                      {seg.promptMarks.map((mark) => (
                        <span
                          key={mark.ms}
                          className={`cal-dot ${mark.count > 1 ? 'multi' : ''}`}
                          style={{ top: `${((mark.ms - seg.startMs) / duration) * 100}%` }}
                          title={promptMarkTooltip(mark)}
                        />
                      ))}
                    </button>
                  );
                })}
                {isToday && <div className="cal-now" style={{ top: pct(now - day.dayStartMs) }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
