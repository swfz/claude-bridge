// 活動ヒートマップ（草）の組み立て。表示に依存しない計算はここに寄せる。

// activeMs は AI 稼働時間（推論＋ツール実行の ms。サーバーが週間カレンダーと同じ数え方で日別に出す）
export const HEAT_METRICS = [
  { key: 'messages', label: 'メッセージ' },
  { key: 'tokens', label: 'トークン' },
  { key: 'activeMs', label: '稼働時間' },
];

// localStorage の指標を検証する（知らない値は既定のメッセージ）
export function normalizeMetric(stored) {
  return HEAT_METRICS.some((m) => m.key === stored) ? stored : 'messages';
}

// AI 稼働時間の説明。見出しの合計と、指標が稼働時間のときの凡例に添える
export const ACTIVE_TIME_TITLE =
  'AI 稼働時間: 推論とツール実行の時間を呼び出しごとに足したもの。' +
  '並行セッション・サブエージェントも合算するので 1 日 24h を超えることがある。1 回の呼び出しは 600 秒で打ち切り';

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 同じデータを別の切り口で見るためのビュー。棒の粒度（日 / 週 / 月）は「棒」の下位トグル
export const ACTIVITY_VIEWS = [
  { key: 'heatmap', label: '草', title: '1 列 = 1 週。日ごとの濃淡で 1 年を俯瞰する' },
  { key: 'bars', label: '棒', title: '1 本 = 1 日 / 1 週 / 1 月。量の差を高さで正確に読む' },
  { key: 'weekday', label: '曜日', title: '曜日ごとの合計。週の中でどこに偏っているか' },
  { key: 'calendar', label: 'カレンダー', title: '1 週間の時刻 × 曜日に、セッションの活動区間を帯で並べる' },
];

export const BAR_GRANULARITIES = [
  { key: 'day', label: '日別', title: '1 本 = 1 日' },
  { key: 'week', label: '週別', title: '1 本 = 1 週（月曜始まり）' },
  { key: 'month', label: '月別', title: '1 本 = 1 月' },
];

// 以前は日別・週別・月別がそれぞれ独立したビューだった。保存済みの値はここで読み替える
const LEGACY_BAR_VIEWS = { daily: 'day', weekly: 'week', monthly: 'month' };

// localStorage のビュー（旧値を含む）を { view, granularity } に直す。
// granularity は旧値から読み替えたときだけ入る（それ以外は null＝保存済みの粒度を使う）
export function normalizeActivityView(stored) {
  if (LEGACY_BAR_VIEWS[stored]) return { view: 'bars', granularity: LEGACY_BAR_VIEWS[stored] };
  if (ACTIVITY_VIEWS.some((v) => v.key === stored)) return { view: stored, granularity: null };
  return { view: 'heatmap', granularity: null };
}

export function normalizeGranularity(stored) {
  return BAR_GRANULARITIES.some((g) => g.key === stored) ? stored : 'day';
}

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

// AI 稼働時間（ms）を 3.2h / 45m に。並行分を合算するので 24h を超えてもそのまま出す
export function formatDuration(ms) {
  const v = ms || 0;
  const hours = v / 3600000;
  if (hours >= 100) return `${Math.round(hours).toLocaleString('ja-JP')}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(v / 60000)}m`;
}

export function formatMetric(metric, value) {
  if (metric === 'tokens') return formatTokens(value);
  if (metric === 'activeMs') return formatDuration(value);
  return formatCount(value);
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
    `AI 稼働 ${formatDuration(stats.activeMs)}`,
  ];
}

// メッセージも稼働も無い期間。0:00 をまたいだ呼び出しの続きだけの日は稼働だけがある
const isIdle = (stats) => stats.messages === 0 && !stats.activeMs;

