import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { extractArtifactPublish } from './jsonl-utils.js';

// セッション JSONL から Artifact の publish（claude.ai に公開したページ）を拾う。
//
// publish のレコードは JSONL のどこにでも現れるので、session-summary.js のように
// 先頭 40 行＋末尾 128KB だけでは拾えず全文を見るしかない。一方で起動中セッションの
// 一覧はホーム表示中 5 秒間隔でポーリングされ、JSONL は数十 MB になり得る。
// そこで「前回読んだオフセット以降だけを読み足す」差分走査にする
// （subagent-tasks.js の親 JSONL 走査・activity-heatmap.js と同じ考え方。
//   ただしプロセスを跨いで残す必要は無いのでメモリ内 Map だけで永続化はしない）。

// filePath -> { mtimeMs, size, offset, artifacts, inFlight }
const cache = new Map();
const CACHE_MAX = 1000;

// JSON.parse は重いので、publish 行だけを通す安価なプリフィルタ
function looksLikePublish(line) {
  return line.includes('"toolUseResult"') && line.includes('claude.ai');
}

function collect(line, artifacts) {
  if (!looksLikePublish(line)) return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    // 壊れた行・書き込み途中の行は無視
    return;
  }
  const publish = extractArtifactPublish(record);
  if (publish) artifacts.push({ ...publish, timestamp: record.timestamp || '' });
}

// start 以降を読み、改行で終わっている行だけを処理する。
// 戻り値の consumed は「取り込み済みバイト数」＝次回の開始位置の進み分。
// 文字列長ではなくバイト数で数える必要があるので、encoding は付けず Buffer で受ける。
async function scanFrom(filePath, start) {
  const artifacts = [];
  let consumed = 0;
  let pending = Buffer.alloc(0);

  try {
    const stream = createReadStream(filePath, { start });
    for await (const chunk of stream) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let index;
      while ((index = pending.indexOf(0x0a)) !== -1) {
        collect(pending.subarray(0, index).toString('utf-8'), artifacts);
        pending = pending.subarray(index + 1);
        consumed += index + 1;
      }
    }
  } catch {
    // 読めなかった分は offset を進めないので次回また読む
  }
  // 末尾の書きかけ行（最後の改行より後ろ）は処理せず、offset にも含めない
  return { artifacts, consumed };
}

// セッション JSONL に現れた publish の生リスト（出現順・重複排除はしない）。
// fileStat を渡せば stat を省ける（呼び元が既に取っている場合用）。
export async function readSessionArtifacts(filePath, fileStat) {
  let fileInfo = fileStat;
  if (!fileInfo) {
    try {
      fileInfo = await stat(filePath);
    } catch {
      return [];
    }
  }

  let entry = cache.get(filePath);
  // ファイルが縮んでいたら別物（ローテート・作り直し）なので先頭から読み直す
  if (entry && fileInfo.size < entry.offset) entry = null;
  if (!entry) {
    if (cache.size >= CACHE_MAX) cache.clear();
    entry = { mtimeMs: -1, size: -1, offset: 0, artifacts: [], inFlight: null };
    cache.set(filePath, entry);
  } else if (entry.mtimeMs === fileInfo.mtimeMs && entry.size === fileInfo.size) {
    return entry.artifacts;
  }

  // 起動中一覧と直近一覧が同じ JSONL を同時に読むことがある。並行して同じオフセットから
  // 走査すると publish が二重に積まれるので、走査中は同じ Promise を待たせる
  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = (async () => {
    try {
      if (fileInfo.size > entry.offset) {
        const { artifacts, consumed } = await scanFrom(filePath, entry.offset);
        if (artifacts.length > 0) entry.artifacts = [...entry.artifacts, ...artifacts];
        entry.offset += consumed;
      }
      entry.mtimeMs = fileInfo.mtimeMs;
      entry.size = fileInfo.size;
      return entry.artifacts;
    } finally {
      entry.inFlight = null;
    }
  })();
  return entry.inFlight;
}

// テスト用（同じパスに別内容を書くケースがあるのでキャッシュを捨てられるようにする）
export function clearSessionArtifactsCache() {
  cache.clear();
}
