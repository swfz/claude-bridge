import { useEffect, useMemo, useRef } from 'react';
import {
  DAY_MS,
  buildCalendarDays,
  buildLegend,
  densityLevel,
  earliestOffsetMs,
  formatDayHeader,
  formatWeekRange,
  segmentTooltip,
  shiftWeek,
  startOfWeek,
} from '../utils/calendar.js';
import './CalendarView.css';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pct = (ms) => `${(ms / DAY_MS) * 100}%`;

// 週間カレンダー。縦軸が時刻、横軸が曜日で、セッションの活動区間を帯で並べる。
// 帯は 20 分以上の空きで切れるので、止まっていた区間は空白として見える。
// 帯の左端は 10 分枠ごとの発言量の濃淡。重なったセッションは横に並べる（並行作業）。
export default function CalendarView({ data, loading, weekStartMs, onChangeWeek, onOpenSession, now = Date.now() }) {
  const scrollRef = useRef(null);
  const scrolledWeekRef = useRef(null);

  // 応答が今の週のものでなければ描かない（週送りを連打したときの取り違え防止）
  const current = data && data.fromMs === weekStartMs ? data : null;
  const sessions = useMemo(() => current?.sessions || [], [current]);
  const days = useMemo(
    () => buildCalendarDays(sessions, { weekStartMs, slotMs: current?.slotMs || 600000 }),
    [sessions, weekStartMs, current],
  );
  const legend = useMemo(() => buildLegend(sessions), [sessions]);

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
      </div>

      {legend.length > 0 && (
        <div className="cal-legend">
          {legend.map((item) => (
            <span key={item.project} className="cal-legend-item">
              <span className="cal-swatch" style={{ background: `var(--cal-${item.color})` }} />
              {item.project} {item.count}
            </span>
          ))}
        </div>
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
                      className="cal-seg"
                      style={{
                        '--seg-color': `var(--cal-${seg.color})`,
                        top: pct(seg.startMs - day.dayStartMs),
                        height: pct(duration),
                        // 隣の帯と接しないよう左右 1px ずつ縮める
                        left: `calc(${(seg.lane / seg.lanes) * 100}% + 1px)`,
                        width: `calc(${100 / seg.lanes}% - 2px)`,
                      }}
                      title={segmentTooltip(seg)}
                      onClick={() => onOpenSession?.(seg)}
                    >
                      {seg.slots.map((slot) => {
                        const level = densityLevel(slot.prompts);
                        if (level === 0) return null;
                        return (
                          <span
                            key={slot.startMs}
                            className={`cal-density level-${level}`}
                            style={{
                              top: `${((slot.startMs - seg.startMs) / duration) * 100}%`,
                              height: `${(600000 / duration) * 100}%`,
                            }}
                          />
                        );
                      })}
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
