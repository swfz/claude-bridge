import { createIncrementalReader } from './jsonl-incremental.js';
import { extractArtifactPublish } from './jsonl-utils.js';

// セッション JSONL から Artifact の publish（claude.ai に公開したページ）を拾う。
// publish のレコードは JSONL のどこにでも現れるので、全文を差分走査する（jsonl-incremental.js）。

// JSON.parse は重いので、publish 行だけを通す安価なプリフィルタ
function looksLikePublish(line) {
  return line.includes('"toolUseResult"') && line.includes('claude.ai');
}

const reader = createIncrementalReader({
  prefilter: looksLikePublish,
  createValue: () => [],
  collect: (record, artifacts) => {
    const publish = extractArtifactPublish(record);
    if (publish) artifacts.push({ ...publish, timestamp: record.timestamp || '' });
  },
});

// セッション JSONL に現れた publish の生リスト（出現順・重複排除はしない）。
// fileStat を渡せば stat を省ける（呼び元が既に取っている場合用）。
export async function readSessionArtifacts(filePath, fileStat) {
  return (await reader.read(filePath, fileStat)) || [];
}

// テスト用（同じパスに別内容を書くケースがあるのでキャッシュを捨てられるようにする）
export function clearSessionArtifactsCache() {
  reader.clear();
}
