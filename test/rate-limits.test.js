import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { normalizeUsage, readRateLimits } from '../server/rate-limits.js';

const TMP = mkdtempSync(join(tmpdir(), 'bridge-rate-limits-'));
after(() => {
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
