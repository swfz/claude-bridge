import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeks,
  cellTooltip,
  computeThresholds,
  formatTokens,
  levelOf,
  monthLabels,
  weekdayOf,
  weekdayTotals,
  barRatio,
  bucketDays,
  bucketTicks,
  bucketTooltip,
  barWidthFor,
  periodEquals,
  ACTIVITY_VIEWS,
  BAR_GRANULARITIES,
  OUTLIER_BASELINE_WEEKS,
  OUTLIER_MULTIPLIER,
  fetchedAtLabel,
  legendTooltip,
  normalizeActivityView,
  normalizeGranularity,
  outlierText,
  outlierTooltip,
  recentValues,
  sparklinePoints,
  summaryText,
  weeklyOutlier,
  formatDuration,
  formatMetric,
  normalizeMetric,
  HEAT_METRICS,
  ACTIVE_TIME_TITLE,
} from '../client/src/utils/heatmap.js';

const day = (date, extra = {}) => ({
  date,
  prompts: 0,
  replies: 0,
  messages: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  tokens: 0,
  activeMs: 0,
  ...extra,
});

const HOUR = 3600000;

// 連続した日付を作る（YYYY-MM-DD、UTC で組み立てるのでローカル TZ に依存しない）
const range = (start, count) => {
  const [y, m, d] = start.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    out.push(day(t.toISOString().slice(0, 10)));
  }
  return out;
};

describe('weekdayOf', () => {
  it('is timezone independent', () => {
    assert.equal(weekdayOf('2026-09-01'), 2); // 火曜
    assert.equal(weekdayOf('2026-08-30'), 0); // 日曜
  });
});

describe('buildWeeks', () => {
  it('starts a new column on every Sunday', () => {
    const weeks = buildWeeks(range('2026-08-30', 14)); // 日曜始まりで 2 週ちょうど
    assert.equal(weeks.length, 2);
    assert.equal(weeks[0].filter(Boolean).length, 7);
    assert.equal(weeks[1].filter(Boolean).length, 7);
  });

  it('pads the leading partial week so weekdays line up', () => {
    const weeks = buildWeeks(range('2026-09-01', 10)); // 火曜始まり
    assert.equal(weeks[0][0], null); // 日
    assert.equal(weeks[0][1], null); // 月
    assert.equal(weeks[0][2].date, '2026-09-01');
    assert.equal(weeks.length, 2);
  });

  it('puts each day on its own weekday row', () => {
    const weeks = buildWeeks(range('2026-08-30', 7));
    assert.deepEqual(
      weeks[0].map((d) => d.date),
      ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'],
    );
  });

  it('returns no columns for an empty range', () => {
    assert.deepEqual(buildWeeks([]), []);
  });
});

describe('computeThresholds / levelOf', () => {
  it('splits active days into four bands', () => {
    const thresholds = computeThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(levelOf(0, thresholds), 0);
    assert.equal(levelOf(1, thresholds), 1);
    assert.equal(levelOf(8, thresholds), 4);
    // 段は単調に上がる
    const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => levelOf(v, thresholds));
    assert.deepEqual(
      levels,
      [...levels].sort((a, b) => a - b),
    );
  });

  it('keeps the bands distinct even when every day has the same value', () => {
    const thresholds = computeThresholds([5, 5, 5, 5]);
    assert.ok(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2]);
    assert.equal(levelOf(0, thresholds), 0);
    assert.equal(levelOf(5, thresholds), 1);
  });

  it('treats zero as no activity even with no data at all', () => {
    const thresholds = computeThresholds([]);
    assert.equal(levelOf(0, thresholds), 0);
    assert.equal(levelOf(1, thresholds), 1);
  });
});

describe('formatTokens', () => {
  it('scales to K/M/B', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5K');
    assert.equal(formatTokens(2_400_000), '2.4M');
    assert.equal(formatTokens(11_810_913_502), '11.81B');
  });
});

