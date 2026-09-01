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
  dayMonthTicks,
  barRatio,
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
  ...extra,
});

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

describe('dayMonthTicks', () => {
  it('marks the first day of each month by index', () => {
    const days = range('2026-08-30', 5); // 8/30, 8/31, 9/1, 9/2, 9/3
    assert.deepEqual(dayMonthTicks(days), [{ index: 2, label: '9月' }]);
  });

  it('never marks index 0 (there is no previous day to compare with)', () => {
    assert.deepEqual(dayMonthTicks(range('2026-09-01', 3)), []);
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
