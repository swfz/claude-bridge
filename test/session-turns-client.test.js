import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatTurnTime,
  mainRepository,
  prLabel,
  relativeToCwd,
} from '../client/src/utils/sessionTurns.js';

// ローカル時刻で組み立てる（表示はローカル時刻）
const local = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    assert.equal(formatDuration(12_000), '12 秒');
    assert.equal(formatDuration(90_000), '2 分');
    assert.equal(formatDuration(60 * 60_000), '1 時間');
    assert.equal(formatDuration(95 * 60_000), '1 時間 35 分');
  });

  it('returns an empty string for unknown durations', () => {
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(undefined), '');
  });
});

describe('formatTurnTime', () => {
  it('shows the date only when the day changes', () => {
    const first = local(2026, 10, 4, 9, 5);
    assert.equal(formatTurnTime(first), '10/4 09:05');
    assert.equal(formatTurnTime(local(2026, 10, 4, 13, 30), first), '13:30');
    assert.equal(formatTurnTime(local(2026, 10, 5, 0, 10), first), '10/5 00:10');
  });

  it('returns an empty string for invalid timestamps', () => {
    assert.equal(formatTurnTime(''), '');
    assert.equal(formatTurnTime('not a date'), '');
  });
});

describe('relativeToCwd', () => {
  it('strips the cwd prefix and leaves other paths as is', () => {
    assert.equal(relativeToCwd('/repo/src/a.js', '/repo'), 'src/a.js');
    assert.equal(relativeToCwd('/repo/src/a.js', '/repo/'), 'src/a.js');
    assert.equal(relativeToCwd('/repo-other/a.js', '/repo'), '/repo-other/a.js');
    assert.equal(relativeToCwd('/a.js', ''), '/a.js');
  });
});

describe('prLabel / mainRepository', () => {
  const pr = (repository, number) => ({ repository, number, url: `https://github.com/${repository}/pull/${number}` });

  it('shows only the number for the main repository', () => {
    assert.equal(prLabel(pr('o/app', 3), 'o/app'), '#3');
    assert.equal(prLabel(pr('o/lib', 7), 'o/app'), 'o/lib#7');
    assert.equal(prLabel({ url: 'https://x/pull/1' }, 'o/app'), 'https://x/pull/1');
    assert.equal(prLabel(null, 'o/app'), '');
  });

  it('picks the repository with the most PRs', () => {
    const turns = [{ prs: [pr('o/app', 1), pr('o/lib', 2)] }, { prs: [pr('o/app', 3)] }, {}];
    assert.equal(mainRepository(turns), 'o/app');
    assert.equal(mainRepository([]), '');
  });
});
