import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPrStateReader, isPrUrl, parsePrState } from '../server/pr-state.js';

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
});
