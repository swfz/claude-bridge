import { describe, it, afterAll, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { normalizeUsage, readRateLimits } from '../server/rate-limits.js';

const TMP = mkdtempSync(join(tmpdir(), 'bridge-rate-limits-'));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeJson(name, obj) {
  const file = join(TMP, name);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('normalizeUsage', () => {
  it('normalizes five_hour/seven_day (statusline used_percentage/epoch秒) and extras', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 42, resets_at: 1712859600 },
      seven_day: { used_percentage: 71.5, resets_at: 1713464400 },
      seven_day_sonnet: { used_percentage: 30, resets_at: 1713464400 },
      seven_day_opus: { used_percentage: 5, resets_at: 1713464400 },
    });
    assert.deepEqual(usage.fiveHour, {
      utilization: 42,
      resetsAt: new Date(1712859600 * 1000).toISOString(),
    });
    assert.deepEqual(usage.sevenDay, {
      utilization: 71.5,
      resetsAt: new Date(1713464400 * 1000).toISOString(),
    });
    assert.equal(usage.extras.length, 2);
    assert.deepEqual(usage.extras[0], {
      key: 'seven_day_sonnet',
      label: '7d Sonnet',
      utilization: 30,
      resetsAt: new Date(1713464400 * 1000).toISOString(),
    });
    assert.deepEqual(usage.extras[1], {
      key: 'seven_day_opus',
      label: '7d Opus',
      utilization: 5,
      resetsAt: new Date(1713464400 * 1000).toISOString(),
    });
  });

  it('accepts an ISO string resets_at as-is (forward compat with API-shaped input)', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 10, resets_at: '2026-08-18T10:00:00Z' },
      seven_day: { used_percentage: 20 },
    });
    assert.equal(usage.fiveHour.resetsAt, '2026-08-18T10:00:00Z');
  });

  it('treats missing/non-numeric used_percentage as null', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 'not-a-number', resets_at: 1712859600 },
      seven_day: { used_percentage: 50, resets_at: 1713464400 },
    });
    assert.equal(usage.fiveHour.utilization, null);
    assert.equal(usage.sevenDay.utilization, 50);
  });

  it('treats an explicit null used_percentage as null, not 0', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: null },
      seven_day: { used_percentage: 50 },
    });
    assert.equal(usage.fiveHour.utilization, null);
  });

  it('treats missing resets_at as null', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20, resets_at: 1713464400 },
    });
    assert.equal(usage.fiveHour.resetsAt, null);
  });

  it('returns null when both windows are invalid', () => {
    const usage = normalizeUsage({ five_hour: {}, seven_day: {} });
    assert.equal(usage, null);
  });

  it('returns null for missing/malformed input', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage(undefined), null);
  });

  it('does not include extras with non-finite used_percentage', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20 },
      seven_day_sonnet: { used_percentage: 'n/a' },
    });
    assert.equal(usage.extras.length, 0);
  });
});

describe('readRateLimits', () => {
  it('reads and normalizes a valid tee file', async () => {
    const file = writeJson('valid.json', {
      rate_limits: {
        five_hour: { used_percentage: 33, resets_at: 1712859600 },
        seven_day: { used_percentage: 12, resets_at: 1713464400 },
      },
      ts: 1700000000000,
    });
    const result = await readRateLimits({ filePath: file });
    assert.equal(result.ok, true);
    assert.equal(result.usage.fiveHour.utilization, 33);
    assert.equal(result.fetchedAt, 1700000000000);
  });

  it('falls back to file mtime when ts is missing/invalid', async () => {
    const file = writeJson('no-ts.json', {
      rate_limits: {
        five_hour: { used_percentage: 33, resets_at: 1712859600 },
      },
    });
    const result = await readRateLimits({ filePath: file });
    assert.equal(result.ok, true);
    assert.ok(Number.isFinite(result.fetchedAt));
  });

  it('returns no-file reason when the file does not exist', async () => {
    const missing = join(TMP, 'does-not-exist.json');
    const result = await readRateLimits({ filePath: missing });
    assert.deepEqual(result, { ok: false, reason: 'no-file' });
  });

  it('returns invalid reason for malformed JSON', async () => {
    const file = join(TMP, 'broken.json');
    writeFileSync(file, '{not valid json');
    const result = await readRateLimits({ filePath: file });
    assert.deepEqual(result, { ok: false, reason: 'invalid' });
  });

  it('returns empty reason when rate_limits is missing/invalid', async () => {
    const file = writeJson('no-rate-limits.json', { ts: Date.now() });
    const result = await readRateLimits({ filePath: file });
    assert.deepEqual(result, { ok: false, reason: 'empty' });
  });
});

