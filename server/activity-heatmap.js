import { readdirSync, statSync, createReadStream, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';
import { DATA_DIR } from './storage.js';

// GitHub の草に相当する「日別の活動量」を JSONL から集計する。
// ~/.claude/projects 以下は数百 MB あるので、ファイル単位で日別集計をキャッシュし、
// 2 回目以降は「追記された分」だけを読み足す（JSONL は追記のみ）。

const CACHE_VERSION = 1;
const CACHE_FILE = join(DATA_DIR, 'activity-heatmap.json');
const DAY_MS = 24 * 60 * 60 * 1000;
// 日別セルの持ち方。JSON に落とすので配列で持つ（キー名の重複を避けて小さくする）
const PROMPTS = 0;
const REPLIES = 1;
const INPUT = 2;
const OUTPUT = 3;
const CACHE_CREATE = 4;
const CACHE_READ = 5;
const CELL_SIZE = 6;

const emptyCell = () => new Array(CELL_SIZE).fill(0);

// ~/.claude/projects 以下の JSONL を全部集める。
// 本体（<projectDir>/<sessionId>.jsonl）に加えサブエージェント
// （<projectDir>/<sessionId>/subagents/agent-*.jsonl）も対象にする。
// サブエージェントの発話は本体側には書かれないので二重計上にはならない。
function collectJsonlFiles(dir) {
  const files = [];
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const fileStat = statSync(child);
          files.push({ path: child, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  };
  walk(dir);
  return files;
}

// ローカルタイムの YYYY-MM-DD（草は「自分の1日」で切りたいので UTC ではない）
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ISO タイムスタンプ → ローカル日付。数百万行を捌くので
// 「同じ時（YYYY-MM-DDTHH）なら同じ日付」を使って Date の生成を減らす。
function makeDateKeyResolver() {
  const cache = new Map();
  return (timestamp) => {
    if (typeof timestamp !== 'string' || timestamp.length < 13) return null;
    const hourKey = timestamp.slice(0, 13);
    let key = cache.get(hourKey);
    if (key === undefined) {
      const date = new Date(timestamp);
      key = Number.isNaN(date.getTime()) ? null : localDateKey(date);
      cache.set(hourKey, key);
    }
    return key;
  };
}

// ユーザーの「実際の入力」かどうか。tool_result（ツールの実行結果）は
// user レコードとして書かれるが人が打ったものではないので数えない。
function isUserPrompt(record) {
  if (record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  if (content.some((block) => block?.type === 'tool_result')) return false;
  return content.some((block) => block?.type === 'text');
}

// 1 行を日別集計に足す
function accumulateLine(line, daily, dateKeyOf) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') return;
  if (type === 'user' && !isUserPrompt(record)) return;

  const date = dateKeyOf(record.timestamp);
  if (!date) return;

  let cell = daily[date];
  if (!cell) {
    cell = emptyCell();
    daily[date] = cell;
  }
  if (type === 'user') {
    cell[PROMPTS] += 1;
    return;
  }
  cell[REPLIES] += 1;
  const usage = record.message?.usage;
  if (!usage) return;
  cell[INPUT] += usage.input_tokens || 0;
  cell[OUTPUT] += usage.output_tokens || 0;
  cell[CACHE_CREATE] += usage.cache_creation_input_tokens || 0;
  cell[CACHE_READ] += usage.cache_read_input_tokens || 0;
}

// offset 以降を読み、完全な行だけを集計する。
// 戻り値は「取り込み済みバイト数」＝次回の開始位置（書きかけの末尾行は含めない）。
async function scanFrom(path, offset, daily, dateKeyOf) {
  let consumed = offset;
  let buffer = '';
  const stream = createReadStream(path, { start: offset, encoding: 'utf-8' });
  for await (const chunk of stream) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      consumed += Buffer.byteLength(line, 'utf-8') + 1;
      if (line.trim()) accumulateLine(line, daily, dateKeyOf);
    }
  }
  return consumed;
}