describe('cellTooltip', () => {
  it('says nothing happened on an empty day', () => {
    assert.match(cellTooltip(day('2026-09-01')), /活動なし/);
  });

  it('shows both message breakdown and token breakdown regardless of metric', () => {
    const text = cellTooltip(
      day('2026-09-01', { prompts: 3, replies: 40, messages: 43, outputTokens: 1000, tokens: 5000 }),
    );
    assert.match(text, /あなた 3/);
    assert.match(text, /Claude 40/);
    assert.match(text, /トークン 5.0K/);
  });

  it('is empty for a padding cell', () => {
    assert.equal(cellTooltip(null), '');
  });
});

describe('monthLabels', () => {
  it('labels only the first column of each month', () => {
    const weeks = buildWeeks(range('2026-08-02', 120));
    const labels = monthLabels(weeks);
    assert.equal(labels.length, weeks.length);
    const shown = labels.filter(Boolean);
    assert.deepEqual(shown, [...new Set(shown)]); // 同じ月を二度出さない
    assert.deepEqual(shown, ['9月', '10月', '11月']);
  });

  it('leaves the leading partial week unlabeled (it does not start the month)', () => {
    const labels = monthLabels(buildWeeks(range('2026-08-05', 120)));
    assert.equal(labels[0], null);
  });
});

