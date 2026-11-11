// ホーム・トップバーのリデザインで足した純粋関数のテスト
// （ディレクトリ色・プロジェクトの件数順・共有モードの非表示件数・使用量メーター）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirColorOf, groupColorMap, shownTabGroups } from '../client/src/utils/tabGroups.js';
import { rankProjects } from '../client/src/utils/sessionSearch.js';
import { countHiddenSensitive } from '../client/src/utils/sensitiveSessions.js';
import { USAGE_DANGER, USAGE_WARN, isUsageNotable, usageColor } from '../client/src/utils/contextUsage.js';
import {
  buildUsageMeters,
  formatClock,
  formatRemaining,
  formatResetAt,
  isRateLimitStale,
  RATE_LIMIT_STALE_MS,
} from '../client/src/utils/usageMeter.js';

const tab = (id, cwd, extra = {}) => ({ id, cwd, ...extra });

describe('shownTabGroups / groupColorMap / dirColorOf', () => {
  const groups = [
    { key: 'g:1', label: 'mine', manual: true, sessions: [] },
    { key: 'p:gh/alpha', label: 'alpha', manual: false, sessions: [tab('a', '/home/u/gh/alpha')] },
    {
      key: 'p:gh/beta',
      label: 'beta',
      manual: false,
      sessions: [tab('b', '/home/u/gh/beta', { claudeSessionId: 'secret' })],
    },
    { key: 'p:gh/gamma', label: 'gamma', manual: false, sessions: [tab('c', '/home/u/gh/gamma')] },
  ];

  it('隠すタブを除き、空の自動グループは落とす（手動は空でも残す）', () => {
    const shown = shownTabGroups(groups, (s) => s.claudeSessionId === 'secret');
    assert.deepEqual(
      shown.map((g) => g.key),
      ['g:1', 'p:gh/alpha', 'p:gh/gamma'],
    );
  });

  it('色は表示順で --cal-N を回す（隠したグループの分は詰める）', () => {
    const colors = groupColorMap(shownTabGroups(groups, (s) => s.claudeSessionId === 'secret'));
    assert.equal(colors.get('g:1'), 'var(--cal-0)');
    assert.equal(colors.get('p:gh/alpha'), 'var(--cal-1)');
    assert.equal(colors.get('p:gh/gamma'), 'var(--cal-2)');
    assert.equal(colors.has('p:gh/beta'), false);
  });

  it('9 個目以降は先頭の色に戻る', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ key: `g:${i}`, manual: true, sessions: [] }));
    assert.equal(groupColorMap(many).get('g:8'), 'var(--cal-0)');
  });

  it('cwd から自動グループの色を引く。worktree は元リポジトリの色、無ければ null', () => {
    const colors = groupColorMap(shownTabGroups(groups));
    assert.equal(dirColorOf(colors, '/home/u/gh/alpha'), 'var(--cal-1)');
    assert.equal(dirColorOf(colors, '/home/u/gh/alpha/.claude/worktrees/x'), 'var(--cal-1)');
    assert.equal(dirColorOf(colors, '/home/u/gh/unknown'), null);
    assert.equal(dirColorOf(colors, ''), null);
    assert.equal(dirColorOf(null, '/home/u/gh/alpha'), null);
  });

  it('groups が無ければ空', () => {
    assert.deepEqual(shownTabGroups(null), []);
    assert.equal(groupColorMap(null).size, 0);
  });
});

describe('rankProjects', () => {
  it('件数の多い順、同数は名前順。代表の cwd を持つ', () => {
    const ranked = rankProjects([
      { cwd: '/h/gh/beta' },
      { cwd: '/h/gh/alpha' },
      { cwd: '/h/gh/beta/.claude/worktrees/w1' },
      { cwd: '/h/gh/gamma' },
      { cwd: '' },
      null,
    ]);
    assert.deepEqual(ranked, [
      { project: 'beta', count: 2, cwd: '/h/gh/beta' },
      { project: 'alpha', count: 1, cwd: '/h/gh/alpha' },
      { project: 'gamma', count: 1, cwd: '/h/gh/gamma' },
    ]);
  });

  it('空・null は空配列', () => {
    assert.deepEqual(rankProjects(null), []);
  });
});

describe('countHiddenSensitive', () => {
  it('タブ・起動中・直近に出てくるセンシティブ指定を重複なしで数える', () => {
    const n = countHiddenSensitive(['s1', 's2', 's3'], {
      tabs: [{ claudeSessionId: 's1' }, { claudeSessionId: null }, { claudeSessionId: 'x' }],
      running: [{ sessionId: 's1' }, { sessionId: 's2' }],
      recent: [{ sessionId: 'y' }],
    });
    assert.equal(n, 2);
  });

  it('入力が無ければ 0', () => {
    assert.equal(countHiddenSensitive(['a']), 0);
    assert.equal(countHiddenSensitive(null, { tabs: [{ claudeSessionId: 'a' }] }), 0);
  });
});

