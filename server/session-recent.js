import { open, stat } from 'fs/promises';
import { extractTextContent } from './jsonl-utils.js';
import { turnPrompt } from './session-turns.js';

// ホームの行リストの「直近のやりとり」ポップオーバー用。直近 N 往復（ユーザーの指示 1 件 + 応答）を
// 改行を保ったまま返す。ホバーで開いたときだけ呼ばれるが、JSONL は数十 MB になり得るので
// 末尾だけ読む（足りなければ取れた分だけ返し、全文は読まない）。

const TAIL_BYTES = 1024 * 1024;

// filePath -> { mtimeMs, size, limit, textMax, value }
const cache = new Map();

export function clearSessionRecentCache() {
  cache.clear();
}

async function readTail(filePath, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf-8');
    // 途中から読んだときは先頭の行が欠けているので捨てる
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}

function parseRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 書きかけ・壊れた行は無視
    }
  }
  return records;
}

function clip(text, max) {
  if (max > 0 && text.length > max) return { text: text.slice(0, max), truncated: true };
  return { text, truncated: false };
}

// スラッシュコマンドは <command-name> で書かれ本文がタグなので turnPrompt の結果（/ship 形式）を使う。
// それ以外は改行を保った本文（turnPrompt は空白を潰すので使わない）
function promptText(record, turn) {
  const content = record.message?.content;
  if (typeof content === 'string' && content.includes('<command-name>')) return turn;
  return extractTextContent(record.message, 0).trim() || turn;
}

// レコード列 → 往復の配列（古い順・最大 limit 件）。純粋関数
export function buildRecentExchanges(records, { limit = 3, textMax = 1000 } = {}) {
  const exchanges = [];
  let current = null;
  for (const record of records) {
    const turn = turnPrompt(record);
    if (turn) {
      current = { record, prompt: promptText(record, turn), reply: '', replyAt: '', toolCount: 0 };
      exchanges.push(current);
      continue;
    }
    // 最初の指示より前（末尾から読んだ切れ目の後ろ）の応答は対応する指示が無いので捨てる
    if (!current || record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    current.toolCount += content.filter((b) => b?.type === 'tool_use').length;
    const text = extractTextContent(record.message, 0).trim();
    if (text) {
      current.reply = text;
      current.replyAt = record.timestamp || '';
    }
  }
  return exchanges.slice(-limit).map((ex) => {
    const prompt = clip(ex.prompt, textMax);
    const reply = clip(ex.reply, textMax);
    return {
      prompt: prompt.text,
      promptAt: ex.record.timestamp || '',
      reply: reply.text,
      replyAt: ex.replyAt,
      toolCount: ex.toolCount,
      promptTruncated: prompt.truncated,
      replyTruncated: reply.truncated,
    };
  });
}

export async function readRecentExchanges(filePath, { limit = 3, textMax = 1000 } = {}) {
  const st = await stat(filePath);
  const cached = cache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.limit === limit &&
    cached.textMax === textMax
  ) {
    return cached.value;
  }
  const records = parseRecords(await readTail(filePath, st.size));
  const value = { exchanges: buildRecentExchanges(records, { limit, textMax }) };
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, limit, textMax, value });
  return value;
}