describe('normalizeUsage (境界)', () => {
  it('seven_day だけ有効でも null にせず返す', () => {
    const usage = normalizeUsage({ seven_day: { used_percentage: 0 } });
    assert.deepEqual(usage, {
      fiveHour: { utilization: null, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      extras: [],
    });
  });

  it('five_hour だけ有効でも null にせず返す', () => {
    const usage = normalizeUsage({ five_hour: { used_percentage: 12 } });
    assert.equal(usage.fiveHour.utilization, 12);
    assert.equal(usage.sevenDay.utilization, null);
  });

  it('数値の文字列の used_percentage は数として読み、Infinity は無効にする', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: '42.5' },
      seven_day: { used_percentage: Infinity },
    });
    assert.equal(usage.fiveHour.utilization, 42.5);
    assert.equal(usage.sevenDay.utilization, null);
  });

  it('空文字・非有限数・数でも文字列でもない resets_at は null', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 1, resets_at: '' },
      seven_day: { used_percentage: 2, resets_at: Infinity },
      seven_day_sonnet: { used_percentage: 3, resets_at: { at: 1 } },
      seven_day_opus: { used_percentage: 4, resets_at: true },
    });
    assert.equal(usage.fiveHour.resetsAt, null);
    assert.equal(usage.sevenDay.resetsAt, null);
    assert.equal(usage.extras[0].resetsAt, null);
    assert.equal(usage.extras[1].resetsAt, null);
  });

  it('プロパティを持っていても関数の rate_limits は null', () => {
    const fn = Object.assign(() => {}, { five_hour: { used_percentage: 10 } });
    assert.equal(normalizeUsage(fn), null);
  });

  it('オブジェクトでない rate_limits は null', () => {
    assert.equal(normalizeUsage('five_hour'), null);
    assert.equal(normalizeUsage(42), null);
  });

  it('片方のモデル別枠だけあれば、その 1 件だけを extras に出す', () => {
    const usage = normalizeUsage({
      five_hour: { used_percentage: 1 },
      seven_day_opus: { used_percentage: 9, resets_at: '2026-08-18T10:00:00Z' },
    });
    assert.deepEqual(usage.extras, [
      { key: 'seven_day_opus', label: '7d Opus', utilization: 9, resetsAt: '2026-08-18T10:00:00Z' },
    ]);
  });
});

describe('readRateLimits (fetchedAt)', () => {
  it('ts が無ければファイルの更新時刻をそのまま fetchedAt にする', async () => {
    const file = writeJson('mtime.json', { rate_limits: { seven_day: { used_percentage: 5 } } });
    const result = await readRateLimits({ filePath: file });
    assert.equal(result.fetchedAt, statSync(file).mtimeMs);
  });

  it('数値として読める ts は数に直して使う', async () => {
    const file = writeJson('ts-string.json', {
      rate_limits: { five_hour: { used_percentage: 5 } },
      ts: '1700000000123',
    });
    const result = await readRateLimits({ filePath: file });
    assert.equal(result.fetchedAt, 1700000000123);
  });

  it('JSON が null でも例外にせず empty を返す', async () => {
    const file = join(TMP, 'null.json');
    writeFileSync(file, 'null');
    assert.deepEqual(await readRateLimits({ filePath: file }), { ok: false, reason: 'empty' });
  });
});