describe('usageColor / isUsageNotable', () => {
  it('40% で黄、60% で赤', () => {
    assert.equal(USAGE_WARN, 40);
    assert.equal(USAGE_DANGER, 60);
    assert.equal(usageColor(39), 'var(--success)');
    assert.equal(usageColor(40), 'var(--warning)');
    assert.equal(usageColor(60), 'var(--danger)');
  });

  it('しきい値以上だけ数値を出す対象', () => {
    assert.equal(isUsageNotable(39), false);
    assert.equal(isUsageNotable(40), true);
    assert.equal(isUsageNotable(NaN), false);
  });
});

describe('usageMeter の時刻表記', () => {
  const now = new Date(2026, 10, 12, 10, 0, 0);

  it('formatRemaining は分・時間・日で畳む', () => {
    assert.equal(formatRemaining(new Date(2026, 10, 12, 10, 5).toISOString(), now), '5m');
    assert.equal(formatRemaining(new Date(2026, 10, 12, 12, 13).toISOString(), now), '2h13m');
    assert.equal(formatRemaining(new Date(2026, 10, 15, 11, 28).toISOString(), now), '3d1h28m');
    assert.equal(formatRemaining(new Date(2026, 10, 12, 9, 0).toISOString(), now), 'now');
    assert.equal(formatRemaining(null, now), null);
    assert.equal(formatRemaining('broken', now), null);
  });

  it('formatClock は HH:MM', () => {
    assert.equal(formatClock(new Date(2026, 0, 1, 7, 5).getTime()), '07:05');
    assert.equal(formatClock(null), null);
    assert.equal(formatClock('broken'), null);
  });

  it('formatResetAt は今日なら時刻だけ、別の日なら日付を付ける', () => {
    assert.equal(formatResetAt(new Date(2026, 10, 12, 14, 30).toISOString(), now), '14:30');
    assert.equal(formatResetAt(new Date(2026, 10, 14, 9, 0).toISOString(), now), '11/14 09:00');
    assert.equal(formatResetAt(undefined, now), null);
  });

  it('isRateLimitStale は fetchedAt が 10 分より古いと真', () => {
    const t = 1_000_000_000;
    assert.equal(isRateLimitStale(t - RATE_LIMIT_STALE_MS - 1, t), true);
    assert.equal(isRateLimitStale(t - 1000, t), false);
    assert.equal(isRateLimitStale(null, t), false);
  });
});

describe('buildUsageMeters', () => {
  const now = new Date(2026, 10, 12, 10, 0, 0);
  const contextUsage = {
    contextTokens: 450_000,
    contextWindow: 1_000_000,
    inputTokens: 10,
    cacheCreationTokens: 20,
    cacheReadTokens: 30,
    model: 'claude-opus-5-5',
  };
  const rateLimits = {
    usage: {
      fiveHour: { utilization: 28.000000000000004, resetsAt: new Date(2026, 10, 12, 12, 20).toISOString() },
      sevenDay: { utilization: 72, resetsAt: new Date(2026, 10, 14, 9, 0).toISOString() },
      extras: [{ label: 'opus', utilization: 10, resetsAt: null }],
    },
    fetchedAt: now.getTime(),
  };

  it('ctx → 5h → 7d → 追加分の順に並べ、しきい値を超えたものだけ notable', () => {
    const meters = buildUsageMeters({ contextUsage, rateLimits, now });
    assert.deepEqual(
      meters.map((m) => [m.key, m.value, m.notable, m.color, !!m.extra]),
      [
        ['ctx', 45, true, 'var(--warning)', false],
        ['5h', 28, false, 'var(--success)', false],
        ['7d', 72, true, 'var(--danger)', false],
        ['extra:opus', 10, false, 'var(--success)', true],
      ],
    );
  });

  it('リセット時刻と残り時間を detail に入れる', () => {
    const [ctx, five, seven, extra] = buildUsageMeters({ contextUsage, rateLimits, now });
    assert.match(ctx.detail.text, /450\.0k \/ 1\.0M/);
    assert.match(ctx.detail.sub, /claude-opus-5-5/);
    assert.equal(five.detail.text, 'リセット 12:20（残り 2h20m）');
    assert.equal(seven.detail.text, 'リセット 11/14 09:00（残り 1d23h0m）');
    assert.equal(extra.detail.text, 'リセット時刻不明');
  });

  it('利用率の無い窓・データ無しは落とす', () => {
    assert.deepEqual(buildUsageMeters(), []);
    const meters = buildUsageMeters({
      rateLimits: { usage: { fiveHour: { utilization: null }, sevenDay: { utilization: 150, resetsAt: null } } },
      now,
    });
    assert.deepEqual(
      meters.map((m) => [m.key, m.pct]),
      [['7d', 100]],
    );
  });

  it('model が無い ctx は sub にモデル名を付けない', () => {
    const [ctx] = buildUsageMeters({ contextUsage: { ...contextUsage, model: undefined }, now });
    assert.doesNotMatch(ctx.detail.sub, /undefined/);
  });
});
