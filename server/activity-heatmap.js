import {
  existsSync,
  readdirSync,
  statSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'fs';
import { join, dirname, relative, sep } from 'path';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';
import { DATA_DIR } from './storage.js';
import { readFirstLines, summarizeHead } from './session-summary.js';
import { turnPrompt } from './session-turns.js';

// GitHub の草に相当する「日別の活動量」を JSONL から集計する。
// ~/.claude/projects 以下は数百 MB あるので、ファイル単位で日別集計をキャッシュし、
// 2 回目以降は「追記された分」だけを読み足す（JSONL は追記のみ）。

// 2: 週間カレンダー用に 10 分枠の集計（slots）を追加
// 3: カレンダーの点（指示した時刻）用に、人の指示の時刻を分単位で持つ（prompts）
const CACHE_VERSION = 3;
const MINUTE_MS = 60 * 1000;
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

// 週間カレンダー用の 10 分枠。キーはエポックからの枠番号（ローカル時刻への変換は表示側）。
export const SLOT_MS = 10 * 60 * 1000;
const SLOT_PROMPTS = 0;
const SLOT_REPLIES = 1;
const SLOT_RESEARCH = 2;
const SLOT_EDIT = 3;
const SLOT_SIZE = 4;
// 「調査していたのか、手を動かしていたのか」を枠ごとに見るためのツールの分類
const RESEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function slotCellOf(slots, timestamp) {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  const index = Math.floor(ms / SLOT_MS);
  let cell = slots[index];
  if (!cell) {
    cell = new Array(SLOT_SIZE).fill(0);
    slots[index] = cell;
  }
  return cell;
}

function countTools(content, slot) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    if (RESEARCH_TOOLS.has(block.name)) slot[SLOT_RESEARCH] += 1;
    else if (EDIT_TOOLS.has(block.name)) slot[SLOT_EDIT] += 1;
  }
}

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

// 1 行を日別集計と 10 分枠の集計に足す
function accumulateLine(line, entry, dateKeyOf) {
  const { daily, slots } = entry;
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
  const slot = slotCellOf(slots, record.timestamp);
  if (type === 'user') {
    cell[PROMPTS] += 1;
    if (slot) slot[SLOT_PROMPTS] += 1;
    // カレンダーの点は「人が指示した時刻」だけにする（タスク通知などの注入は除き、
    // スラッシュコマンドは含める。ターン詳細の区切りと同じ判定）
    const ms = Date.parse(record.timestamp);
    if (!Number.isNaN(ms) && turnPrompt(record)) entry.prompts.push(Math.floor(ms / MINUTE_MS));
    return;
  }
  cell[REPLIES] += 1;
  if (slot) {
    slot[SLOT_REPLIES] += 1;
    countTools(record.message?.content, slot);
  }
  const usage = record.message?.usage;
  if (!usage) return;
  cell[INPUT] += usage.input_tokens || 0;
  cell[OUTPUT] += usage.output_tokens || 0;
  cell[CACHE_CREATE] += usage.cache_creation_input_tokens || 0;
  cell[CACHE_READ] += usage.cache_read_input_tokens || 0;
}

// offset 以降を読み、完全な行だけを集計する。
// 戻り値は「取り込み済みバイト数」＝次回の開始位置（書きかけの末尾行は含めない）。
async function scanFrom(path, offset, entry, dateKeyOf) {
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
      if (line.trim()) accumulateLine(line, entry, dateKeyOf);
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
    const entry = reusable
      ? {
          offset: cached.offset,
          daily: { ...cached.daily },
          slots: { ...cached.slots },
          prompts: [...(cached.prompts || [])],
        }
      : { offset: 0, daily: {}, slots: {}, prompts: [] };

    if (entry.offset < file.size) {
      try {
        entry.offset = await scanFrom(file.path, entry.offset, entry, dateKeyOf);
        scannedFiles++;
      } catch {
        // 読めないファイルはこのラウンドでは諦める（次回また試す）
      }
    }
    nextFiles[file.path] = entry;
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
  return { totals, files: nextFiles, scannedFiles, fileCount: files.length };
}