describe('RATE_LIMITS_FILE', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('CLAUDE_BRIDGE_DIR 配下の rate-limits.json を既定の読み先にする', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-rate-limits-env-'));
    try {
      writeFileSync(
        join(dataDir, 'rate-limits.json'),
        JSON.stringify({ rate_limits: { five_hour: { used_percentage: 77 } }, ts: 1 }),
      );
      vi.stubEnv('CLAUDE_BRIDGE_DIR', dataDir);
      vi.resetModules();
      const mod = await import('../server/rate-limits.js');
      assert.equal(mod.RATE_LIMITS_FILE, join(dataDir, 'rate-limits.json'));
      const result = await mod.readRateLimits();
      assert.equal(result.ok, true);
      assert.equal(result.usage.fiveHour.utilization, 77);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('CLAUDE_BRIDGE_DIR が無ければホームの .claude-bridge を指す', async () => {
    vi.stubEnv('CLAUDE_BRIDGE_DIR', '');
    vi.resetModules();
    const os = await import('os');
    const mod = await import('../server/rate-limits.js');
    assert.equal(mod.RATE_LIMITS_FILE, join(os.homedir(), '.claude-bridge', 'rate-limits.json'));
  });
});

describe('readRateLimits (更新時刻も取れないとき)', () => {
  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.resetModules();
    vi.useRealTimers();
  });

  it('ts が無く stat もできなければ今の時刻を fetchedAt にする', async () => {
    const file = writeJson('no-stat.json', { rate_limits: { five_hour: { used_percentage: 5 } } });
    vi.useFakeTimers({ now: 1234567890000, toFake: ['Date'] });
    vi.resetModules();
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal();
      const stat = async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      };
      return { ...actual, stat, default: { ...actual, stat } };
    });
    const mod = await import('../server/rate-limits.js');
    const result = await mod.readRateLimits({ filePath: file });
    assert.equal(result.ok, true);
    assert.equal(result.fetchedAt, 1234567890000);
  });
});

describe('bridge-statusline-tee.js (integration)', () => {
  const wrapperPath = fileURLToPath(new URL('../scripts/statusline/bridge-statusline-tee.js', import.meta.url));

  function runWrapper({ dataDir, stdin }) {
    return new Promise((resolvePromise) => {
      const child = spawn('node', [wrapperPath], {
        env: { ...process.env, CLAUDE_BRIDGE_DIR: dataDir },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  it("tees rate_limits to a file and passes through the original command's stdout", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-statusline-'));
    writeFileSync(join(dataDir, 'statusline-original.json'), JSON.stringify({ command: 'cat' }));
    const payload = {
      cwd: '/home/user/project',
      rate_limits: {
        five_hour: { used_percentage: 25, resets_at: 1712859600 },
        seven_day: { used_percentage: 5, resets_at: 1713464400 },
      },
    };
    const { code, stdout } = await runWrapper({
      dataDir,
      stdin: JSON.stringify(payload),
    });
    assert.equal(code, 0);
    // 元コマンド (cat) が stdin をそのまま出す
    assert.equal(stdout, JSON.stringify(payload));

    const rateLimitsFile = join(dataDir, 'rate-limits.json');
    assert.ok(existsSync(rateLimitsFile));
    const saved = JSON.parse(readFileSync(rateLimitsFile, 'utf-8'));
    assert.deepEqual(saved.rate_limits, payload.rate_limits);
    assert.ok(Number.isFinite(saved.ts));
    // cwd 等の他フィールドは保存しない
    assert.equal(saved.cwd, undefined);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('exits 0 without output when no original command is registered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-statusline-'));
    const { code, stdout } = await runWrapper({
      dataDir,
      stdin: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } } }),
    });
    assert.equal(code, 0);
    assert.equal(stdout, '');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('still runs the original command when stdin is not valid JSON', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-statusline-'));
    writeFileSync(join(dataDir, 'statusline-original.json'), JSON.stringify({ command: 'cat' }));
    const { code, stdout } = await runWrapper({ dataDir, stdin: 'not json' });
    assert.equal(code, 0);
    assert.equal(stdout, 'not json');
    assert.equal(existsSync(join(dataDir, 'rate-limits.json')), false);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
