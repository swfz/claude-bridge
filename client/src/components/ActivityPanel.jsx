import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_VIEWS,
  HEAT_METRICS,
  WEEKDAY_LABELS,
  barRatio,
  barWidthFor,
  bucketDays,
  bucketTicks,
  bucketTooltip,
  buildWeeks,
  cellTooltip,
  computeThresholds,
  formatCount,
  formatDateLabel,
  formatMetric,
  formatTokens,
  levelOf,
  monthLabels,
  periodEquals,
  weekdayTotals,
} from '../utils/heatmap.js';
import './ActivityPanel.css';

const METRIC_KEY = 'homeHeatmapMetric';
const OPEN_KEY = 'homeHeatmapOpen';
const VIEW_KEY = 'homeActivityView';

// 棒・升目のビューと、それが表す期間の単位
const GRANULARITY_BY_VIEW = { daily: 'day', weekly: 'week', monthly: 'month' };
const BARS_VIEWS = new Set(['daily', 'weekly', 'monthly']);
const UNIT_LABEL = { day: '日', week: '週', month: '月' };

// 升目・棒は数百個並ぶので Tab の停止点にはしない（tabIndex=-1。検索欄まで 365 回押すことになる）。
// 選択中の期間をもう一度押したら解除（同じ操作で戻せるようにする）
function togglePeriod(current, next, onSelectPeriod) {
  if (!onSelectPeriod) return;
  onSelectPeriod(periodEquals(current, next) ? null : next);
}

// 草。1 列 = 1 週（日曜始まり）、1 行 = 曜日。
function HeatmapView({ days, metric, selectedPeriod, onSelectPeriod }) {
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
              {week.map((day, di) => {
                // 升目 1 つ = その 1 日の期間。曜日合わせの空セルは押せない
                const period = day ? { from: day.date, to: day.date, label: formatDateLabel(day.date) } : null;
                const selected = periodEquals(selectedPeriod, period);
                return (
                  <button
                    key={di}
                    type="button"
                    className={`activity-cell ${day ? `level-${levelOf(day[metric] || 0, thresholds)}` : 'empty'} ${
                      selected ? 'selected' : ''
                    }`}
                    title={cellTooltip(day)}
                    disabled={!day}
                    tabIndex={-1}
                    onClick={() => togglePeriod(selectedPeriod, period, onSelectPeriod)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 日・週・月の棒。濃淡では潰れる「量の差」を高さで見るためのビューなので、
// しきい値の分位ではなく最大値に対する線形の高さにする。
function BarsView({ days, metric, granularity, selectedPeriod, onSelectPeriod }) {
  const buckets = useMemo(() => bucketDays(days, granularity), [days, granularity]);
  const max = useMemo(() => Math.max(0, ...buckets.map((b) => b[metric] || 0)), [buckets, metric]);
  const ticks = useMemo(() => bucketTicks(buckets, granularity), [buckets, granularity]);
  // 棒と月ラベルは同じ列グリッドを共有する。本数と幅は子に継承させる
  const columns = { '--count': buckets.length, '--bar': barWidthFor(granularity) };

  return (
    <div className="activity-daily" style={columns}>
      <div className="activity-daily-axis">
        <span>{formatMetric(metric, max)}</span>
        <span>{formatMetric(metric, Math.round(max / 2))}</span>
        <span>0</span>
      </div>
      <div className="activity-daily-plot">
        <div className="activity-bars">
          {buckets.map((bucket) => {
            const value = bucket[metric] || 0;
            const period = { from: bucket.from, to: bucket.to, label: bucket.label };
            const selected = periodEquals(selectedPeriod, period);
            return (
              <button
                key={bucket.key}
                type="button"
                className={`activity-bar-slot ${selected ? 'selected' : ''}`}
                title={bucketTooltip(bucket, granularity)}
                tabIndex={-1}
                onClick={() => togglePeriod(selectedPeriod, period, onSelectPeriod)}
              >
                <div
                  className={`activity-bar ${value > 0 ? '' : 'zero'}`}
                  style={{ height: `${barRatio(value, max) * 100}%` }}
                />
              </button>
            );
          })}
        </div>
        <div className="activity-daily-months">
          {ticks.map((tick) => (
            <span key={tick.index} className="activity-month" style={{ gridColumn: tick.index + 1 }}>
              {tick.label}
              {tick.year && <span className="activity-month-year">{tick.year}</span>}
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
// 草・日別 / 週別 / 月別の棒・曜日別の 5 通りで見せる。集計はサーバー側で、ここは描くだけ。
// 棒・升目のクリックは「その期間」を選ぶ操作で、選んだ期間は下の一覧の絞り込みに使う。
export default function ActivityPanel({ data, loading, onRefresh, selectedPeriod, onSelectPeriod }) {
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

  // 各ビューの useMemo が効くよう、参照を毎レンダー作り直さない
  const days = useMemo(() => data?.days || [], [data]);
  const total = data?.total;
  const granularity = GRANULARITY_BY_VIEW[view] || 'day';
  // 草と棒のビューは横に長いので最新（右端）が見える位置から始める。曜日別は幅に収まる
  const scrolls = view !== 'weekday';

  useEffect(() => {
    const el = scrollRef.current;
    if (el && scrolls) el.scrollLeft = el.scrollWidth;
  }, [open, view, scrolls, days.length]);

  // 凡例の「最大 … / 単位」。週別・月別は畳んだあとの値で見ないと意味が変わる
  const maxPerUnit = useMemo(() => {
    const values = granularity === 'day' ? days : bucketDays(days, granularity);
    return Math.max(0, ...values.map((v) => v[metric] || 0));
  }, [days, metric, granularity]);

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
              {view === 'heatmap' && (
                <HeatmapView
                  days={days}
                  metric={metric}
                  selectedPeriod={selectedPeriod}
                  onSelectPeriod={onSelectPeriod}
                />
              )}
              {BARS_VIEWS.has(view) && (
                <BarsView
                  days={days}
                  metric={metric}
                  granularity={granularity}
                  selectedPeriod={selectedPeriod}
                  onSelectPeriod={onSelectPeriod}
                />
              )}
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
              {view === 'weekday'
                ? `直近 ${days.length} 日の合計`
                : `最大 ${formatMetric(metric, maxPerUnit)} / ${UNIT_LABEL[granularity]}`}
            </span>
            {selectedPeriod && (
              <span className="activity-period-chip">
                絞り込み中: {selectedPeriod.label}
                <button
                  className="activity-period-clear"
                  onClick={() => onSelectPeriod?.(null)}
                  title="期間の絞り込みを解除"
                >
                  ×
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
