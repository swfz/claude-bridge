import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  RATE_LIMIT_STALE_MS,
  buildUsageMeters,
  formatRemaining,
  formatResetAt,
  isRateLimitStale,
} from '../client/src/utils/usageMeter.js';

// 基本の振る舞いは home-redesign.test.js にある。ここは境界とラベルの確認
const now = new Date(2026, 10, 12, 10, 0, 0);

describe('usageMeter: 時刻表記の境界', () => {
  it('リセット時刻ちょうどは now', () => {
    assert.equal(formatRemaining(now.toISOString(), now), 'now');
  });

  it('同じ月日でも年が違えば日付を付ける', () => {
    assert.equal(formatResetAt(new Date(2027, 10, 12, 14, 30).toISOString(), now), '11/12 14:30');
  });

  it('同じ日にちでも月が違えば日付を付ける', () => {
    assert.equal(formatResetAt(new Date(2026, 11, 12, 14, 30).toISOString(), now), '12/12 14:30');
  });

  it('ちょうど 10 分前の取得はまだ古くない', () => {
    const t = 1_000_000_000;
    assert.equal(isRateLimitStale(t - RATE_LIMIT_STALE_MS, t), false);
  });
});

describe('usageMeter: buildUsageMeters のラベルと欠けたデータ', () => {
  const contextUsage = {
    contextTokens: 1000,
    contextWindow: 200_000,
    inputTokens: 1,
    cacheCreationTokens: 2,
    cacheReadTokens: 3,
  };

  it('各メーターのラベルは ctx / 5h / 7d', () => {
    const meters = buildUsageMeters({
      contextUsage,
      rateLimits: {
        usage: {
          fiveHour: { utilization: 1, resetsAt: null },
          sevenDay: { utilization: 2, resetsAt: null },
        },
      },
      now,
    });
    assert.deepEqual(
      meters.map((m) => m.label),
      ['ctx', '5h', '7d'],
    );
  });

  it('モデル不明の ctx の内訳はトークン数だけで終わる', () => {
    const [ctx] = buildUsageMeters({ contextUsage, now });
    assert.equal(ctx.detail.sub, 'input 1 · cache 作成 2 · cache 読み込み 3');
  });

  it('5h の窓が無くても 7d だけ出す', () => {
    const meters = buildUsageMeters({ rateLimits: { usage: { sevenDay: { utilization: 5, resetsAt: null } } }, now });
    assert.deepEqual(
      meters.map((m) => m.key),
      ['7d'],
    );
  });

  it('利用率の無い追加分は出さない', () => {
    const meters = buildUsageMeters({
      rateLimits: { usage: { extras: [{ label: 'opus', utilization: null, resetsAt: null }] } },
      now,
    });
    assert.deepEqual(meters, []);
  });
});
