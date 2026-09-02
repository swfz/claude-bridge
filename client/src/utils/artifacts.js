// role: 'artifact' のメッセージ（Artifact ツールの publish 成功）から
// 「このセッションで公開したページ」の一覧を作る。
// 同じ URL への再デプロイは 1 件にまとめ、title/path は最後の publish のものを採る。
export function collectArtifacts(messages) {
  if (!Array.isArray(messages)) return [];

  const byUrl = new Map();
  for (const msg of messages) {
    if (!msg || msg.role !== 'artifact' || !msg.url) continue;

    const timestamp = msg.timestamp || '';
    const title = msg.title || msg.content || msg.url;
    const path = msg.path || null;
    const existing = byUrl.get(msg.url);

    if (!existing) {
      byUrl.set(msg.url, { url: msg.url, title, path, count: 1, lastTimestamp: timestamp });
      continue;
    }

    existing.count += 1;
    // timestamp が無いデータもあるので、その場合は「後に来たものが新しい」で上書きする
    if (!existing.lastTimestamp || timestamp >= existing.lastTimestamp) {
      existing.title = title;
      existing.path = path;
      existing.lastTimestamp = timestamp;
    }
  }

  // 最新の publish が先頭
  return [...byUrl.values()].sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
}
