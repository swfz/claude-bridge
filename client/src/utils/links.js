// 会話（指示・応答・ツール呼び出しの入力・Artifact の publish）に出てきた http(s) の URL を集める純粋関数群。
// LinkDrawer がチャットの messages からクライアント側だけで一覧を作る（サーバーには取りに行かない）。

// URL の本体。空白・山括弧・引用符・バッククォート・全角の閉じ括弧で切る
const BARE_URL_RE = /https?:\/\/[^\s<>"'`）」』]+/g;
// [label](https://...) と [label](https://... "title")。URL 中の (x) は 1 段だけ許す
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\)/g;
// <https://...>
const ANGLE_URL_RE = /<(https?:\/\/[^\s<>]+)>/g;
// 文末に付きがちで URL の一部ではない文字
const TRAILING_CHARS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '）', '」', '』', '。', '、']);

const TOOL_INPUT_MAX_DEPTH = 3;
const TOOL_INPUT_MAX_STRING = 20000;

function countChar(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n += 1;
  return n;
}

// 末尾の句読点・閉じ括弧を剥がす。ただし `(x)` を含む URL（Wikipedia 等）の `)` は、
// 開き括弧と釣り合っている間は URL の一部として残す（`]` も同様）
function trimTrailing(url) {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (!TRAILING_CHARS.has(last)) break;
    if (last === ')' && countChar(result, ')') <= countChar(result, '(')) break;
    if (last === ']' && countChar(result, ']') <= countChar(result, '[')) break;
    result = result.slice(0, -1);
  }
  return result;
}

// 既に拾った範囲を空白で塗りつぶし、後段の裸 URL の走査で二重に拾わないようにする
function mask(text, start, end) {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

// テキストから URL を出現順に返す。同じ URL が複数回あってもすべて返す（まとめるのは collectLinks 側）
export function extractUrls(text) {
  if (typeof text !== 'string' || !text) return [];

  const hits = [];
  let rest = text;

  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const label = m[1].trim();
    hits.push({ index: m.index, url: m[2], label: label || null });
    rest = mask(rest, m.index, m.index + m[0].length);
  }

  for (const m of rest.matchAll(ANGLE_URL_RE)) {
    hits.push({ index: m.index, url: m[1], label: null });
    rest = mask(rest, m.index, m.index + m[0].length);
  }

  for (const m of rest.matchAll(BARE_URL_RE)) {
    const url = trimTrailing(m[0]);
    // `https://` だけ等、剥がした結果ホストが残らないものは捨てる
    if (!/^https?:\/\/[^/]/.test(url)) continue;
    hits.push({ index: m.index, url, label: null });
  }

  return hits.sort((a, b) => a.index - b.index).map(({ url, label }) => ({ url, label }));
}

// ツール呼び出しの入力（WebFetch の {url, prompt}、Bash の {command} など）を再帰的に辿って URL を拾う
export function extractUrlsFromToolInput(input, depth = 0) {
  if (input == null || depth > TOOL_INPUT_MAX_DEPTH) return [];
  if (typeof input === 'string') {
    return extractUrls(input.slice(0, TOOL_INPUT_MAX_STRING)).map(({ url }) => ({ url, label: null }));
  }
  if (typeof input !== 'object') return [];

  const values = Array.isArray(input) ? input : Object.values(input);
  return values.flatMap((value) => extractUrlsFromToolInput(value, depth + 1));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// 1 メッセージから [{url, label, source}] を出現順に拾う
function linksInMessage(msg) {
  if (!msg) return [];

  if (msg.role === 'artifact') {
    if (typeof msg.url !== 'string' || !/^https?:\/\//.test(msg.url)) return [];
    return [{ url: msg.url, label: msg.title || null, source: 'artifact' }];
  }

  if (msg.role !== 'human' && msg.role !== 'assistant') return [];

  const hits = extractUrls(msg.content).map((hit) => ({ ...hit, source: msg.role }));
  if (msg.role === 'assistant' && Array.isArray(msg.toolUses)) {
    for (const tool of msg.toolUses) {
      if (!tool) continue;
      const source = `tool:${tool.name || 'unknown'}`;
      for (const hit of extractUrlsFromToolInput(tool.input)) hits.push({ ...hit, source });
    }
  }
  return hits;
}

// messages から URL ごとに 1 件の一覧を作る。並びは最後の出現が新しい順
export function collectLinks(messages) {
  if (!Array.isArray(messages)) return [];

  const byUrl = new Map();
  messages.forEach((msg, index) => {
    for (const hit of linksInMessage(msg)) {
      const uuid = msg.uuid || null;
      const timestamp = msg.timestamp || '';
      const existing = byUrl.get(hit.url);

      if (!existing) {
        byUrl.set(hit.url, {
          url: hit.url,
          label: hit.label || null,
          host: hostOf(hit.url),
          count: 1,
          sources: [hit.source],
          firstUuid: uuid,
          lastUuid: uuid,
          lastTimestamp: timestamp,
          lastIndex: index,
        });
        continue;
      }

      existing.count += 1;
      if (!existing.label && hit.label) existing.label = hit.label;
      if (!existing.sources.includes(hit.source)) existing.sources.push(hit.source);
      if (!existing.firstUuid) existing.firstUuid = uuid;
      // uuid の無いメッセージでジャンプ先を失わないよう、直前の uuid を引き継ぐ
      existing.lastUuid = uuid || existing.lastUuid;
      existing.lastTimestamp = timestamp || existing.lastTimestamp;
      existing.lastIndex = index;
    }
  });

  // timestamp が両方あればそれで、無ければメッセージの出現順（後ろほど新しい）で比べる
  const sorted = [...byUrl.values()].sort((a, b) => {
    if (a.lastTimestamp && b.lastTimestamp && a.lastTimestamp !== b.lastTimestamp) {
      return b.lastTimestamp.localeCompare(a.lastTimestamp);
    }
    return b.lastIndex - a.lastIndex;
  });
  return sorted.map(({ lastIndex: _lastIndex, ...link }) => link);
}

// クリップボードコピー用の Markdown（1 行 1 リンク）
export function linksToMarkdown(links) {
  if (!Array.isArray(links)) return '';
  return links.map((link) => `- [${link.label || link.url}](${link.url})`).join('\n');
}
