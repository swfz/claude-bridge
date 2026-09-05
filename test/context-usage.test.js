import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { latestContextUsage, contextPercent, formatTokens, contextColorFor } from '../client/src/utils/contextUsage.js';

const usage = (contextTokens, contextWindow = 200_000) => ({ contextTokens, contextWindow });

describe('latestContextUsage', () => {
  it('picks the last message that carries contextUsage', () => {
    const messages = [
      { role: 'assistant', contextUsage: usage(1000) },
      { role: 'assistant', contextUsage: usage(2000) },
      { role: 'human' },
    ];
    assert.deepEqual(latestContextUsage(messages), usage(2000));
  });

  it('returns null when nothing carries it', () => {
    assert.equal(latestContextUsage([{ role: 'human' }, { role: 'assistant' }]), null);
    assert.equal(latestContextUsage([]), null);
    assert.equal(latestContextUsage(null), null);
  });
});

describe('contextPercent', () => {
  it('rounds to an integer percentage', () => {
    assert.equal(contextPercent(usage(100_000)), 50);
    assert.equal(contextPercent(usage(123_456)), 62);
    assert.equal(contextPercent(usage(123_456, 1_000_000)), 12);
  });

  it('clamps and tolerates missing data', () => {
    assert.equal(contextPercent(usage(400_000)), 100);
    assert.equal(contextPercent(usage(-100)), 0);
    assert.equal(contextPercent({ contextTokens: 10, contextWindow: 0 }), 0);
    assert.equal(contextPercent(null), 0);
  });
});

describe('formatTokens', () => {
  it('keeps values under 1000 as-is', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
  });

  it('uses k / M for larger values', () => {
    assert.equal(formatTokens(1000), '1.0k');
    assert.equal(formatTokens(123_400), '123.4k');
    assert.equal(formatTokens(1_000_000), '1.0M');
  });

  it('tolerates non-numbers', () => {
    assert.equal(formatTokens(undefined), '0');
  });
});

describe('contextColorFor', () => {
  it('matches the RateLimitMeter thresholds', () => {
    assert.equal(contextColorFor(0), 'var(--success)');
    assert.equal(contextColorFor(49), 'var(--success)');
    assert.equal(contextColorFor(50), 'var(--warning)');
    assert.equal(contextColorFor(79), 'var(--warning)');
    assert.equal(contextColorFor(80), 'var(--accent)');
  });
});
