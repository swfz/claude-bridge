import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

// セッション JSONL から「どこにでも現れ得るレコード」を拾うための差分走査。
//
// 先頭 40 行＋末尾 128KB（session-summary.js）では拾えないものは全文を見るしかないが、
// 起動中一覧はホーム表示中 5 秒間隔でポーリングされ、JSONL は数十 MB になり得る。
// そこで「前回読んだオフセット以降だけを読み足す」（subagent-tasks.js の親 JSONL 走査・
// activity-heatmap.js と同じ考え方。プロセスを跨いで残す必要は無いのでメモリ内 Map だけ）。
//
// prefilter(line) で JSON.parse する行を絞り（parse は重い）、collect(record, value) で
// value（呼び出し側の集め先。配列や Set）に積む。createValue() が空の集め先を作る。
export function createIncrementalReader({ prefilter, collect, createValue, cacheMax = 1000 }) {
  // filePath -> { mtimeMs, size, offset, value, inFlight }
  const cache = new Map();

  const handleLine = (line, value) => {
    if (!prefilter(line)) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // 壊れた行・書き込み途中の行は無視
      return;
    }
    collect(record, value);
  };

  // start 以降を読み、改行で終わっている行だけを処理する。
  // 戻り値は「取り込み済みバイト数」＝次回の開始位置の進み分。
  // 文字列長ではなくバイト数で数える必要があるので、encoding は付けず Buffer で受ける。
  const scanFrom = async (filePath, start, value) => {
    let consumed = 0;
    let pending = Buffer.alloc(0);
    try {
      const stream = createReadStream(filePath, { start });
      for await (const chunk of stream) {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let index;
        while ((index = pending.indexOf(0x0a)) !== -1) {
          handleLine(pending.subarray(0, index).toString('utf-8'), value);
          pending = pending.subarray(index + 1);
          consumed += index + 1;
        }
      }
    } catch {
      // 読めなかった分は offset を進めないので次回また読む
    }
    // 末尾の書きかけ行（最後の改行より後ろ）は処理せず、offset にも含めない
    return consumed;
  };

  // fileStat を渡せば stat を省ける（呼び元が既に取っている場合用）。読めなければ null
  const read = async (filePath, fileStat) => {
    let fileInfo = fileStat;
    if (!fileInfo) {
      try {
        fileInfo = await stat(filePath);
      } catch {
        return null;
      }
    }

    let entry = cache.get(filePath);
    // ファイルが縮んでいたら別物（ローテート・作り直し）なので先頭から読み直す
    if (entry && fileInfo.size < entry.offset) entry = null;
    if (!entry) {
      if (cache.size >= cacheMax) cache.clear();
      entry = { mtimeMs: -1, size: -1, offset: 0, value: createValue(), inFlight: null };
      cache.set(filePath, entry);
    } else if (entry.mtimeMs === fileInfo.mtimeMs && entry.size === fileInfo.size) {
      return entry.value;
    }

    // 起動中一覧と直近一覧が同じ JSONL を同時に読むことがある。並行して同じオフセットから
    // 走査すると二重に積まれるので、走査中は同じ Promise を待たせる
    if (entry.inFlight) return entry.inFlight;

    entry.inFlight = (async () => {
      try {
        if (fileInfo.size > entry.offset) {
          entry.offset += await scanFrom(filePath, entry.offset, entry.value);
        }
        entry.mtimeMs = fileInfo.mtimeMs;
        entry.size = fileInfo.size;
        return entry.value;
      } finally {
        entry.inFlight = null;
      }
    })();
    return entry.inFlight;
  };

  return { read, clear: () => cache.clear() };
}
