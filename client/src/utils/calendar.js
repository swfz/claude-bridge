// 週間カレンダー（ホームの活動パネル）の組み立て。表示に依存しない計算はここに寄せる。
// サーバーから来るのはセッションごとの 10 分枠の集計（[枠番号, 発言, 応答, 調査, 編集]）で、
// それを「帯（連続して活動していた区間）」に束ね、日ごとに切り、重なりをレーンに割る。

import { parseCwd } from './cwdLabel.js';

export const CALENDAR_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
// 帯の中で許す「活動の無い枠」の数。10 分枠で 1 つ（=10 分）までは同じ帯、
// 20 分以上空いたら切る（止まっていた区間を空白として見せるため）
export const MAX_GAP_SLOTS = 1;
// プロジェクトの色の数（CSS の --cal-0〜--cal-7 と対応）。9 個目以降は色が一巡する
export const PALETTE_SIZE = 8;

// その日を含む週の月曜 0:00（ローカル）。棒の週別と同じ月曜始まり
export function startOfWeek(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  const offset = (date.getDay() + 6) % 7; // 月曜=0
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

// 週の各日の 0:00（ローカル）。DST をまたいでも日付で数える
export function weekDayStarts(weekStartMs, days = CALENDAR_DAYS) {
  const starts = [];
  for (let i = 0; i <= days; i++) {
    const date = new Date(weekStartMs);
    date.setDate(date.getDate() + i);
    starts.push(date.getTime());
  }
  return starts; // 末尾は最終日の翌日 0:00（範囲の終端）
}

export function shiftWeek(weekStartMs, weeks) {
  const date = new Date(weekStartMs);
  date.setDate(date.getDate() + weeks * 7);
  return date.getTime();
}

// セッションの枠を「空きが MAX_GAP_SLOTS 以下なら同じ帯」で束ねる。
// 各帯は [startMs, endMs) と合計値、帯の中の枠（発言量の濃淡用）を持つ。
export function buildRuns(slots, slotMs, maxGapSlots = MAX_GAP_SLOTS) {
  const sorted = [...(slots || [])].sort((a, b) => a[0] - b[0]);
  const runs = [];
  let current = null;
  for (const [index, prompts, replies, research, edit] of sorted) {
    if (!current || index - current.lastIndex - 1 > maxGapSlots) {
      current = { firstIndex: index, lastIndex: index, prompts: 0, replies: 0, research: 0, edit: 0, slots: [] };
      runs.push(current);
    }
    current.lastIndex = index;
    current.prompts += prompts;
    current.replies += replies;
    current.research += research;
    current.edit += edit;
    current.slots.push({ startMs: index * slotMs, prompts, research, edit });
  }
  return runs.map(({ firstIndex, lastIndex, ...rest }) => ({
    startMs: firstIndex * slotMs,
    endMs: (lastIndex + 1) * slotMs,
    ...rest,
  }));
}

// 重なる帯を横に並べる。開始順に「空いている一番左のレーン」へ置き（貪欲）、
// 互いに重なり合う塊ごとにレーン数を揃えて幅を等分する。
export function assignLanes(segments) {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const result = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  let laneEnds = [];

  const flush = () => {
    const lanes = laneEnds.length;
    for (const seg of cluster) result.push({ ...seg, lanes });
    cluster = [];
    laneEnds = [];
  };

  for (const seg of sorted) {
    if (seg.startMs >= clusterEnd && cluster.length > 0) flush();
    let lane = laneEnds.findIndex((end) => end <= seg.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(seg.endMs);
    } else {
      laneEnds[lane] = seg.endMs;
    }
    cluster.push({ ...seg, lane });
    clusterEnd = Math.max(clusterEnd, seg.endMs);
  }
  if (cluster.length > 0) flush();
  return result;
}

// プロジェクト名（色分けと凡例のキー）。cwd が取れなければ projectDir の末尾で代用する
export function projectOf(session) {
  const project = parseCwd(session.cwd).project;
  if (project) return project;
  const dir = session.projectDir || '';
  return dir.split('-').filter(Boolean).pop() || '(不明)';
}

// 帯を日ごとに切ってレーンを割り当てる。戻り値は日ごとの配列（週の 7 日分）。
export function buildCalendarDays(sessions, { weekStartMs, slotMs, maxGapSlots = MAX_GAP_SLOTS } = {}) {
  const starts = weekDayStarts(weekStartMs);
  const perDay = starts.slice(0, -1).map(() => []);
  const colors = new Map(buildLegend(sessions).map((item) => [item.project, item.color]));

  for (const session of sessions || []) {
    const project = projectOf(session);
    const color = colors.get(project);
    for (const run of buildRuns(session.slots, slotMs, maxGapSlots)) {
      for (let d = 0; d < perDay.length; d++) {
        const dayStart = starts[d];
        const dayEnd = starts[d + 1];
        if (run.endMs <= dayStart || run.startMs >= dayEnd) continue;
        perDay[d].push({
          key: `${session.sessionId}:${run.startMs}:${d}`,
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          cwd: session.cwd,
          title: session.title,
          project,
          color,
          // 0:00 をまたぐ帯は日ごとに切る（合計値は帯全体のものを両方に持たせる）
          startMs: Math.max(run.startMs, dayStart),
          endMs: Math.min(run.endMs, dayEnd),
          runStartMs: run.startMs,
          runEndMs: run.endMs,
          prompts: run.prompts,
          replies: run.replies,
          research: run.research,
          edit: run.edit,
          slots: run.slots.filter((s) => s.startMs >= dayStart && s.startMs < dayEnd),
        });
      }
    }
  }

  return perDay.map((segments, d) => ({
    dayStartMs: starts[d],
    dayEndMs: starts[d + 1],
    segments: assignLanes(segments),
  }));
}

// 凡例。プロジェクトごとのセッション数（多い順）。
// 色はこの順に割り当てる。名前のハッシュで決めると数プロジェクトでも衝突しやすく、
// 週の中で見分けられることの方が「週をまたいで同じ色」より大事なため
export function buildLegend(sessions) {
  const counts = new Map();
  for (const session of sessions || []) {
    const project = projectOf(session);
    counts.set(project, (counts.get(project) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project))
    .map((item, i) => ({ ...item, color: i % PALETTE_SIZE }));
}

// 帯の色の付け方。プロジェクトごと（既定）か、10 分枠ごとの「調査 / 実装 / 対話」か
export const COLOR_MODES = [
  { key: 'project', label: 'プロジェクト', title: 'リポジトリごとに色を分ける' },
  {
    key: 'phase',
    label: '調査 / 実装',
    title: '10 分ごとに、調査系ツールと編集系ツールのどちらが多かったかで色を分ける',
  },
];

export const PHASES = {
  research: { label: '調査', title: 'Read / Grep / Glob / WebFetch / WebSearch が多かった' },
  edit: { label: '実装', title: 'Edit / MultiEdit / Write / NotebookEdit が多かった（同数なら実装）' },
  talk: { label: '対話', title: '調査系・編集系のツールを使っていない（会話や Bash など）' },
};

// 10 分枠の作業の種類。同数なら実装に倒す（手を動かした枠を調査に埋もれさせない）
export function phaseOf(slot) {
  const research = slot.research || 0;
  const edit = slot.edit || 0;
  if (edit > 0 && edit >= research) return 'edit';
  if (research > 0) return 'research';
  return 'talk';
}

// 週の中で各種類に費やした時間（枠の数 × 枠の長さ）。0:00 で切った帯の枠は日ごとに
// 分かれているので、日ごとの帯の枠を足せば二重に数えない
export function phaseTotals(days, slotMs) {
  const totals = { research: 0, edit: 0, talk: 0 };
  for (const day of days) {
    for (const seg of day.segments) {
      for (const slot of seg.slots) totals[phaseOf(slot)] += slotMs;
    }
  }
  return totals;
}

export function formatHours(ms) {
  const hours = ms / 3600000;
  if (hours === 0) return '0 時間';
  return hours < 10 ? `${hours.toFixed(1)} 時間` : `${Math.round(hours)} 時間`;
}

// 発言量の濃淡（0〜3）。1 枠の発言は多くても数件なので固定のしきい値で足りる
export function densityLevel(prompts) {
  if (prompts <= 0) return 0;
  if (prompts === 1) return 1;
  if (prompts <= 3) return 2;
  return 3;
}

// 一番早い活動の時刻（その日の 0:00 からの ms）。初期スクロール位置に使う
export function earliestOffsetMs(days) {
  let earliest = null;
  for (const day of days) {
    for (const seg of day.segments) {
      const offset = seg.startMs - day.dayStartMs;
      if (earliest === null || offset < earliest) earliest = offset;
    }
  }
  return earliest;
}

const pad = (n) => String(n).padStart(2, '0');
export const formatClock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export function formatDayHeader(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatWeekRange(weekStartMs) {
  const start = new Date(weekStartMs);
  const end = new Date(weekStartMs);
  end.setDate(end.getDate() + CALENDAR_DAYS - 1);
  return `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()} 〜 ${end.getMonth() + 1}/${end.getDate()}`;
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 時間 ${rest} 分` : `${hours} 時間`;
}

export function segmentTooltip(seg) {
  const lines = [
    seg.title || seg.sessionId.slice(0, 8),
    seg.cwd || seg.project,
    `${formatClock(seg.runStartMs)}〜${formatClock(seg.runEndMs)}（${formatDuration(seg.runEndMs - seg.runStartMs)}）`,
    `発言 ${seg.prompts} · 応答 ${seg.replies} · 調査 ${seg.research} · 編集 ${seg.edit}`,
  ];
  return lines.join('\n');
}