// 走査は重いので、同時に来た要求は 1 回の走査を共有する
function sharedRefresh({ dir, cacheFile }) {
  if (!inflight) {
    inflight = refreshDaily({ dir, cacheFile }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// ホーム画面のヒートマップ用。直近 days 日の日別集計を返す。
export async function getActivityHeatmap({
  days = 365,
  dir = CLAUDE_PROJECTS_DIR,
  cacheFile = CACHE_FILE,
  now = Date.now(),
} = {}) {
  const { totals, scannedFiles, fileCount } = await sharedRefresh({ dir, cacheFile });

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

// JSONL のパスからセッション ID を取る。
// <projectDir>/<sessionId>.jsonl か、サブエージェントの
// <projectDir>/<sessionId>/subagents/agent-*.jsonl（活動は親セッションに帰属させる）。
function sessionIdFromPath(dir, path) {
  const parts = relative(dir, path).split(sep);
  if (parts.length < 2) return null;
  const second = parts[1];
  return second.endsWith('.jsonl') ? second.slice(0, -'.jsonl'.length) : second;
}

// 期間（ローカル日付 YYYY-MM-DD の from〜to）に活動があったセッション ID の集合。
// ホームの「直近のセッション」を活動グラフの棒でクリック絞り込みするためのデータ源。
// JSONL の mtime ではなくこの日別集計を使うのは、mtime は「最後に更新した日」でしかなく、
// その日に活動して後日また続けたセッションが期間から漏れるため。棒グラフと同じ集計で
// 絞れば「その棒に数えられたセッション」と一覧が一致する。
export async function listActiveSessionIds({ from, to, dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE } = {}) {
  const { files } = await sharedRefresh({ dir, cacheFile });
  const ids = new Set();
  for (const [path, entry] of Object.entries(files)) {
    const sessionId = sessionIdFromPath(dir, path);
    if (!sessionId || ids.has(sessionId)) continue;
    for (const [date, cell] of Object.entries(entry.daily)) {
      // 日付キーは固定長の YYYY-MM-DD なので文字列比較で範囲判定できる
      if (date < from || date > to) continue;
      if (cell[PROMPTS] + cell[REPLIES] > 0) {
        ids.add(sessionId);
        break;
      }
    }
  }
  return ids;
}

// 週間カレンダー用。[fromMs, toMs) に活動があったセッションごとに、10 分枠の集計を返す。
// slots は [枠番号, 発言, 応答, 調査系ツール, 編集系ツール] の配列（枠番号の昇順）。
// prompts は人が指示した時刻の [分番号（エポックからの分）, その分の指示数] の配列（昇順）。
// サブエージェントの JSONL の「指示」は親が渡したタスクで人の発言ではないので、prompts は本体からだけ取る。
// サブエージェントの活動は親セッションの枠に足す（その間も親は作業中なので帯をつなげる）。
// タイトルと cwd は本体 JSONL の先頭だけ読んで取る（summary 全体は Artifact の全文走査を伴うので使わない）。
export async function getActivityCalendar({ fromMs, toMs, dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE } = {}) {
  const { files } = await sharedRefresh({ dir, cacheFile });
  const fromSlot = Math.floor(fromMs / SLOT_MS);
  const toSlot = Math.ceil(toMs / SLOT_MS);
  const bySession = new Map();

  for (const [path, entry] of Object.entries(files)) {
    const sessionId = sessionIdFromPath(dir, path);
    if (!sessionId) continue;
    const parts = relative(dir, path).split(sep);
    const sessionOf = () => {
      let session = bySession.get(sessionId);
      if (!session) {
        session = { sessionId, projectDir: parts[0], slots: new Map(), prompts: new Map() };
        bySession.set(sessionId, session);
      }
      return session;
    };
    for (const [key, cell] of Object.entries(entry.slots || {})) {
      const index = Number(key);
      if (index < fromSlot || index >= toSlot) continue;
      const session = sessionOf();
      const target = session.slots.get(index);
      if (target) for (let i = 0; i < SLOT_SIZE; i++) target[i] += cell[i];
      else session.slots.set(index, [...cell]);
    }
    if (parts.length !== 2) continue; // サブエージェント
    for (const minute of entry.prompts || []) {
      const ms = minute * MINUTE_MS;
      if (ms < fromMs || ms >= toMs) continue;
      const session = sessionOf();
      session.prompts.set(minute, (session.prompts.get(minute) || 0) + 1);
    }
  }

  const sessions = await Promise.all(
    [...bySession.values()].map(async (session) => {
      // 本体が消えていてもサブエージェント側の活動は出す（タイトル無し）
      const mainPath = join(dir, session.projectDir, `${session.sessionId}.jsonl`);
      const head = existsSync(mainPath) ? summarizeHead(await readFirstLines(mainPath, 40)) : { title: '', cwd: '' };
      return {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        cwd: head.cwd || '',
        title: head.title || '',
        slots: [...session.slots.entries()].sort((a, b) => a[0] - b[0]).map(([index, cell]) => [index, ...cell]),
        prompts: [...session.prompts.entries()].sort((a, b) => a[0] - b[0]),
      };
    }),
  );
  return { fromMs, toMs, slotMs: SLOT_MS, minuteMs: MINUTE_MS, sessions };
}

// テスト用（モジュールキャッシュをまたいだ状態を残さない）
export function resetActivityHeatmapState() {
  inflight = null;
}
