import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLanes,
  buildCalendarDays,
  buildLegend,
  buildRuns,
  densityLevel,
  earliestOffsetMs,
  formatDayHeader,
  formatWeekRange,
  projectOf,
  segmentTooltip,
  shiftWeek,
  startOfWeek,
  weekDayStarts,
} from '../client/src/utils/calendar.js';

const SLOT = 10 * 60 * 1000;
// ローカル時刻で組み立てる（集計側もローカルの日付で切るため）
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const slotAt = (ms) => Math.floor(ms / SLOT);

describe('startOfWeek / weekDayStarts / shiftWeek', () => {
  it('returns Monday 0:00 of the week (Monday start)', () => {
    // 2026-10-04 は日曜 → 前の月曜 9/28
    assert.equal(startOfWeek(local(2026, 10, 4, 15)), local(2026, 9, 28));
    assert.equal(startOfWeek(local(2026, 9, 28, 0)), local(2026, 9, 28));
    assert.equal(startOfWeek(local(2026, 9, 30, 23, 59)), local(2026, 9, 28));
  });

  it('lists 7 day starts plus the end of the range', () => {
    const starts = weekDayStarts(local(2026, 9, 28));
    assert.equal(starts.length, 8);
    assert.equal(starts[0], local(2026, 9, 28));
    assert.equal(starts[6], local(2026, 10, 4));
    assert.equal(starts[7], local(2026, 10, 5));
  });

  it('moves by whole weeks', () => {
    assert.equal(shiftWeek(local(2026, 9, 28), 1), local(2026, 10, 5));
    assert.equal(shiftWeek(local(2026, 9, 28), -1), local(2026, 9, 21));
  });
});

describe('buildRuns', () => {
  it('joins slots separated by at most one empty slot', () => {
    const base = 1000;
    const runs = buildRuns(
      [
        [base, 1, 2, 0, 0],
        [base + 2, 0, 1, 1, 0], // 1 枠空き → つながる
        [base + 5, 1, 0, 0, 1], // 2 枠空き → 切れる
      ],
      SLOT,
    );
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((r) => [r.startMs, r.endMs, r.prompts, r.replies, r.research, r.edit]),
      [
        [base * SLOT, (base + 3) * SLOT, 1, 3, 1, 0],
        [(base + 5) * SLOT, (base + 6) * SLOT, 1, 0, 0, 1],
      ],
    );
    assert.deepEqual(runs[0].slots, [
      { startMs: base * SLOT, prompts: 1 },
      { startMs: (base + 2) * SLOT, prompts: 0 },
    ]);
  });

  it('sorts unsorted slots and handles empty input', () => {
    assert.deepEqual(buildRuns([], SLOT), []);
    assert.deepEqual(buildRuns(undefined, SLOT), []);
    const runs = buildRuns(
      [
        [11, 0, 1, 0, 0],
        [10, 1, 0, 0, 0],
      ],
      SLOT,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].startMs, 10 * SLOT);
  });

  it('honours a custom gap', () => {
    const slots = [
      [0, 1, 0, 0, 0],
      [3, 1, 0, 0, 0],
    ];
    assert.equal(buildRuns(slots, SLOT, 1).length, 2);
    assert.equal(buildRuns(slots, SLOT, 2).length, 1);
  });
});

describe('assignLanes', () => {
  const seg = (id, startMs, endMs) => ({ id, startMs, endMs });

  it('keeps non-overlapping segments in a single lane', () => {
    const result = assignLanes([seg('a', 0, 10), seg('b', 10, 20)]);
    assert.deepEqual(
      result.map((s) => [s.id, s.lane, s.lanes]),
      [
        ['a', 0, 1],
        ['b', 0, 1],
      ],
    );
  });

  it('puts overlapping segments side by side and reuses freed lanes', () => {
    const result = assignLanes([seg('a', 0, 30), seg('b', 5, 10), seg('c', 12, 20), seg('d', 40, 50)]);
    const byId = Object.fromEntries(result.map((s) => [s.id, s]));
    assert.equal(byId.a.lane, 0);
    assert.equal(byId.b.lane, 1);
    assert.equal(byId.c.lane, 1); // b が終わった後のレーンを使う
    // a〜c は 1 つの塊なのでレーン数は 2、d は別の塊で 1
    assert.equal(byId.a.lanes, 2);
    assert.equal(byId.c.lanes, 2);
    assert.equal(byId.d.lanes, 1);
  });

  it('returns an empty list for no segments', () => {
    assert.deepEqual(assignLanes([]), []);
  });
});

describe('projectOf / buildLegend', () => {
  it('uses the project name from cwd, falling back to projectDir', () => {
    assert.equal(projectOf({ cwd: '/Users/me/gh/claude-bridge' }), 'claude-bridge');
    assert.equal(projectOf({ cwd: '/Users/me/gh/app/.claude/worktrees/feat-x' }), 'app');
    assert.equal(projectOf({ cwd: '', projectDir: '-Users-me-gh-tool' }), 'tool');
    assert.equal(projectOf({ cwd: '', projectDir: '' }), '(不明)');
  });

  it('counts sessions per project, most first', () => {
    const legend = buildLegend([{ cwd: '/x/b' }, { cwd: '/x/a' }, { cwd: '/x/b' }]);
    assert.deepEqual(
      legend.map((l) => [l.project, l.count, l.color]),
      [
        ['b', 2, 0],
        ['a', 1, 1],
      ],
    );
  });

  it('gives distinct colors to up to 8 projects and wraps after that', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => ({ cwd: `/x/p${i}` }));
    const colors = buildLegend(sessions).map((l) => l.color);
    assert.deepEqual(colors, [0, 1, 2, 3, 4, 5, 6, 7, 0]);
  });
});

