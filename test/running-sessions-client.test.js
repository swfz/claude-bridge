import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOpenTab,
  annotateRunningSessions,
  annotateRecentSessions,
  findUnmatchedTabs,
  statusClass,
  formatElapsed,
} from '../client/src/utils/runningSessions.js';

const running = { pid: 100, sessionId: 'sid-a' };

describe('findOpenTab', () => {
  it('matches a tab by claudeSessionId', () => {
    const tabs = [
      { id: 't1', alive: true, claudeSessionId: 'sid-other' },
      { id: 't2', alive: true, claudeSessionId: 'sid-a' },
    ];
    assert.equal(findOpenTab(running, tabs).id, 't2');
  });

  it('falls back to claudePid when the JSONL is not resolved yet', () => {
    const tabs = [{ id: 't1', alive: true, claudePid: 100 }];
    assert.equal(findOpenTab(running, tabs).id, 't1');
  });

  it('prefers the claudeSessionId match over the pid match', () => {
    const tabs = [
      { id: 'pid-match', alive: true, claudePid: 100 },
      { id: 'sid-match', alive: true, claudeSessionId: 'sid-a' },
    ];
    assert.equal(findOpenTab(running, tabs).id, 'sid-match');
  });

  it('ignores dead tabs', () => {
    const tabs = [{ id: 't1', alive: false, claudeSessionId: 'sid-a' }];
    assert.equal(findOpenTab(running, tabs), null);
  });

  it('returns null when nothing matches', () => {
    assert.equal(findOpenTab(running, []), null);
    assert.equal(findOpenTab(running, undefined), null);
    assert.equal(findOpenTab(null, [{ id: 't1', alive: true }]), null);
  });

  it('does not match tabs without any identifier', () => {
    const tabs = [{ id: 't1', alive: true, claudeSessionId: null, claudePid: null }];
    assert.equal(findOpenTab({ pid: null, sessionId: 'sid-a' }, tabs), null);
  });
});

describe('annotateRunningSessions', () => {
  it('adds openTab for the sessions that are open as tabs', () => {
    const result = annotateRunningSessions(
      [
        { pid: 1, sessionId: 'sid-a' },
        { pid: 2, sessionId: 'sid-b' },
      ],
      [{ id: 't1', alive: true, claudeSessionId: 'sid-b' }],
    );
    assert.equal(result[0].openTab, null);
    assert.equal(result[1].openTab.id, 't1');
    // 元のフィールドは保持する
    assert.equal(result[1].pid, 2);
  });

  it('returns an empty array for missing input', () => {
    assert.deepEqual(annotateRunningSessions(null, []), []);
  });
});

describe('annotateRecentSessions', () => {
  it('drops the sessions that are currently running', () => {
    const result = annotateRecentSessions(
      [{ sessionId: 'sid-a' }, { sessionId: 'sid-b' }],
      [{ pid: 1, sessionId: 'sid-a' }],
      [],
    );
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['sid-b'],
    );
  });

  it('adds openTab for recent sessions opened as readonly tabs', () => {
    const result = annotateRecentSessions(
      [{ sessionId: 'sid-b' }],
      [],
      [
        { id: 't1', alive: true, claudeSessionId: 'sid-other' },
        { id: 't2', alive: true, claudeSessionId: 'sid-b' },
        { id: 't3', alive: false, claudeSessionId: 'sid-b' },
      ],
    );
    assert.equal(result[0].openTab.id, 't2');
  });

  it('returns an empty array for missing input', () => {
    assert.deepEqual(annotateRecentSessions(null, null, null), []);
  });
});

describe('findUnmatchedTabs', () => {
  it('returns tabs that are not backed by a running session', () => {
    const tabs = [
      { id: 't1', alive: true, claudeSessionId: 'sid-a' },
      { id: 't2', alive: true, claudeSessionId: 'sid-old' },
      { id: 't3', alive: false, claudeSessionId: 'sid-dead' },
    ];
    const result = findUnmatchedTabs([{ pid: 1, sessionId: 'sid-a' }], tabs);
    assert.deepEqual(
      result.map((t) => t.id),
      ['t2', 't3'],
    );
  });

  it('also excludes tabs that are shown in the recent list', () => {
    const tabs = [
      { id: 't1', alive: true, claudeSessionId: 'sid-recent' },
      { id: 't2', alive: true, claudeSessionId: 'sid-unknown' },
    ];
    const result = findUnmatchedTabs([], tabs, [{ sessionId: 'sid-recent' }]);
    assert.deepEqual(
      result.map((t) => t.id),
      ['t2'],
    );
  });

  it('returns all tabs when nothing is running', () => {
    const tabs = [{ id: 't1', alive: true, claudeSessionId: 'sid-a' }];
    assert.deepEqual(
      findUnmatchedTabs([], tabs).map((t) => t.id),
      ['t1'],
    );
  });
});

describe('statusClass', () => {
  it('maps working states to busy', () => {
    assert.equal(statusClass('busy'), 'busy');
    assert.equal(statusClass('working'), 'busy');
  });

  it('maps everything else to idle', () => {
    assert.equal(statusClass('shell'), 'idle');
    assert.equal(statusClass(null), 'idle');
  });
});

describe('formatElapsed', () => {
  const now = 1_000_000_000;

  it('formats seconds, minutes, hours and days', () => {
    assert.equal(formatElapsed(now - 5_000, now), '5秒前');
    assert.equal(formatElapsed(now - 120_000, now), '2分前');
    assert.equal(formatElapsed(now - 3 * 3600_000, now), '3時間前');
    assert.equal(formatElapsed(now - 2 * 86400_000, now), '2日前');
  });

  it('handles missing and future timestamps', () => {
    assert.equal(formatElapsed(null, now), '');
    assert.equal(formatElapsed(now + 5_000, now), 'たった今');
  });

  it('accepts ISO strings (recent sessions use them)', () => {
    const base = Date.parse('2026-08-17T05:00:00.000Z');
    assert.equal(formatElapsed('2026-08-17T03:00:00.000Z', base), '2時間前');
    assert.equal(formatElapsed('not a date', base), '');
  });
});
