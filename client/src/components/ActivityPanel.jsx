import { useEffect, useMemo, useRef, useState } from 'react';
import { TbInfoCircle, TbRefresh } from 'react-icons/tb';
import {
  ACTIVITY_VIEWS,
  BAR_GRANULARITIES,
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
  fetchedAtLabel,
  formatDateLabel,
  formatMetric,
  legendTooltip,
  levelOf,
  monthLabels,
  normalizeActivityView,
  normalizeGranularity,
  outlierText,
  outlierTooltip,
  periodEquals,
  recentValues,
  sparklinePoints,
  summaryText,
  weekdayTotals,
  weeklyOutlier,
} from '../utils/heatmap.js';
import { shiftWeek, startOfWeek } from '../utils/calendar.js';
import CalendarView from './CalendarView.jsx';
import './ActivityPanel.css';

const METRIC_KEY = 'homeHeatmapMetric';
const OPEN_KEY = 'homeHeatmapOpen';
const VIEW_KEY = 'homeActivityView';
const GRANULARITY_KEY = 'homeActivityBarGranularity';

const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 16;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても表示は変わらない
  }
}

// 初期のビューと棒の粒度。旧形式（日別・週別・月別が独立したビュー）の保存値もここで読み替える
function loadInitialView() {
  const { view, granularity } = normalizeActivityView(readStorage(VIEW_KEY));
  return { view, granularity: granularity || normalizeGranularity(readStorage(GRANULARITY_KEY)) };
}

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
// outlierKey は今週が突出しているときの週バケットの key（週別のときだけその棒を警告色にする）
function BarsView({ days, metric, granularity, selectedPeriod, onSelectPeriod, outlierKey }) {
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
                className={`activity-bar-slot ${selected ? 'selected' : ''} ${
                  granularity === 'week' && bucket.key === outlierKey ? 'outlier' : ''
                }`}
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

// 直近 30 日の推移。畳んだパネルの見出しに添える細い折れ線（色は中立）
function Sparkline({ values }) {
  const points = sparklinePoints(values, { width: SPARK_WIDTH, height: SPARK_HEIGHT });
  if (!points) return null;
  return (
    <svg
      className="activity-sparkline"
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

// ホーム画面の活動パネル。日別の活動量（メッセージ数 / トークン数）を
// 草・棒（日別 / 週別 / 月別）・曜日別で見せる。集計はサーバー側で、ここは描くだけ。
// 棒・升目のクリックは「その期間」を選ぶ操作で、選んだ期間は下の一覧の絞り込みに使う。
// 「カレンダー」だけは別データ（10 分枠の集計）で、表示する週はこのパネルが持ち、
// 週が変わるたびに onRequestCalendar で取りに行く。
// 見た目は「既定値は出さない、例外だけ目立たせる」: 色は濃淡（量）と、今週が突出したときの警告色だけ。
// 凡例・最大値はツールチップへ逃がし、選択中のトグルは中立色の背景で示す。
export default function ActivityPanel({
  data,
  loading,
  onRefresh,
  selectedPeriod,
  onSelectPeriod,
  calendar,
  calendarLoading,
  onRequestCalendar,
  onOpenSession,
  dirColorOf,
}) {
  const [metric, setMetric] = useState(() => (readStorage(METRIC_KEY) === 'tokens' ? 'tokens' : 'messages'));
  const [initial] = useState(loadInitialView);
  const [view, setView] = useState(initial.view);
  const [granularity, setGranularity] = useState(initial.granularity);
  const [open, setOpen] = useState(() => readStorage(OPEN_KEY) !== 'false');
  // 表示中の週（月曜 0:00 のローカル時刻 ms）。その場限りなので保存しない
  const [weekStartMs, setWeekStartMs] = useState(() => startOfWeek(Date.now()));
  const scrollRef = useRef(null);
  const isCalendar = view === 'calendar';

  useEffect(() => {
    if (!open || !isCalendar) return;
    onRequestCalendar?.({ fromMs: weekStartMs, toMs: shiftWeek(weekStartMs, 1) });
  }, [open, isCalendar, weekStartMs, onRequestCalendar]);

  const handleRefresh = () => {
    onRefresh?.();
    if (isCalendar) onRequestCalendar?.({ fromMs: weekStartMs, toMs: shiftWeek(weekStartMs, 1) });
  };

  useEffect(() => writeStorage(METRIC_KEY, metric), [metric]);
  useEffect(() => writeStorage(VIEW_KEY, view), [view]);
  useEffect(() => writeStorage(GRANULARITY_KEY, granularity), [granularity]);
  useEffect(() => writeStorage(OPEN_KEY, String(open)), [open]);

  // 各ビューの useMemo が効くよう、参照を毎レンダー作り直さない
  const days = useMemo(() => data?.days || [], [data]);
  const total = data?.total;
  // 草と棒のビューは横に長いので最新（右端）が見える位置から始める。曜日別は幅に収まる
  const scrolls = view !== 'weekday' && !isCalendar;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && scrolls) el.scrollLeft = el.scrollWidth;
  }, [open, view, granularity, scrolls, days.length]);

  const outlier = useMemo(() => weeklyOutlier(days, metric), [days, metric]);
  const sparkValues = useMemo(() => recentValues(days, metric), [days, metric]);
  const busy = isCalendar ? calendarLoading : loading;

  return (
    <section className={`activity ${open ? '' : 'collapsed'}`}>
      <div className="activity-header">
        <button className="activity-toggle" onClick={() => setOpen((v) => !v)} title={open ? '畳む' : '開く'}>
          <span className="activity-caret">{open ? '▾' : '▸'}</span>
          活動
        </button>
        {!open && sparkValues.length > 1 && (
          <span className="activity-spark-wrap" title={`直近 ${sparkValues.length} 日の推移`}>
            <Sparkline values={sparkValues} />
          </span>
        )}
        {selectedPeriod ? (
          // 絞り込み中は合計の代わりに「何で絞っているか」を出す（解除はここの × で）
          <span className="activity-summary activity-filtering">
            {selectedPeriod.label} で絞り込み中
            <button
              className="activity-period-clear"
              onClick={() => onSelectPeriod?.(null)}
              title="期間の絞り込みを解除"
            >
              ×
            </button>
          </span>
        ) : (
          total && <span className="activity-summary">{summaryText(total, days.length)}</span>
        )}
        {outlier && !isCalendar && (
          <span className="activity-outlier" title={outlierTooltip(outlier, metric)}>
            {outlierText(outlier)}
          </span>
        )}
        {open && !isCalendar && days.length > 0 && (
          <span className="activity-info" title={legendTooltip({ view, metric, granularity, days })} aria-label="凡例">
            <TbInfoCircle />
          </span>
        )}
        {open && (
          <div className="activity-actions">
            {view === 'bars' && (
              <div className="activity-segmented small" role="group" aria-label="棒の粒度">
                {BAR_GRANULARITIES.map((g) => (
                  <button
                    key={g.key}
                    className={`activity-segment ${granularity === g.key ? 'active' : ''}`}
                    onClick={() => setGranularity(g.key)}
                    title={g.title}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            {/* カレンダーはメッセージ / トークンの切り替えを使わない */}
            {!isCalendar && (
              <div className="activity-segmented small" role="group" aria-label="指標">
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
            )}
            <div className="activity-segmented" role="group" aria-label="表示">
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
            <button
              className={`activity-refresh ${busy ? 'busy' : ''}`}
              onClick={handleRefresh}
              disabled={busy}
              title={busy ? '集計中…' : fetchedAtLabel(data?.generatedAt)}
              aria-label="集計し直す"
            >
              <TbRefresh />
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className="activity-body">
          {isCalendar ? (
            <CalendarView
              data={calendar}
              loading={calendarLoading}
              weekStartMs={weekStartMs}
              onChangeWeek={setWeekStartMs}
              onOpenSession={onOpenSession}
              dirColorOf={dirColorOf}
            />
          ) : loading && days.length === 0 ? (
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
              {view === 'bars' && (
                <BarsView
                  days={days}
                  metric={metric}
                  granularity={granularity}
                  selectedPeriod={selectedPeriod}
                  onSelectPeriod={onSelectPeriod}
                  outlierKey={outlier?.key}
                />
              )}
              {view === 'weekday' && <WeekdayView days={days} metric={metric} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