describe('buildCalendarDays', () => {
  const weekStartMs = local(2026, 9, 28);

  it('places runs on their day with offsets relative to that day', () => {
    const start = local(2026, 9, 29, 9, 0);
    const days = buildCalendarDays(
      [
        {
          sessionId: 's1',
          cwd: '/x/app',
          title: 'T',
          slots: [
            [slotAt(start), 2, 1, 0, 0],
            [slotAt(start) + 1, 0, 1, 0, 1],
          ],
        },
      ],
      { weekStartMs, slotMs: SLOT },
    );
    assert.equal(days.length, 7);
    assert.equal(days[0].segments.length, 0);
    const [seg] = days[1].segments;
    assert.equal(seg.sessionId, 's1');
    assert.equal(seg.project, 'app');
    assert.equal(seg.startMs, start);
    assert.equal(seg.endMs, start + 2 * SLOT);
    assert.equal(seg.prompts, 2);
    assert.equal(seg.lanes, 1);
  });

  it('splits a run that crosses midnight into both days', () => {
    const start = local(2026, 9, 29, 23, 50);
    const days = buildCalendarDays(
      [
        {
          sessionId: 's1',
          cwd: '/x/app',
          slots: [
            [slotAt(start), 1, 0, 0, 0],
            [slotAt(start) + 1, 1, 0, 0, 0],
          ],
        },
      ],
      { weekStartMs, slotMs: SLOT },
    );
    const [late] = days[1].segments;
    const [early] = days[2].segments;
    assert.equal(late.endMs, local(2026, 9, 30));
    assert.equal(early.startMs, local(2026, 9, 30));
    assert.equal(early.endMs, local(2026, 9, 30, 0, 10));
    // 発言の濃淡はその日の枠だけ
    assert.equal(late.slots.length, 1);
    assert.equal(early.slots.length, 1);
    // 帯全体の時間はツールチップ用に両方に残す
    assert.equal(late.runStartMs, start);
    assert.equal(early.runEndMs, local(2026, 9, 30, 0, 10));
  });

  it('lays parallel sessions out in lanes', () => {
    const start = local(2026, 10, 1, 10);
    const days = buildCalendarDays(
      [
        { sessionId: 'a', cwd: '/x/a', slots: [[slotAt(start), 1, 0, 0, 0]] },
        { sessionId: 'b', cwd: '/x/b', slots: [[slotAt(start), 1, 0, 0, 0]] },
      ],
      { weekStartMs, slotMs: SLOT },
    );
    const segs = days[3].segments;
    assert.deepEqual(segs.map((s) => s.lane).sort(), [0, 1]);
    assert.ok(segs.every((s) => s.lanes === 2));
    // 別プロジェクトは別の色
    assert.notEqual(segs[0].color, segs[1].color);
  });

  it('ignores activity outside the week', () => {
    const outside = local(2026, 10, 5, 1);
    const days = buildCalendarDays([{ sessionId: 'a', cwd: '/x/a', slots: [[slotAt(outside), 1, 0, 0, 0]] }], {
      weekStartMs,
      slotMs: SLOT,
    });
    assert.ok(days.every((d) => d.segments.length === 0));
  });

  it('reports the earliest offset across the week', () => {
    const days = buildCalendarDays(
      [
        { sessionId: 'a', cwd: '/x/a', slots: [[slotAt(local(2026, 9, 28, 9)), 1, 0, 0, 0]] },
        { sessionId: 'b', cwd: '/x/a', slots: [[slotAt(local(2026, 10, 2, 7, 30)), 1, 0, 0, 0]] },
      ],
      { weekStartMs, slotMs: SLOT },
    );
    assert.equal(earliestOffsetMs(days), (7 * 60 + 30) * 60000);
    assert.equal(earliestOffsetMs([{ dayStartMs: 0, segments: [] }]), null);
  });
});

describe('formatting helpers', () => {
  it('maps prompt counts to density levels', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 10].map(densityLevel), [0, 1, 2, 2, 3, 3]);
  });

  it('formats headers and ranges', () => {
    assert.equal(formatDayHeader(local(2026, 9, 28)), '月 9/28');
    assert.equal(formatWeekRange(local(2026, 9, 28)), '2026/9/28 〜 10/4');
  });

  it('builds a tooltip with title, cwd, time range and counts', () => {
    const tip = segmentTooltip({
      sessionId: 'abcdef123456',
      title: '',
      cwd: '/x/app',
      project: 'app',
      runStartMs: local(2026, 9, 28, 9),
      runEndMs: local(2026, 9, 28, 10, 30),
      prompts: 3,
      replies: 5,
      research: 2,
      edit: 1,
    });
    assert.equal(tip, 'abcdef12\n/x/app\n09:00〜10:30（1 時間 30 分）\n発言 3 · 応答 5 · 調査 2 · 編集 1');
  });
});
