import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import os from 'os';

// bridge-statusline-tee.js が横流しした最新の statusLine rate_limits。
// credentials・外部通信は一切使わない（statusLine の stdin をファイル越しに覗くだけ）。
const DATA_DIR = process.env.CLAUDE_BRIDGE_DIR || join(os.homedir(), '.claude-bridge');
export const RATE_LIMITS_FILE = join(DATA_DIR, 'rate-limits.json');

// utilization を有限数に強制する。欠落・非数なら null
// （Number(null) は 0 になってしまうため、null/undefined は先に弾く）
function toUtilization(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// resets_at は statusLine 版が Unix epoch 秒、API 版が ISO 文字列で、両対応する。
// 数値（epoch 秒）なら ISO に変換、文字列ならそのまま、それ以外は null。
function toResetsAt(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

const EXTRA_LABELS = {
  seven_day_sonnet: '7d Sonnet',
  seven_day_opus: '7d Opus',
};

// statusLine の rate_limits を表示用の形に整形する純粋関数。
// キー名は statusLine 形式（used_percentage）で、utilization に読み替える。
// five_hour / seven_day が両方とも無効なら null（表示するものが無いとみなす）。
export function normalizeUsage(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;

  const fiveHour = {
    utilization: toUtilization(rateLimits.five_hour?.used_percentage),
    resetsAt: toResetsAt(rateLimits.five_hour?.resets_at),
  };
  const sevenDay = {
    utilization: toUtilization(rateLimits.seven_day?.used_percentage),
    resetsAt: toResetsAt(rateLimits.seven_day?.resets_at),
  };
  if (fiveHour.utilization === null && sevenDay.utilization === null) {
    return null;
  }

  const extras = Object.entries(EXTRA_LABELS)
    .filter(([key]) => toUtilization(rateLimits[key]?.used_percentage) !== null)
    .map(([key, label]) => ({
      key,
      label,
      utilization: toUtilization(rateLimits[key].used_percentage),
      resetsAt: toResetsAt(rateLimits[key].resets_at),
    }));

  return { fiveHour, sevenDay, extras };
}

// bridge-statusline-tee.js が書いた <dataDir>/rate-limits.json を読む。
// ファイルが無い/壊れている/rate_limits を含まない場合はすべて { ok: false, reason } を
// 返し、例外は外に投げない。
export async function readRateLimits({ filePath = RATE_LIMITS_FILE } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'no-file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const usage = normalizeUsage(parsed?.rate_limits);
  if (!usage) {
    return { ok: false, reason: 'empty' };
  }

  let fetchedAt = Number(parsed?.ts);
  if (!Number.isFinite(fetchedAt)) {
    // ts が無い/壊れている場合はファイルの更新時刻で代用する
    try {
      fetchedAt = (await stat(filePath)).mtimeMs;
    } catch {
      fetchedAt = Date.now();
    }
  }

  return { ok: true, usage, fetchedAt };
}
