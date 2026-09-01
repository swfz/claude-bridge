import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_VIEWS,
  HEAT_METRICS,
  WEEKDAY_LABELS,
  barRatio,
  buildWeeks,
  cellTooltip,
  computeThresholds,
  dayMonthTicks,
  formatCount,
  formatMetric,
  formatTokens,
  levelOf,
  monthLabels,
  weekdayTotals,
} from '../utils/heatmap.js';
import './ActivityPanel.css';

const METRIC_KEY = 'homeHeatmapMetric';
const OPEN_KEY = 'homeHeatmapOpen';
const VIEW_KEY = 'homeActivityView';

// 草。1 列 = 1 週（日曜始まり）、1 行 = 曜日。
function HeatmapView({ days, metric }) {
  const weeks = useMemo(() => buildWeeks(days), [days]);
  const monthRow = useMemo(() => monthLabels(weeks), [weeks]);
  const thresholds = useMemo(() => computeThresholds(days.map((d) => d[metric] || 0)), [days, metric]);

  return (
    <div className="activity-grid-wrap">
      <div className="activity-weekdays">
        {WEEKDAY_LABELS.map((label, i) => (
          // 月・水・金だけ出す（全部出すと升目より文字が勝つ）
          <span key={label} className="activity-weekday">
            {i % 2 === 1 ? label : ''}
          </span>
        ))}
      </div>
      <div className="activity-columns">
        <div className="activity-months">
          {monthRow.map((label, i) => (
            <span key={i} className="activity-month">
              {label || ''}
            </span>
          ))}
        </div>
        <div className="activity-weeks">
          {weeks.map((week, wi) => (
            <div key={wi} className="activity-week">
              {week.map((day, di) => (
                <div
                  key={di}
                  className={`activity-cell ${day ? `level-${levelOf(day[metric] || 0, thresholds)}` : 'empty'}`}
                  title={cellTooltip(day)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 日別の棒。濃淡では潰れる「量の差」を高さで見るためのビューなので、
// しきい値の分位ではなく最大値に対する線形の高さにする。
function DailyView({ days, metric }) {
  const max = useMemo(() => Math.max(0, ...days.map((d) => d[metric] || 0)), [days, metric]);
  const ticks = useMemo(() => dayMonthTicks(days), [days]);
  const columns = { '--count': days.length };

  return (
    <div className="activity-daily">
      <div className="activity-daily-axis">
        <span>{formatMetric(metric, max)}</span>
        <span>{formatMetric(metric, Math.round(max / 2))}</span>
        <span>0</span>
      </div>
      <div className="activity-daily-plot">
        <div className="activity-bars" style={columns}>
          {days.map((day) => {
            const value = day[metric] || 0;
            return (
              <div key={day.date} className="activity-bar-slot" title={cellTooltip(day)}>
                <div
                  className={`activity-bar ${value > 0 ? '' : 'zero'}`}
                  style={{ height: `${barRatio(value, max) * 100}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="activity-daily-months" style={columns}>
          {ticks.map((tick) => (
            <span key={tick.index} className="activity-month" style={{ gridColumn: tick.index + 1 }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// 曜日別の合計。7 本しかないので横棒で値をそのまま添える。
function WeekdayView({ days, metric }) {
  const rows = useMemo(() => weekdayTotals(days, metric), [days, metric]);
  const max = Math.max(0, ...rows.map((r) => r.value));

  return (
    <div className="activity-weekday-rows">
      {rows.map((row) => (
        <div
          key={row.weekday}
          className="activity-weekday-row"
          title={`${row.label}曜日 · ${formatMetric(metric, row.value)} · 稼働 ${row.activeDays}/${row.totalDays} 日`}
        >
          <span className="activity-weekday-label">{row.label}</span>
          <div className="activity-weekday-track">
            <div className="activity-weekday-fill" style={{ width: `${barRatio(row.value, max) * 100}%` }} />
          </div>
          <span className="activity-weekday-value">{formatMetric(metric, row.value)}</span>
          <span className="activity-weekday-days">{row.activeDays} 日</span>
        </div>
      ))}
    </div>
  );
}

// ホーム画面の活動パネル。日別の活動量（メッセージ数 / トークン数）を
// 草・日別の棒・曜日別の 3 通りで見せる。集計はサーバー側で、ここは描くだけ。
export default function ActivityPanel({ data, loading, onRefresh }) {
  const [metric, setMetric] = useState(() => localStorage.getItem(METRIC_KEY) || 'messages');
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || 'heatmap');
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== 'false');
  const scrollRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(METRIC_KEY, metric);
  }, [metric]);
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  useEffect(() => {
    localStorage.setItem(OPEN_KEY, String(open));
  }, [open]);

  const days = data?.days || [];
  const total = data?.total;
  // 草と日別は横に長いので最新（右端）が見える位置から始める。曜日別は幅に収まる
  const scrolls = view !== 'weekday';

  useEffect(() => {
    const el = scrollRef.current;
    if (el && scrolls) el.scrollLeft = el.scrollWidth;
  }, [open, view, scrolls, days.length]);

  const maxPerDay = Math.max(0, ...days.map((d) => d[metric] || 0));

  return (
    <section className="activity">
      <div className="activity-header">
        <button className="activity-toggle" onClick={() => setOpen((v) => !v)} title={open ? '畳む' : '開く'}>
          <span className="activity-caret">{open ? '▾' : '▸'}</span>
          活動
        </button>
        {total && (
          <span className="activity-summary">
            {formatCount(total.messages)} メッセージ · {formatTokens(total.tokens)} トークン · {total.activeDays} 日
          </span>
        )}
        {open && (
          <div className="activity-actions">
            <div className="activity-segmented">
              {ACTIVITY_VIEWS.map((v) => (
                <button
                  key={v.key}
                  className={`activity-segment ${view === v.key ? 'active' : ''}`}
                  onClick={() => setView(v.key)}
                  title={v.title}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="activity-segmented">
              {HEAT_METRICS.map((m) => (
                <button
                  key={m.key}
                  className={`activity-segment ${metric === m.key ? 'active' : ''}`}
                  onClick={() => setMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button className="activity-refresh" onClick={onRefresh} disabled={loading} title="集計し直す">
              {loading ? '集計中…' : '更新'}
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className="activity-body">
          {loading && days.length === 0 ? (
            <div className="activity-loading">初回は全セッションを走査するので少し時間がかかります…</div>
          ) : (
            <div className={`activity-viewport ${scrolls ? 'scrolls' : ''}`} ref={scrollRef}>
              {view === 'heatmap' && <HeatmapView days={days} metric={metric} />}
              {view === 'daily' && <DailyView days={days} metric={metric} />}
              {view === 'weekday' && <WeekdayView days={days} metric={metric} />}
            </div>
          )}
          <div className="activity-legend">
            {view === 'heatmap' && (
              <>
                <span className="activity-legend-label">少</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <div key={level} className={`activity-cell level-${level}`} />
                ))}
                <span className="activity-legend-label">多</span>
              </>
            )}
            <span className="activity-legend-note">
              {view === 'weekday' ? `直近 ${days.length} 日の合計` : `最大 ${formatMetric(metric, maxPerDay)} / 日`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
