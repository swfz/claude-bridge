// 活動ヒートマップ（草）の組み立て。表示に依存しない計算はここに寄せる。

export const HEAT_METRICS = [
  { key: 'messages', label: 'メッセージ' },
  { key: 'tokens', label: 'トークン' },
];

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 同じデータを別の切り口で見るためのビュー
export const ACTIVITY_VIEWS = [
  { key: 'heatmap', label: '草', title: '1 列 = 1 週。日ごとの濃淡で 1 年を俯瞰する' },
  { key: 'daily', label: '日別', title: '1 本 = 1 日。量の差を高さで正確に読む' },
  { key: 'weekly', label: '週別', title: '1 本 = 1 週（月曜始まり）。週単位の量を読む' },
  { key: 'monthly', label: '月別', title: '1 本 = 1 月。月単位の量を読む' },
  { key: 'weekday', label: '曜日', title: '曜日ごとの合計。週の中でどこに偏っているか' },
];

// 曜日別の集計は「週の並び」で読みたいので月曜始まりにする
// （草は GitHub と同じ日曜始まりなので、そこだけ並びが違う）
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// 'YYYY-MM-DD' を曜日番号（0=日）に。Date のタイムゾーン解釈に依存しないよう
// UTC で組み立てる（曜日は日付だけで決まる）
export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthOf(date) {
  return Number(date.slice(5, 7));
}

// 日付の並び（古い→新しい）を GitHub の草と同じ「1 列 = 1 週（日曜始まり）」に畳む。
// 先頭の週は曜日を合わせるため null で埋める。
export function buildWeeks(days) {
  const weeks = [];
  let current = null;
  for (const day of days) {
    const weekday = weekdayOf(day.date);
    if (!current || weekday === 0) {
      current = new Array(7).fill(null);
      weeks.push(current);
    }
    current[weekday] = day;
  }
  return weeks;
}

// 濃淡のしきい値。活動量は日によって桁が違う（トークンは特に）ので、
// 固定値ではなく「活動があった日」の分位で 4 段階に割る。
export function computeThresholds(values) {
  const positives = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positives.length === 0) return [1, 1, 1];
  const at = (ratio) => positives[Math.min(positives.length - 1, Math.floor(positives.length * ratio))];
  // 同じ値が続くと段が潰れるので、後ろの段は必ず前より大きくする
  // （補正後の値と比べないと 3 段目が 2 段目に並んでしまう）
  const thresholds = [];
  for (const value of [at(0.25), at(0.5), at(0.75)]) {
    const previous = thresholds[thresholds.length - 1];
    thresholds.push(previous === undefined ? value : Math.max(value, previous + 1));
  }
  return thresholds;
}