// セルのツールチップ。メトリックを切り替えても内訳は両方見せる
export function cellTooltip(day) {
  if (!day) return '';
  const lines = [formatDateLabel(day.date)];
  if (isIdle(day)) {
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
  'activeMs',
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
  if (isIdle(bucket)) {
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

// --- ヘッダーの要約・ツールチップ ---

// 見出しの数字。何の合計かが読めるよう期間を先頭に付ける
// 「稼働 N 日」（活動のあった日数）と紛れないよう、稼働時間は「AI 稼働」と書く
export function summaryText(total, dayCount) {
  if (!total) return '';
  return [
    `直近 ${dayCount} 日`,
    `${formatCount(total.messages)} メッセージ`,
    `${formatTokens(total.tokens)} トークン`,
    ...(typeof total.activeMs === 'number' ? [`AI 稼働 ${formatDuration(total.activeMs)}`] : []),
    `稼働 ${total.activeDays} 日`,
  ].join(' · ');
}

const UNIT_LABEL = { day: '日', week: '週', month: '月' };

// 常時は出さない凡例（濃淡の意味・最大値）。情報アイコンのツールチップに回す
export function legendTooltip({ view, metric, granularity = 'day', days, stacked = false }) {
  const metricLabel = HEAT_METRICS.find((m) => m.key === metric)?.label || metric;
  const lines = [];
  if (view === 'bars' && stacked) {
    const buckets = granularity === 'day' ? days : bucketDays(days, granularity);
    lines.push('高さ: 段ごとに、その指標の最大値に対する線形（同じ列は同じ期間）');
    for (const m of HEAT_METRICS) {
      const max = Math.max(0, ...buckets.map((b) => b[m.key] || 0));
      lines.push(`${m.label}: 最大 ${formatMetric(m.key, max)} / ${UNIT_LABEL[granularity]}`);
    }
    lines.push(ACTIVE_TIME_TITLE);
  } else if (view === 'heatmap') {
    lines.push(`濃淡: 少 ░▒▓█ 多（${metricLabel}。活動があった日の 25/50/75% 点で 4 段階）`);
    const max = Math.max(0, ...days.map((d) => d[metric] || 0));
    lines.push(`最大 ${formatMetric(metric, max)} / 日`);
  } else if (view === 'bars') {
    const buckets = granularity === 'day' ? days : bucketDays(days, granularity);
    const max = Math.max(0, ...buckets.map((b) => b[metric] || 0));
    lines.push(`高さ: ${metricLabel}（最大値に対する線形）`);
    lines.push(`最大 ${formatMetric(metric, max)} / ${UNIT_LABEL[granularity]}`);
  } else if (view === 'weekday') {
    lines.push(`直近 ${days.length} 日の${metricLabel}を曜日ごとに合計`);
  }
  if (metric === 'activeMs' && !(view === 'bars' && stacked)) lines.push(ACTIVE_TIME_TITLE);
  lines.push('棒・升目のクリックでその期間に一覧を絞り込む');
  return lines.join('\n');
}

// 取得時刻（ISO 文字列か ms）を「最終取得 11/12 14:05」に
export function fetchedAtLabel(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '集計し直す';
  const pad = (n) => String(n).padStart(2, '0');
  return `集計し直す（最終取得 ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}）`;
}

// --- 外れ値（今週の突出）---

// 今週の値が「直前の週の平均」の何倍を超えたら警告色で知らせるか
export const OUTLIER_MULTIPLIER = 2;
// 比べる直前の週の数。古い休眠期間まで平均に入れると警告が出すぎるので直近に限る
export const OUTLIER_BASELINE_WEEKS = 8;

// 今週（最後の週バケット）が直前の週の平均の OUTLIER_MULTIPLIER 倍を超えていれば
// { value, average, ratio, label } を返す。そうでなければ null（何も出さない）
export function weeklyOutlier(
  days,
  metric,
  { multiplier = OUTLIER_MULTIPLIER, baselineWeeks = OUTLIER_BASELINE_WEEKS } = {},
) {
  const weeks = bucketDays(days || [], 'week');
  if (weeks.length < 2) return null;
  const current = weeks[weeks.length - 1];
  // 先頭の欠けた週は量が少なく見えるので平均に入れない
  const baseline = weeks
    .slice(0, -1)
    .filter((w) => w.days === 7)
    .slice(-baselineWeeks);
  if (baseline.length === 0) return null;
  const average = baseline.reduce((sum, w) => sum + (w[metric] || 0), 0) / baseline.length;
  const value = current[metric] || 0;
  if (average <= 0 || value <= average * multiplier) return null;
  return { value, average, ratio: value / average, key: current.key, label: current.label };
}

export function outlierText(outlier) {
  if (!outlier) return '';
  return `今週 ${outlier.ratio.toFixed(1)}×`;
}

export function outlierTooltip(outlier, metric) {
  if (!outlier) return '';
  return `今週（${outlier.label}）は ${formatMetric(metric, outlier.value)}。直前 ${OUTLIER_BASELINE_WEEKS} 週の平均 ${formatMetric(
    metric,
    Math.round(outlier.average),
  )} の ${OUTLIER_MULTIPLIER} 倍を超えている`;
}

// --- 畳んだときのスパークライン ---

export const SPARKLINE_DAYS = 30;

// 直近 n 日の値で折れ線の points 属性（"x,y x,y …"）を作る。上下 1px の余白を取る
export function sparklinePoints(values, { width = 80, height = 16 } = {}) {
  if (!values || values.length === 0) return '';
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const usable = height - 2;
  return values
    .map((v, i) => {
      const y = max > 0 ? 1 + usable - (v / max) * usable : height - 1;
      return `${+(i * step).toFixed(2)},${+y.toFixed(2)}`;
    })
    .join(' ');
}

export function recentValues(days, metric, n = SPARKLINE_DAYS) {
  return (days || []).slice(-n).map((d) => d[metric] || 0);
}