describe('weekdayTotals', () => {
  it('sums the metric per weekday, ordered Monday first', () => {
    // 2026-08-31(月) 〜 2026-09-06(日) の 7 日
    const days = range('2026-08-31', 7).map((d, i) => ({ ...d, messages: i + 1, tokens: (i + 1) * 100 }));
    const rows = weekdayTotals(days, 'messages');
    assert.deepEqual(
      rows.map((r) => r.label),
      ['月', '火', '水', '木', '金', '土', '日'],
    );
    assert.deepEqual(
      rows.map((r) => r.value),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  it('follows the selected metric', () => {
    const days = range('2026-08-31', 7).map((d, i) => ({ ...d, messages: 1, tokens: (i + 1) * 100 }));
    assert.deepEqual(
      weekdayTotals(days, 'tokens').map((r) => r.value),
      [100, 200, 300, 400, 500, 600, 700],
    );
  });

  it('counts active days separately from the total days on that weekday', () => {
    // 2 週分。月曜だけ 1 日は活動なし
    const days = range('2026-08-31', 14).map((d, i) => ({ ...d, messages: i === 7 ? 0 : 5 }));
    const monday = weekdayTotals(days, 'messages')[0];
    assert.equal(monday.totalDays, 2);
    assert.equal(monday.activeDays, 1);
    assert.equal(monday.value, 5);
  });

  it('returns seven zeroed rows for an empty range', () => {
    const rows = weekdayTotals([], 'messages');
    assert.equal(rows.length, 7);
    assert.deepEqual(new Set(rows.map((r) => r.value)), new Set([0]));
  });
});

describe('barRatio', () => {
  it('scales linearly against the max', () => {
    assert.equal(barRatio(0, 100), 0);
    assert.equal(barRatio(50, 100), 0.5);
    assert.equal(barRatio(100, 100), 1);
  });

  it('stays at zero when there is no max (all-empty range)', () => {
    assert.equal(barRatio(0, 0), 0);
    assert.equal(barRatio(5, 0), 0);
  });
});

describe('bucketDays', () => {
  it('keeps one bucket per day for the day granularity', () => {
    const buckets = bucketDays(range('2026-09-01', 3), 'day');
    assert.deepEqual(
      buckets.map((b) => [b.key, b.from, b.to, b.days]),
      [
        ['2026-09-01', '2026-09-01', '2026-09-01', 1],
        ['2026-09-02', '2026-09-02', '2026-09-02', 1],
        ['2026-09-03', '2026-09-03', '2026-09-03', 1],
      ],
    );
    assert.match(buckets[0].label, /^9\/1（/);
  });

  it('groups weeks starting on Monday and lets the edges be partial', () => {
    // 2026-09-02 は水曜。先頭の週は水〜日の 5 日、末尾は月・火の 2 日だけになる
    const buckets = bucketDays(range('2026-09-02', 14), 'week');
    assert.deepEqual(
      buckets.map((b) => [b.from, b.to, b.days]),
      [
        ['2026-09-02', '2026-09-06', 5],
        ['2026-09-07', '2026-09-13', 7],
        ['2026-09-14', '2026-09-15', 2],
      ],
    );
    assert.deepEqual(
      buckets.map((b) => b.label),
      ['9/2〜9/6', '9/7〜9/13', '9/14〜9/15'],
    );
    // キーは実際に含まれる先頭の日（週の頭ではない）
    assert.equal(buckets[0].key, '2026-09-02');
  });

  it('groups months and labels them with the year', () => {
    const buckets = bucketDays(range('2026-08-30', 5), 'month');
    assert.deepEqual(
      buckets.map((b) => [b.key, b.from, b.to, b.days, b.label]),
      [
        ['2026-08', '2026-08-30', '2026-08-31', 2, '2026年8月'],
        ['2026-09', '2026-09-01', '2026-09-03', 3, '2026年9月'],
      ],
    );
  });

  it('sums the metrics and counts only the days with activity', () => {
    const days = range('2026-09-07', 7).map((d, i) => ({
      ...d,
      prompts: i,
      replies: i,
      messages: i === 0 ? 0 : i * 2,
      tokens: i * 100,
      inputTokens: i * 10,
    }));
    const [week] = bucketDays(days, 'week');
    assert.equal(week.days, 7);
    assert.equal(week.activeDays, 6); // 先頭の 1 日だけ活動なし
    assert.equal(week.messages, 42);
    assert.equal(week.prompts, 21);
    assert.equal(week.tokens, 2100);
    assert.equal(week.inputTokens, 210);
  });

  it('returns no buckets for an empty range', () => {
    assert.deepEqual(bucketDays([], 'week'), []);
  });
});

describe('bucketTicks', () => {
  it('marks the week where the month changes', () => {
    // 2026-08-24（月）から 4 週。3 週目の頭が 9 月に入る
    const buckets = bucketDays(range('2026-08-24', 28), 'week');
    assert.deepEqual(bucketTicks(buckets, 'week'), [{ index: 2, label: '9月' }]);
  });

  it('labels every month bucket and adds the year to the first bucket and January', () => {
    const buckets = bucketDays(range('2025-12-01', 70), 'month');
    assert.deepEqual(bucketTicks(buckets, 'month'), [
      { index: 0, label: '12月', year: '2025' },
      { index: 1, label: '1月', year: '2026' },
      { index: 2, label: '2月' },
    ]);
  });

  it('marks the first day of each month for the day granularity', () => {
    const days = range('2026-08-30', 5); // 8/30, 8/31, 9/1, 9/2, 9/3
    assert.deepEqual(bucketTicks(bucketDays(days, 'day'), 'day'), [{ index: 2, label: '9月' }]);
  });

  it('never marks index 0 (there is no previous bucket to compare with)', () => {
    assert.deepEqual(bucketTicks(bucketDays(range('2026-09-01', 3), 'day'), 'day'), []);
  });
});

describe('bucketTooltip', () => {
  it('shows the period, the breakdown and the number of active days', () => {
    const days = range('2026-09-07', 7).map((d, i) => ({ ...d, messages: i === 0 ? 0 : 2, prompts: 1, replies: 1 }));
    const text = bucketTooltip(bucketDays(days, 'week')[0], 'week');
    assert.match(text, /^9\/7〜9\/13（7 日）/);
    assert.match(text, /メッセージ 12/);
    assert.match(text, /稼働 6 日/);
  });

  it('says nothing happened for an empty period', () => {
    assert.match(bucketTooltip(bucketDays(range('2026-09-07', 7), 'week')[0], 'week'), /活動なし/);
  });

  it('falls back to the day tooltip for the day granularity', () => {
    const [bucket] = bucketDays([day('2026-09-01', { messages: 1, prompts: 1 })], 'day');
    assert.equal(bucketTooltip(bucket, 'day'), cellTooltip(day('2026-09-01', { messages: 1, prompts: 1 })));
  });
});

describe('barWidthFor / periodEquals', () => {
  it('widens the bars as the buckets get longer', () => {
    assert.equal(barWidthFor('day'), '3px');
    assert.equal(barWidthFor('week'), '10px');
    assert.equal(barWidthFor('month'), '28px');
  });

  it('compares periods by their range only', () => {
    assert.ok(periodEquals({ from: 'a', to: 'b', label: 'x' }, { from: 'a', to: 'b', label: 'y' }));
    assert.ok(!periodEquals({ from: 'a', to: 'b' }, { from: 'a', to: 'c' }));
    assert.ok(!periodEquals(null, { from: 'a', to: 'b' }));
    assert.ok(!periodEquals({ from: 'a', to: 'b' }, null));
  });
});

describe('normalizeActivityView / normalizeGranularity', () => {
  it('has four views and three bar granularities', () => {
    assert.deepEqual(
      ACTIVITY_VIEWS.map((v) => v.label),
      ['草', '棒', '曜日', 'カレンダー'],
    );
    assert.deepEqual(
      BAR_GRANULARITIES.map((g) => g.label),
      ['日別', '週別', '月別'],
    );
  });

  it('migrates the old daily / weekly / monthly views to bars with that granularity', () => {
    assert.deepEqual(normalizeActivityView('daily'), { view: 'bars', granularity: 'day' });
    assert.deepEqual(normalizeActivityView('weekly'), { view: 'bars', granularity: 'week' });
    assert.deepEqual(normalizeActivityView('monthly'), { view: 'bars', granularity: 'month' });
  });

  it('keeps current views and falls back to heatmap', () => {
    assert.deepEqual(normalizeActivityView('calendar'), { view: 'calendar', granularity: null });
    assert.deepEqual(normalizeActivityView('bars'), { view: 'bars', granularity: null });
    assert.deepEqual(normalizeActivityView(null), { view: 'heatmap', granularity: null });
    assert.deepEqual(normalizeActivityView('bogus'), { view: 'heatmap', granularity: null });
  });

  it('accepts only known granularities', () => {
    assert.equal(normalizeGranularity('week'), 'week');
    assert.equal(normalizeGranularity('month'), 'month');
    assert.equal(normalizeGranularity('year'), 'day');
    assert.equal(normalizeGranularity(null), 'day');
  });
});

describe('summaryText', () => {
  it('reads as the total of the last N days', () => {
    assert.equal(
      summaryText({ messages: 1234, tokens: 2_500_000, activeDays: 10 }, 365),
      '直近 365 日 · 1,234 メッセージ · 2.5M トークン · 稼働 10 日',
    );
  });

  it('is empty without totals', () => {
    assert.equal(summaryText(null, 365), '');
  });
});

describe('summaryText with AI busy time', () => {
  it('adds the AI busy time without clashing with the active-day count', () => {
    assert.equal(
      summaryText({ messages: 10, tokens: 1000, activeMs: 412.4 * HOUR, activeDays: 3 }, 30),
      '直近 30 日 · 10 メッセージ · 1.0K トークン · AI 稼働 412h · 稼働 3 日',
    );
  });
});

describe('AI busy time metric (activeMs)', () => {
  it('is the third metric', () => {
    assert.deepEqual(
      HEAT_METRICS.map((m) => m.key),
      ['messages', 'tokens', 'activeMs'],
    );
  });

  it('restores only known metrics from storage', () => {
    assert.equal(normalizeMetric('activeMs'), 'activeMs');
    assert.equal(normalizeMetric('tokens'), 'tokens');
    assert.equal(normalizeMetric('all'), 'messages');
    assert.equal(normalizeMetric(null), 'messages');
  });

  it('formats hours with one decimal, minutes under an hour, and keeps more than 24h as is', () => {
    assert.equal(formatDuration(3.24 * HOUR), '3.2h');
    assert.equal(formatDuration(45 * 60000), '45m');
    assert.equal(formatDuration(0), '0m');
    assert.equal(formatDuration(undefined), '0m');
    assert.equal(formatDuration(30.5 * HOUR), '30.5h');
    assert.equal(formatDuration(1234.4 * HOUR), '1,234h');
    assert.equal(formatMetric('activeMs', 2 * HOUR), '2.0h');
    assert.equal(formatMetric('messages', 1234), '1,234');
  });

  it('sums activeMs into week and month buckets', () => {
    const days = [day('2026-01-05', { activeMs: HOUR }), day('2026-01-06', { activeMs: 2 * HOUR })];
    assert.equal(bucketDays(days, 'week')[0].activeMs, 3 * HOUR);
    assert.equal(bucketDays(days, 'month')[0].activeMs, 3 * HOUR);
  });

  it('shows the busy time in tooltips, also for a day that only has busy time', () => {
    assert.match(cellTooltip(day('2026-01-05', { messages: 2, activeMs: HOUR })), /AI 稼働 1\.0h/);
    // 0:00 をまたいだ呼び出しの続きだけの日（メッセージ 0）も「活動なし」にしない
    const carried = cellTooltip(day('2026-01-06', { activeMs: 20 * 60000 }));
    assert.doesNotMatch(carried, /活動なし/);
    assert.match(carried, /AI 稼働 20m/);
    const bucket = bucketDays([day('2026-01-06', { activeMs: 20 * 60000 })], 'week')[0];
    assert.match(bucketTooltip(bucket, 'week'), /AI 稼働 20m/);
  });

  it('works with the weekday totals, the outlier and the sparkline', () => {
    const days = [];
    for (let i = 0; i < 21; i++) {
      const date = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
      days.push(day(date, { messages: 1, activeMs: i >= 14 ? 5 * HOUR : HOUR }));
    }
    const outlier = weeklyOutlier(days, 'activeMs');
    assert.equal(outlier.ratio, 5);
    assert.match(outlierTooltip(outlier, 'activeMs'), /35\.0h.*7\.0h/);
    assert.equal(weekdayTotals(days, 'activeMs').find((r) => r.label === '月').value, 7 * HOUR);
    assert.deepEqual(recentValues(days, 'activeMs', 2), [5 * HOUR, 5 * HOUR]);
  });

  it('explains the busy time in the legend', () => {
    const days = [day('2026-01-05', { messages: 3, activeMs: 2 * HOUR })];
    const text = legendTooltip({ view: 'heatmap', metric: 'activeMs', days });
    assert.match(text, /最大 2\.0h \/ 日/);
    assert.ok(text.includes(ACTIVE_TIME_TITLE));
    assert.match(ACTIVE_TIME_TITLE, /24h を超える/);
    assert.match(ACTIVE_TIME_TITLE, /600 秒/);
  });

  it('lists the max of every metric when the bars are stacked', () => {
    const days = [day('2026-01-05', { messages: 3, tokens: 1000, activeMs: 2 * HOUR })];
    const text = legendTooltip({ view: 'bars', metric: 'messages', granularity: 'day', days, stacked: true });
    assert.match(text, /メッセージ: 最大 3 \/ 日/);
    assert.match(text, /トークン: 最大 1\.0K \/ 日/);
    assert.match(text, /稼働時間: 最大 2\.0h \/ 日/);
    // 並べるは棒ビューだけ。他のビューでは単一指標のまま
    assert.doesNotMatch(legendTooltip({ view: 'heatmap', metric: 'messages', days, stacked: true }), /段ごと/);
  });
});

describe('legendTooltip', () => {
  const days = [day('2026-01-05', { messages: 3, tokens: 1000 }), day('2026-01-06', { messages: 7, tokens: 5000 })];

  it('describes the heatmap scale and the daily max', () => {
    const text = legendTooltip({ view: 'heatmap', metric: 'messages', days });
    assert.match(text, /少 .* 多/);
    assert.match(text, /最大 7 \/ 日/);
  });

  it('uses the bucketed max for bars', () => {
    assert.match(legendTooltip({ view: 'bars', metric: 'messages', granularity: 'day', days }), /最大 7 \/ 日/);
    assert.match(legendTooltip({ view: 'bars', metric: 'tokens', granularity: 'week', days }), /最大 6\.0K \/ 週/);
  });

  it('explains the weekday totals', () => {
    assert.match(legendTooltip({ view: 'weekday', metric: 'tokens', days }), /直近 2 日のトークン/);
  });

  it('falls back to the raw metric key and handles no days', () => {
    assert.match(legendTooltip({ view: 'heatmap', metric: 'other', days: [] }), /other/);
    assert.match(legendTooltip({ view: 'calendar', metric: 'messages', days }), /絞り込む/);
  });
});

describe('fetchedAtLabel', () => {
  it('includes the last fetched time', () => {
    const at = new Date(2026, 10, 12, 9, 5).toISOString();
    assert.equal(fetchedAtLabel(at), '集計し直す（最終取得 11/12 09:05）');
    assert.equal(fetchedAtLabel(new Date(2026, 0, 2, 14, 30).getTime()), '集計し直す（最終取得 1/2 14:30）');
  });

  it('omits the time when unknown or invalid', () => {
    assert.equal(fetchedAtLabel(undefined), '集計し直す');
    assert.equal(fetchedAtLabel('not a date'), '集計し直す');
  });
});

describe('weeklyOutlier', () => {
  // 2026-01-05 は月曜。完全な週を weeks 個 + 今週を thisWeekDays 日
  const build = (weekValues, thisWeekValue, thisWeekDays = 3) => {
    const days = range('2026-01-05', weekValues.length * 7 + thisWeekDays);
    weekValues.forEach((v, w) => {
      days[w * 7].messages = v;
    });
    days[weekValues.length * 7].messages = thisWeekValue;
    return days;
  };

  it('flags this week when it exceeds the multiplier times the previous average', () => {
    const outlier = weeklyOutlier(build([10, 10, 10, 10], 25), 'messages');
    assert.ok(outlier);
    assert.equal(outlier.value, 25);
    assert.equal(outlier.average, 10);
    assert.equal(outlier.ratio, 2.5);
    assert.equal(outlier.key, '2026-02-02');
    assert.equal(outlierText(outlier), '今週 2.5×');
    assert.match(outlierTooltip(outlier, 'messages'), new RegExp(`平均 10 の ${OUTLIER_MULTIPLIER} 倍`));
  });

  it('does not flag values at or below the threshold', () => {
    assert.equal(weeklyOutlier(build([10, 10], 20), 'messages'), null);
    assert.equal(weeklyOutlier(build([10, 10], 5), 'messages'), null);
  });

  it('uses only the most recent full weeks as the baseline', () => {
    // 古い多忙な週は平均に入れない
    const weeks = [1000, ...new Array(OUTLIER_BASELINE_WEEKS).fill(10)];
    assert.ok(weeklyOutlier(build(weeks, 30), 'messages'));
  });

  it('ignores a partial first week and needs an active baseline', () => {
    // 先頭が水曜から始まる欠けた週だけ → 比べる相手が無い
    const partial = range('2026-01-07', 8);
    partial[7].messages = 50;
    assert.equal(weeklyOutlier(partial, 'messages'), null);
    // 直前の週が全部 0 なら平均 0 で判定しない
    assert.equal(weeklyOutlier(build([0, 0], 10), 'messages'), null);
  });

  it('returns null for too little data', () => {
    assert.equal(weeklyOutlier([], 'messages'), null);
    assert.equal(weeklyOutlier(undefined, 'messages'), null);
    assert.equal(weeklyOutlier(range('2026-01-05', 3), 'messages'), null);
    assert.equal(outlierText(null), '');
    assert.equal(outlierTooltip(null, 'messages'), '');
  });

  it('accepts a custom multiplier and metric', () => {
    const days = build([10, 10], 0);
    days[14].tokens = 15;
    days[0].tokens = 10;
    days[7].tokens = 10;
    assert.ok(weeklyOutlier(days, 'tokens', { multiplier: 1.2 }));
    assert.equal(weeklyOutlier(days, 'tokens'), null);
  });
});

describe('sparklinePoints / recentValues', () => {
  it('maps values into the box with a 1px margin', () => {
    assert.equal(sparklinePoints([0, 5, 10], { width: 10, height: 12 }), '0,11 5,6 10,1');
  });

  it('draws a flat baseline when everything is zero', () => {
    assert.equal(sparklinePoints([0, 0], { width: 4, height: 10 }), '0,9 4,9');
  });

  it('handles a single value and empty input', () => {
    assert.equal(sparklinePoints([3]), '0,1');
    assert.equal(sparklinePoints([]), '');
    assert.equal(sparklinePoints(undefined), '');
  });

  it('takes the last N days of the metric', () => {
    const days = range('2026-01-01', 40).map((d, i) => ({ ...d, messages: i }));
    const values = recentValues(days, 'messages');
    assert.equal(values.length, 30);
    assert.equal(values[0], 10);
    assert.equal(values[29], 39);
    assert.deepEqual(recentValues(days, 'tokens', 2), [0, 0]);
    assert.deepEqual(recentValues(undefined, 'messages'), []);
  });
});
