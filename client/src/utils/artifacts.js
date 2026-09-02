// publish の生リスト（`[{url, title, path, timestamp}]`）を URL ごとにまとめる。
// 同じ URL への再デプロイは 1 件にして回数を count に持ち、title/path は最後の publish のものを採る。
export function groupArtifactPublishes(publishes) {
  if (!Array.isArray(publishes)) return [];

  const byUrl = new Map();
  for (const publish of publishes) {
    if (!publish || !publish.url) continue;

    const timestamp = publish.timestamp || '';
    const title = publish.title || publish.url;
    const path = publish.path || null;
    const existing = byUrl.get(publish.url);

    if (!existing) {
      byUrl.set(publish.url, { url: publish.url, title, path, count: 1, lastTimestamp: timestamp });
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

// role: 'artifact' のメッセージ（Artifact ツールの publish 成功）から
// 「このセッションで公開したページ」の一覧を作る。
export function collectArtifacts(messages) {
  if (!Array.isArray(messages)) return [];

  const publishes = messages
    .filter((msg) => msg && msg.role === 'artifact' && msg.url)
    .map((msg) => ({
      url: msg.url,
      title: msg.title || msg.content || msg.url,
      path: msg.path,
      timestamp: msg.timestamp,
    }));
  return groupArtifactPublishes(publishes);
}