function loadCache(cacheFile) {
  try {
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (cache?.version === CACHE_VERSION && cache.files && typeof cache.files === 'object') return cache;
  } catch {
    // 壊れていたら作り直す（集計は再走査すれば復元できる）
  }
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(cacheFile, cache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, cacheFile);
  } catch {
    // キャッシュは無くても動く（次回また走査するだけ）ので握りつぶす
  }
}

// 直近 days 日分の空セルを日付順に用意する（活動のない日も草の升目として出す）
function buildDateRange(days, now) {
  const dates = [];
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDateKey(new Date(end.getTime() - i * DAY_MS)));
  }
  return dates;
}

function toDay(date, cell) {
  const [prompts, replies, input, output, cacheCreation, cacheRead] = cell;
  return {
    date,
    prompts,
    replies,
    messages: prompts + replies,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    tokens: input + output + cacheCreation + cacheRead,
  };
}

// 同じ走査を並行に走らせない（ホームのリロードで二重に読み直さないため）
let inflight = null;

// ファイル単位のキャッシュを更新し、日付 -> セルの全体集計を返す
async function refreshDaily({ dir, cacheFile }) {
  const cache = loadCache(cacheFile);
  const files = collectJsonlFiles(dir);
  const dateKeyOf = makeDateKeyResolver();
  const nextFiles = {};
  let scannedFiles = 0;

  for (const file of files) {
    const cached = cache.files[file.path];
    // 追記のみ前提。縮んでいたら別物（ローテート等）なので先頭から読み直す
    const reusable = cached && typeof cached.offset === 'number' && cached.offset <= file.size;
    const entry = reusable ? { offset: cached.offset, daily: { ...cached.daily } } : { offset: 0, daily: {} };

    if (entry.offset < file.size) {
      try {
        entry.offset = await scanFrom(file.path, entry.offset, entry.daily, dateKeyOf);
        scannedFiles++;
      } catch {
        // 読めないファイルはこのラウンドでは諦める（次回また試す）
      }
    }
    nextFiles[file.path] = { offset: entry.offset, daily: entry.daily };
  }

  cache.files = nextFiles; // 消えたファイルはキャッシュからも落とす
  saveCache(cacheFile, cache);

  const totals = {};
  for (const entry of Object.values(nextFiles)) {
    for (const [date, cell] of Object.entries(entry.daily)) {
      let target = totals[date];
      if (!target) {
        target = emptyCell();
        totals[date] = target;
      }
      for (let i = 0; i < CELL_SIZE; i++) target[i] += cell[i];
    }
  }
  return { totals, scannedFiles, fileCount: files.length };
}

// ホーム画面のヒートマップ用。直近 days 日の日別集計を返す。
export async function getActivityHeatmap({ days = 365, dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE, now = Date.now() } = {}) {
  if (!inflight) {
    inflight = refreshDaily({ dir, cacheFile }).finally(() => {
      inflight = null;
    });
  }
  const { totals, scannedFiles, fileCount } = await inflight;

  const range = buildDateRange(days, now);
  const cells = range.map((date) => toDay(date, totals[date] || emptyCell()));
  const total = cells.reduce(
    (acc, day) => {
      acc.prompts += day.prompts;
      acc.replies += day.replies;
      acc.messages += day.messages;
      acc.tokens += day.tokens;
      acc.inputTokens += day.inputTokens;
      acc.outputTokens += day.outputTokens;
      acc.cacheCreationTokens += day.cacheCreationTokens;
      acc.cacheReadTokens += day.cacheReadTokens;
      if (day.messages > 0) acc.activeDays += 1;
      return acc;
    },
    {
      prompts: 0,
      replies: 0,
      messages: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      activeDays: 0,
    },
  );

  return { days: cells, total, generatedAt: new Date(now).toISOString(), scannedFiles, fileCount };
}

// テスト用（モジュールキャッシュをまたいだ状態を残さない）
export function resetActivityHeatmapState() {
  inflight = null;
}
