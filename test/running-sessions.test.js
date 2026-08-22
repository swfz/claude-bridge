import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parsePaneId,
  normalizeRunningSession,
  listRunningSessions,
  mapPaneIdsToPids,
} from '../server/running-sessions.js';

describe('parsePaneId', () => {
  it('extracts the pane id from a tmux field', () => {
    assert.equal(parsePaneId('0:@5.%7'), '%7');
    assert.equal(parsePaneId('work:@12.%103'), '%103');
  });

  it('returns null for missing or malformed values', () => {
    assert.equal(parsePaneId(undefined), null);
    assert.equal(parsePaneId(null), null);
    assert.equal(parsePaneId(''), null);
    assert.equal(parsePaneId('0:@5.pane'), null);
    assert.equal(parsePaneId(123), null);
  });

  it('does not extract shell metacharacters', () => {
    // シェルに渡る値なので %<数字> 以外は必ず捨てる
    assert.equal(parsePaneId('0:@5.%7; rm -rf /'), null);
  });
});

describe('normalizeRunningSession', () => {
  const meta = {
    pid: 19425,
    sessionId: 'd41561d4-9e6a-454b-b406-3e7a739f1caa',
    cwd: '/Users/x/gh/claude-bridge',
    name: 'claude-bridge-76',
    status: 'busy',
    kind: 'interactive',
    version: '2.1.231',
    tmux: '0:@5.%7',
    startedAt: 1000,
    updatedAt: 2000,
  };

  it('keeps the fields the home view needs', () => {
    assert.deepEqual(normalizeRunningSession(meta), {
      pid: 19425,
      sessionId: 'd41561d4-9e6a-454b-b406-3e7a739f1caa',
      cwd: '/Users/x/gh/claude-bridge',
      name: 'claude-bridge-76',
      status: 'busy',
      kind: 'interactive',
      version: '2.1.231',
      tmuxTarget: '0:@5.%7',
      paneId: '%7',
      startedAt: 1000,
      updatedAt: 2000,
    });
  });

  it('falls back to statusUpdatedAt then startedAt for updatedAt', () => {
    assert.equal(
      normalizeRunningSession({
        ...meta,
        updatedAt: undefined,
        statusUpdatedAt: 1500,
      }).updatedAt,
      1500,
    );
    // どちらも無ければ起動時刻
    assert.equal(normalizeRunningSession({ ...meta, updatedAt: undefined }).updatedAt, 1000);
    assert.equal(normalizeRunningSession({ pid: 1, sessionId: 'a' }).updatedAt, null);
  });

  it('returns null when the session cannot be identified', () => {
    assert.equal(normalizeRunningSession(null), null);
    assert.equal(normalizeRunningSession({ sessionId: 'abc' }), null);
    assert.equal(normalizeRunningSession({ pid: 1 }), null);
    assert.equal(normalizeRunningSession({ pid: 'x', sessionId: 'abc' }), null);
  });

  it('tolerates a session without tmux info', () => {
    const r = normalizeRunningSession({ pid: 1, sessionId: 'a' });
    assert.equal(r.tmuxTarget, null);
    assert.equal(r.paneId, null);
    assert.equal(r.name, null);
  });
});

describe('listRunningSessions', () => {
  async function makeDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  it('returns only sessions whose process is alive, newest first', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', updatedAt: 100 }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 300 }),
      '3.json': JSON.stringify({ pid: 3, sessionId: 'c', updatedAt: 200 }),
    });
    const result = await listRunningSessions({
      dir,
      livePids: new Set([1, 2]),
    });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['b', 'a'],
    );
  });

  it('skips broken json and non-json files', async () => {
    const dir = await makeDir({
      '1.json': '{ this is not json',
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 1 }),
      '3.key': 'secret',
    });
    const result = await listRunningSessions({ dir, livePids: new Set([1, 2]) });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['b'],
    );
  });

  it('keeps every session when liveness cannot be determined', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', updatedAt: 1 }),
    });
    const result = await listRunningSessions({ dir, livePids: null });
    assert.equal(result.length, 1);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listRunningSessions({
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: new Set(),
    });
    assert.deepEqual(result, []);
  });
});

describe('mapPaneIdsToPids', () => {
  async function makeDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  it('resolves a pid from a matching, alive paneId', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([1]) });
    assert.deepEqual(Array.from(result.entries()), [['%5', 1]]);
  });

  it('ignores candidates whose pid is not alive', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([]) });
    assert.equal(result.size, 0);
  });

  it('picks the candidate with the newest updatedAt when a paneId is reused', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({
        pid: 1,
        sessionId: 'old',
        tmux: '0:@1.%5',
        updatedAt: 100,
      }),
      '2.json': JSON.stringify({
        pid: 2,
        sessionId: 'new',
        tmux: '0:@1.%5',
        updatedAt: 200,
      }),
    });
    const result = await mapPaneIdsToPids(['%5'], {
      dir,
      livePids: new Set([1, 2]),
    });
    assert.equal(result.get('%5'), 2);
  });

  it('returns an empty map without reading the directory when paneIds is empty', async () => {
    const result = await mapPaneIdsToPids([], {
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: new Set(),
    });
    assert.equal(result.size, 0);
  });

  it('ignores broken json files', async () => {
    const dir = await makeDir({
      '1.json': '{ this is not json',
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([2]) });
    assert.equal(result.get('%5'), 2);
  });
});
