import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR, cwdToProjectDir, extractContextUsage, extractTextContent } from './jsonl-utils.js';
import { readSessionArtifacts } from './session-artifacts.js';

// カードに出す「どんなセッションか」の情報を JSONL から取り出す。
// 全文は読まず、先頭数十行（タイトル・冒頭の依頼）と末尾数十KB（直近のやりとり）だけ見る。
const HEAD_LINES = 40;
const TAIL_BYTES = 128 * 1024;
const TITLE_MAX = 100;
const TEXT_MAX = 180;

// filePath -> { mtimeMs, summary }。ホーム画面はポーリングするので mtime でキャッシュする
const cache = new Map();
const CACHE_MAX = 500;

// JSONL の先頭 N 行だけ非同期で読む
export function readFirstLines(filePath, maxLines) {
  return new Promise((resolve) => {
    const lines = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length >= maxLines) rl.close();
    });
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(lines));
  });
}

// JSONL の末尾 maxBytes だけ読んで行に分割する。
// 途中から読むので先頭の 1 行は欠けている可能性があり、捨てる。
export function readLastLines(filePath, size, maxBytes = TAIL_BYTES) {
  return new Promise((resolve) => {
    const start = Math.max(0, size - maxBytes);
    const chunks = [];
    const stream = createReadStream(filePath, { encoding: 'utf-8', start });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const lines = chunks.join('').split('\n').filter(Boolean);
      resolve(start > 0 ? lines.slice(1) : lines);
    });
    stream.on('error', () => resolve([]));
  });
}

function parseLines(lines) {
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // 書き込み途中や切れた行は無視
    }
  }
  return records;
}

// カードの 1〜2 行に収める用にテキストを均す。
// 他セッションからの注入などに含まれる <teammate-message ...> のようなタグは
// 属性が長く中身が読めなくなるので落とす。
export function snippetText(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ユーザーが実際に打った指示か（tool_result やスラッシュコマンドの展開は除く）
function userPrompt(record) {
  if (record.type !== 'user' || record.isMeta) return '';
  const raw = extractTextContent(record.message, 0).trim();
  if (!raw || raw.startsWith('<')) return '';
  return snippetText(raw);
}

// 先頭行群から: タイトル / 冒頭のユーザー依頼 / git ブランチ
export function summarizeHead(lines) {
  const records = parseLines(lines);
  let aiTitle = '';
  let lastPrompt = '';
  let firstUserMessage = '';
  let gitBranch = '';
  let cwd = '';
  for (const record of records) {
    if (!aiTitle && record.type === 'ai-title' && record.aiTitle) {
      aiTitle = record.aiTitle;
    }
    if (!lastPrompt && record.type === 'last-prompt' && record.lastPrompt) {
      lastPrompt = record.lastPrompt;
    }
    if (!firstUserMessage) firstUserMessage = userPrompt(record);
    if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch;
    // projectDir 名からの復元ではディレクトリ名のハイフンを区別できないので、
    // JSONL に書かれている cwd をそのまま使う（resume の起動先になる）
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
  }
  const first = firstUserMessage || snippetText(lastPrompt);
  return {
    title: snippetText(aiTitle || first).slice(0, TITLE_MAX),
    firstUserMessage: first.slice(0, TEXT_MAX),
    gitBranch,
    cwd,
  };
}

const AWAY_SUMMARY_MAX = 300;

// API エラーの応答（529 Overloaded 等）。エラーのあとにも turn_duration が書かれるので
// 「ターンは終わったが作業は終わっていない」として区別する
function isApiError(record) {
  if (record.isApiErrorMessage) return true;
  return extractTextContent(record.message, 0).trim().startsWith('API Error');
}

function hasBlock(record, type) {
  const content = record.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === type);
}

