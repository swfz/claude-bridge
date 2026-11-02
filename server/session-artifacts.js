import { createIncrementalReader } from './jsonl-incremental.js';
import { extractArtifactPublish } from './jsonl-utils.js';

// セッション JSONL の「どこにでも現れ得る」レコードを全文の差分走査（jsonl-incremental.js）で拾う。
// - Artifact の publish（claude.ai に公開したページ）
// - `/rename` で付けたタイトル（`{type: 'custom-title', customTitle}`。会話の途中で書かれるので head/tail では拾えない）
// 走査は 1 回で両方を集める（数十 MB の JSONL を二度読まないため）。

// JSON.parse は重いので、対象の行だけを通す安価なプリフィルタ
function looksLikePublish(line) {
  return line.includes('"toolUseResult"') && line.includes('claude.ai');
}

function looksLikeCustomTitle(line) {
  return line.includes('"custom-title"');
}

const reader = createIncrementalReader({
  prefilter: (line) => looksLikePublish(line) || looksLikeCustomTitle(line),
  createValue: () => ({ artifacts: [], customTitle: '' }),
  collect: (record, value) => {
    // `/rename` は何度でも打てるので最後のものを使う
    if (record.type === 'custom-title') {
      if (typeof record.customTitle === 'string') value.customTitle = record.customTitle.trim();
      return;
    }
    const publish = extractArtifactPublish(record);
    if (publish) value.artifacts.push({ ...publish, timestamp: record.timestamp || '' });
  },
});

// セッション JSONL に現れた publish の生リスト（出現順・重複排除はしない）。
// fileStat を渡せば stat を省ける（呼び元が既に取っている場合用）。
export async function readSessionArtifacts(filePath, fileStat) {
  return (await reader.read(filePath, fileStat))?.artifacts || [];
}

// `/rename` で付けた最新のタイトル（無ければ ''）
export async function readSessionCustomTitle(filePath, fileStat) {
  return (await reader.read(filePath, fileStat))?.customTitle || '';
}

// テスト用（同じパスに別内容を書くケースがあるのでキャッシュを捨てられるようにする）
export function clearSessionArtifactsCache() {
  reader.clear();
}