export function levelOf(value, thresholds) {
  if (!value) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

export function formatCount(n) {
  return (n || 0).toLocaleString('ja-JP');
}

// トークンは桁が大きいので単位付きに畳む
export function formatTokens(n) {
  const v = n || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function formatMetric(metric, value) {
  return metric === 'tokens' ? formatTokens(value) : formatCount(value);
}

export function formatDateLabel(date) {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}（${WEEKDAY_LABELS[weekdayOf(date)]}）`;
}

// ツールチップの内訳部分。日のセルと期間（週・月）のバケットで同じ内容を見せる
function breakdownLines(stats) {
  return [
    `メッセージ ${formatCount(stats.messages)}（あなた ${formatCount(stats.prompts)} / Claude ${formatCount(stats.replies)}）`,
    `トークン ${formatTokens(stats.tokens)}`,
    `  入力 ${formatTokens(stats.inputTokens)} / 出力 ${formatTokens(stats.outputTokens)}`,
    `  キャッシュ作成 ${formatTokens(stats.cacheCreationTokens)} / 読み ${formatTokens(stats.cacheReadTokens)}`,
  ];
}

// セルのツールチップ。メトリックを切り替えても内訳は両方見せる
export function cellTooltip(day) {
  if (!day) return '';
  const lines = [formatDateLabel(day.date)];
  if (day.messages === 0) {
    lines.push('活動なし');
    return lines.join('\n');
  }
  lines.push(...breakdownLines(day));
  return lines.join('\n');
}

// 曜日別の合計。value は合計、activeDays は「その曜日で活動があった日数」
export function weekdayTotals(days, metric) {
  const sums = new Array(7).fill(0);
  const actives = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const day of days) {
    const weekday = weekdayOf(day.date);
    sums[weekday] += day[metric] || 0;
    counts[weekday] += 1;
    if (day.messages > 0) actives[weekday] += 1;
  }
  return WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    label: WEEKDAY_LABELS[weekday],
    value: sums[weekday],
    activeDays: actives[weekday],
    totalDays: counts[weekday],
  }));
}

// --- 期間のバケット（日 / 週 / 月）---

// バケットに足し込む数値フィールド（日別セルと同じ名前で持つ）
const SUM_FIELDS = [
  'prompts',
  'replies',
  'messages',
  'tokens',
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
];

// 'YYYY-MM-DD' に日数を足す。曜日と同じく UTC で組み立ててローカル TZ に依存させない
function shiftDate(date, delta) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// その日が属する週の始まり。曜日別ビューと同じ月曜始まりにする
// （草だけが GitHub に合わせた日曜始まり）
function weekStartOf(date) {
  return shiftDate(date, -((weekdayOf(date) + 6) % 7));
}

function bucketIdOf(date, granularity) {
  if (granularity === 'week') return weekStartOf(date);
  if (granularity === 'month') return date.slice(0, 7);
  return date;
}

function shortDate(date) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function bucketLabel(bucket, granularity) {
  if (granularity === 'week') return `${shortDate(bucket.from)}〜${shortDate(bucket.to)}`;
  if (granularity === 'month') return `${bucket.key.slice(0, 4)}年${Number(bucket.key.slice(5, 7))}月`;
  return formatDateLabel(bucket.from);
}

// 日別セル（日付昇順）を期間ごとに畳む。from/to は「実際に含まれる日」なので、
// 先頭・末尾のバケットは欠けた週・月になり得る（表示している範囲の外までは数えない）
export function bucketDays(days, granularity = 'day') {
  const buckets = [];
  let current = null;
  let currentId = null;
  for (const day of days) {
    const id = bucketIdOf(day.date, granularity);
    if (!current || id !== currentId) {
      currentId = id;
      current = {
        key: granularity === 'month' ? id : day.date,
        from: day.date,
        to: day.date,
        label: '',
        days: 0,
        activeDays: 0,
        ...Object.fromEntries(SUM_FIELDS.map((field) => [field, 0])),
      };
      buckets.push(current);
    }
    current.to = day.date;
    current.days += 1;
    if (day.messages > 0) current.activeDays += 1;
    for (const field of SUM_FIELDS) current[field] += day[field] || 0;
  }
  for (const bucket of buckets) bucket.label = bucketLabel(bucket, granularity);
  return buckets;
}

// バケットのツールチップ。日は 1 日分のセルと同じ内容、週・月は見出しと稼働日数を足す
export function bucketTooltip(bucket, granularity = 'day') {
  if (!bucket) return '';
  if (granularity === 'day') return cellTooltip({ ...bucket, date: bucket.from });
  const lines = [`${bucket.label}（${bucket.days} 日）`];
  if (bucket.messages === 0) {
    lines.push('活動なし');
    return lines.join('\n');
  }
  lines.push(...breakdownLines(bucket), `稼働 ${bucket.activeDays} 日`);
  return lines.join('\n');
}

// 棒の下に添える月の目盛り。月別は全バケット、日別・週別は月が変わる位置（0 始まり）。
// 月別は先頭と 1 月に年（`year`）を添える。ラベルに年を混ぜると（`2026/1`）隣の `2月` と
// 連なって `2026/12月` に読めてしまうので、年は別の行に出す
export function bucketTicks(buckets, granularity = 'day') {
  if (granularity === 'month') {
    return buckets.map((bucket, index) => {
      const month = monthOf(bucket.from);
      const tick = { index, label: `${month}月` };
      if (index === 0 || month === 1) tick.year = bucket.from.slice(0, 4);
      return tick;
    });
  }
  const ticks = [];
  for (let i = 1; i < buckets.length; i++) {
    const month = monthOf(buckets[i].from);
    if (month !== monthOf(buckets[i - 1].from)) ticks.push({ index: i, label: `${month}月` });
  }
  return ticks;
}

// 棒の幅（CSS 変数 --bar）。本数が減るほど太くしないとスカスカに見える
export function barWidthFor(granularity) {
  if (granularity === 'week') return '10px';
  if (granularity === 'month') return '28px';
  return '3px';
}

// 選択中の期間と同じバケットか（選択は from/to の対で持つ）
export function periodEquals(a, b) {
  return !!a && !!b && a.from === b.from && a.to === b.to;
}

// 棒の高さ（0〜1）。全部 0 の期間で NaN にしない
export function barRatio(value, max) {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

// 週の列に付ける月ラベル。月が変わった最初の週にだけ出す
export function monthLabels(weeks) {
  const labels = [];
  let previous = null;
  weeks.forEach((week, index) => {
    const first = week.find(Boolean);
    if (!first) {
      labels.push(null);
      return;
    }
    const month = monthOf(first.date);
    const isNewMonth = month !== previous;
    previous = month;
    // 先頭の列は途中から始まる週なのでラベルを出さない（月の頭ではない）
    labels.push(isNewMonth && index > 0 ? `${month}月` : null);
  });
  return labels;
}
