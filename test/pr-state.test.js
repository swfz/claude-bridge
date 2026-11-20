import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';

// 既定の取得（gh pr view）は本物の gh を呼ばないよう execFile を差し替えて確かめる
const execFileCalls = [];
let ghStdout = '{"state":"MERGED"}';
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    execFileCalls.push({ cmd, args, opts });
    cb(null, { stdout: ghStdout, stderr: '' });
  },
}));

const { clearPrStateCache, createPrStateReader, getPrState, isPrUrl, parsePrState } =
  await import('../server/pr-state.js');

const URL1 = 'https://github.com/o/r/pull/1';
const URL2 = 'https://github.com/o/r/pull/2';

// 呼ばれた URL を記録し、resolve を外から呼べる run
function deferredRun() {
  const calls = [];
  const pending = [];
  const run = (url) =>
    new Promise((resolve) => {
      calls.push(url);
      pending.push(resolve);
    });
  return { run, calls, pending };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('parsePrState / isPrUrl', () => {
  it('maps gh states to lower-case names and anything else to unknown', () => {
    assert.equal(parsePrState('{"state":"MERGED","mergedAt":"2026-10-01T00:00:00Z"}'), 'merged');
    assert.equal(parsePrState('{"state":"OPEN","mergedAt":null}'), 'open');
    assert.equal(parsePrState('{"state":"CLOSED","mergedAt":null}'), 'closed');
    assert.equal(parsePrState('{"state":"DRAFT"}'), 'unknown');
    assert.equal(parsePrState('not json'), 'unknown');
  });

  it('accepts only github.com pull request URLs', () => {
    assert.equal(isPrUrl(URL1), true);
    assert.equal(isPrUrl('https://github.com/my.org/repo-name/pull/123'), true);
    assert.equal(isPrUrl('https://example.com/o/r/pull/1'), false);
    assert.equal(isPrUrl('https://github.com/o/r/pull/1; rm -rf /'), false);
    assert.equal(isPrUrl('https://github.com/o/r/issues/1'), false);
    assert.equal(isPrUrl(undefined), false);
  });
});

describe('createPrStateReader', () => {
  it('returns unknown without calling run for an invalid URL', async () => {
    let called = 0;
    const reader = createPrStateReader({ run: async () => (called++, 'merged') });
    assert.equal(await reader.get('https://example.com/o/r/pull/1'), 'unknown');
    assert.equal(called, 0);
  });

  it('shares one call between concurrent requests for the same URL', async () => {
    const { run, calls, pending } = deferredRun();
    const reader = createPrStateReader({ run });
    const a = reader.get(URL1);
    const b = reader.get(URL1);
    await tick();
    assert.equal(calls.length, 1);
    pending[0]('open');
    assert.deepEqual(await Promise.all([a, b]), ['open', 'open']);
  });

  it('refetches open / unknown after the TTL but keeps merged / closed forever', async () => {
    let clock = 0;
    const states = { [URL1]: ['open', 'merged'], [URL2]: ['closed', 'open'] };
    const calls = [];
    const run = async (url) => (calls.push(url), states[url].shift());
    const reader = createPrStateReader({ run, ttlMs: 1000, now: () => clock });

    assert.equal(await reader.get(URL1), 'open');
    assert.equal(await reader.get(URL2), 'closed');
    clock = 999;
    assert.equal(await reader.get(URL1), 'open');
    assert.equal(calls.length, 2);

    clock = 5000;
    assert.equal(await reader.get(URL1), 'merged');
    assert.equal(await reader.get(URL2), 'closed');
    assert.deepEqual(calls, [URL1, URL2, URL1]);

    clock = 100000;
    assert.equal(await reader.get(URL1), 'merged');
    assert.equal(calls.length, 3);
  });

  it('treats errors and unexpected values as unknown and retries them after the TTL', async () => {
    let clock = 0;
    let n = 0;
    const run = async () => {
      n++;
      if (n === 1) throw new Error('gh: not logged in');
      return n === 2 ? 'weird' : 'merged';
    };
    const reader = createPrStateReader({ run, ttlMs: 10, now: () => clock });
    assert.equal(await reader.get(URL1), 'unknown');
    clock = 20;
    assert.equal(await reader.get(URL1), 'unknown');
    clock = 40;
    assert.equal(await reader.get(URL1), 'merged');
  });

  it('runs at most `concurrency` lookups at once', async () => {
    const { run, calls, pending } = deferredRun();
    const reader = createPrStateReader({ run, concurrency: 2 });
    const urls = [1, 2, 3, 4, 5].map((n) => `https://github.com/o/r/pull/${n}`);
    const results = urls.map((url) => reader.get(url));
    await tick();
    assert.equal(calls.length, 2);

    pending[0]('merged');
    await tick();
    await tick();
    assert.equal(calls.length, 3);

    pending[1]('open');
    pending[2]('closed');
    await tick();
    await tick();
    assert.equal(calls.length, 5);
    pending[3]('merged');
    pending[4]('open');
    assert.deepEqual(await Promise.all(results), ['merged', 'open', 'closed', 'merged', 'open']);
  });

  it('forgets everything on clear()', async () => {
    let n = 0;
    const reader = createPrStateReader({ run: async () => (n++, 'merged') });
    await reader.get(URL1);
    reader.clear();
    await reader.get(URL1);
    assert.equal(n, 2);
  });

  it('rejects URLs with a prefix before https and non-string values that stringify to a PR URL', () => {
    assert.equal(isPrUrl(`x${URL1}`), false);
    assert.equal(isPrUrl([URL1]), false);
    assert.equal(isPrUrl({ toString: () => URL1 }), false);
  });

  it('keeps open results for 5 minutes by default', async () => {
    let clock = 0;
    let n = 0;
    const reader = createPrStateReader({ run: async () => (n++, 'open'), now: () => clock });
    await reader.get(URL1);
    clock = 5 * 60 * 1000 - 1;
    await reader.get(URL1);
    assert.equal(n, 1);
    clock = 5 * 60 * 1000;
    await reader.get(URL1);
    assert.equal(n, 2);
  });

  it('measures the TTL from the time the result arrived', async () => {
    let clock = 1000;
    let n = 0;
    const reader = createPrStateReader({ run: async () => (n++, 'open'), ttlMs: 1000, now: () => clock });
    await reader.get(URL1);
    clock = 1500;
    await reader.get(URL1);
    assert.equal(n, 1);
    // ちょうど TTL が経ったら取り直す
    clock = 2000;
    await reader.get(URL1);
    assert.equal(n, 2);
  });

  it('drops the whole cache once 1000 URLs are cached', async () => {
    const calls = [];
    const reader = createPrStateReader({ run: async (url) => (calls.push(url), 'merged') });
    for (let i = 1; i <= 1000; i++) await reader.get(`https://github.com/o/r/pull/${i}`);
    // 999 件目までは merged のまま使い回す
    await reader.get(URL1);
    assert.equal(calls.length, 1000);
    // 1001 件目を入れるときに捨てるので、URL1 は取り直しになる
    await reader.get('https://github.com/o/r/pull/1001');
    await reader.get(URL1);
    assert.equal(calls.length, 1002);
    assert.equal(calls.at(-1), URL1);
  });
});

describe('getPrState (default reader using gh)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_BRIDGE_DISABLE_GH;
    delete process.env.CLAUDE_BRIDGE_DISABLE_GH;
    execFileCalls.length = 0;
    ghStdout = '{"state":"MERGED"}';
    clearPrStateCache();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_BRIDGE_DISABLE_GH;
    else process.env.CLAUDE_BRIDGE_DISABLE_GH = savedEnv;
    clearPrStateCache();
  });

  it('runs gh pr view without a shell and maps its JSON output', async () => {
    ghStdout = '{"state":"OPEN","mergedAt":null}';
    assert.equal(await getPrState(URL1), 'open');
    assert.deepEqual(execFileCalls, [
      { cmd: 'gh', args: ['pr', 'view', URL1, '--json', 'state,mergedAt'], opts: { timeout: 10000 } },
    ]);
  });

  it('caches results until clearPrStateCache()', async () => {
    assert.equal(await getPrState(URL1), 'merged');
    assert.equal(await getPrState(URL1), 'merged');
    assert.equal(execFileCalls.length, 1);
    clearPrStateCache();
    assert.equal(await getPrState(URL1), 'merged');
    assert.equal(execFileCalls.length, 2);
  });

  it('returns unknown without running gh when CLAUDE_BRIDGE_DISABLE_GH=1', async () => {
    process.env.CLAUDE_BRIDGE_DISABLE_GH = '1';
    assert.equal(await getPrState(URL1), 'unknown');
    assert.equal(execFileCalls.length, 0);
  });

  it('runs gh when CLAUDE_BRIDGE_DISABLE_GH is set to something other than 1', async () => {
    process.env.CLAUDE_BRIDGE_DISABLE_GH = '';
    assert.equal(await getPrState(URL1), 'merged');
    assert.equal(execFileCalls.length, 1);
  });
});
