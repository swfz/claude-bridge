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

// セルのツールチップ。メトリックを切り替えても内訳は両方見せる
export function cellTooltip(day) {
  if (!day) return '';
  const lines = [formatDateLabel(day.date)];
  if (day.messages === 0) {
    lines.push('活動なし');
    return lines.join('\n');
  }
  lines.push(
    `メッセージ ${formatCount(day.messages)}（あなた ${formatCount(day.prompts)} / Claude ${formatCount(day.replies)}）`,
  );
  lines.push(`トークン ${formatTokens(day.tokens)}`);
  lines.push(
    `  入力 ${formatTokens(day.inputTokens)} / 出力 ${formatTokens(day.outputTokens)}`,
    `  キャッシュ作成 ${formatTokens(day.cacheCreationTokens)} / 読み ${formatTokens(day.cacheReadTokens)}`,
  );
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

// 日別の棒グラフに添える月の目盛り。月が変わる日の位置（0 始まり）を返す
export function dayMonthTicks(days) {
  const ticks = [];
  for (let i = 1; i < days.length; i++) {
    const month = monthOf(days[i].date);
    if (month !== monthOf(days[i - 1].date)) ticks.push({ index: i, label: `${month}月` });
  }
  return ticks;
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