// 末尾から見て、最後のターンがどう終わったか（ホームのやり残し判定用）。
//   'ended'       … 応答を返してターンを終えた（system:turn_duration、または tool_use を含まない応答）
//   'error'       … 最後の応答が API エラー
//   'interrupted' … ユーザーが中断した（[Request interrupted by user]）
//   'midway'      … ツールの実行中・結果待ちのまま止まっている
//   'prompt'      … 最後の指示に応答が無い
//   null          … 判断材料が無い
export function detectTurnState(records) {
  let sawTurnEnd = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === 'system') {
      if (record.subtype === 'turn_duration') sawTurnEnd = true;
      continue;
    }
    if (record.type === 'assistant') {
      if (isApiError(record)) return 'error';
      if (sawTurnEnd || !hasBlock(record, 'tool_use')) return 'ended';
      return 'midway';
    }
    if (record.type !== 'user' || record.isMeta) continue;
    const text = extractTextContent(record.message, 0).trim();
    if (text.startsWith('[Request interrupted by user')) return 'interrupted';
    if (hasBlock(record, 'tool_result')) return sawTurnEnd ? 'ended' : 'midway';
    if (userPrompt(record)) return sawTurnEnd ? 'ended' : 'prompt';
  }
  return sawTurnEnd ? 'ended' : null;
}

// 末尾行群から: 直近のユーザー指示 / 直近のアシスタント発話 / 最終更新時刻
export function summarizeTail(lines) {
  const records = parseLines(lines);
  let lastUserMessage = '';
  let lastAssistantMessage = '';
  let lastTimestamp = '';
  // 今のコンテキスト量は「usage のある直近の assistant」から取る。
  // API エラー等で usage を持たないレコードが末尾に来ることがあるので遡って探す。
  let contextUsage = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!lastTimestamp && record.timestamp) lastTimestamp = record.timestamp;
    if (!lastAssistantMessage && record.type === 'assistant') {
      lastAssistantMessage = snippetText(extractTextContent(record.message, 0));
    }
    if (!contextUsage) contextUsage = extractContextUsage(record);
    if (!lastUserMessage) lastUserMessage = userPrompt(record);
    if (lastUserMessage && lastAssistantMessage && lastTimestamp && contextUsage) break;
  }
  // 離席から戻ったときに Claude Code が書く要約（「いまどうなっていて、次に何を決めるか」）。
  // やり残しの中身そのものなので、最新の 1 件をそのまま出す
  let awaySummary = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === 'system' && record.subtype === 'away_summary' && typeof record.content === 'string') {
      const text = snippetText(record.content.replace(/\(disable recaps in \/config\)\s*$/, ''));
      if (text) awaySummary = { text: text.slice(0, AWAY_SUMMARY_MAX), timestamp: record.timestamp || '' };
      break;
    }
  }
  return {
    lastUserMessage: lastUserMessage.slice(0, TEXT_MAX),
    lastAssistantMessage: lastAssistantMessage.slice(0, TEXT_MAX),
    lastTimestamp,
    contextUsage,
    turnState: detectTurnState(records),
    awaySummary,
  };
}

const EMPTY_SUMMARY = {
  title: '',
  firstUserMessage: '',
  gitBranch: '',
  cwd: '',
  lastUserMessage: '',
  lastAssistantMessage: '',
  lastTimestamp: '',
  contextUsage: null,
  turnState: null,
  awaySummary: null,
  artifacts: [],
};

// セッション JSONL 1 本のサマリ。mtime が変わっていなければキャッシュを返す。
export async function readSessionSummary(filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { ...EMPTY_SUMMARY };
  }

  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === fileStat.mtimeMs) return hit.summary;

  // Artifact の publish は JSONL のどこにでもあるので head/tail では拾えない。
  // 全文を毎回読まないよう、session-artifacts.js が差分（前回オフセット以降）だけ読む。
  const [headLines, tailLines, artifacts] = await Promise.all([
    readFirstLines(filePath, HEAD_LINES),
    readLastLines(filePath, fileStat.size),
    readSessionArtifacts(filePath, fileStat),
  ]);
  const head = summarizeHead(headLines);
  const tail = summarizeTail(tailLines);
  // 短いセッションでは head/tail が重なるので、同じ内容なら直近側は出さない
  const summary = {
    ...head,
    ...tail,
    artifacts,
    lastUserMessage: tail.lastUserMessage === head.firstUserMessage ? '' : tail.lastUserMessage,
    title: head.title || tail.lastUserMessage.slice(0, TITLE_MAX),
  };

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(filePath, { mtimeMs: fileStat.mtimeMs, summary });
  return summary;
}

// cwd + sessionId から JSONL のパスを解決してサマリを読む
export async function readSessionSummaryFor(cwd, sessionId, projectsDir = CLAUDE_PROJECTS_DIR) {
  if (!cwd || !sessionId) return { ...EMPTY_SUMMARY };
  return readSessionSummary(join(projectsDir, cwdToProjectDir(cwd), `${sessionId}.jsonl`));
}
