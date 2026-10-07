// 会話（指示・応答・ツール呼び出しの入力・Artifact の publish）に出てきた http(s) の URL を集める純粋関数群。
// LinkDrawer がチャットの messages からクライアント側だけで一覧を作る（サーバーには取りに行かない）。
// 各 URL には「出てきた行の前後」の文脈と、WebFetch で読んだページのタイトル（role: 'webfetch'）を添える。

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
// 文脈は URL の前後それぞれこの文字数まで。行が URL だけのときに使う直前の行・WebFetch の prompt は全体でこの長さ
const CONTEXT_SIDE_CHARS = 60;
const CONTEXT_LINE_CHARS = 120;
// 文字・数字を 1 つも含まない残り（`- ` や `（）` だけ）は文脈として意味が無いので空とみなす
const MEANINGFUL_RE = /[\p{L}\p{N}]/u;

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

// テキストから URL を出現順に返す。同じ URL が複数回あってもすべて返す（まとめるのは collectLinks 側）。
// index / end は text 上の範囲で、Markdown リンク・山括弧の形式は記法全体を指す（文脈から記法ごと取り除くため）
export function extractUrls(text) {
  if (typeof text !== 'string' || !text) return [];

  const hits = [];
  let rest = text;

  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const label = m[1].trim();
    hits.push({ index: m.index, end: m.index + m[0].length, url: m[2], label: label || null });
    rest = mask(rest, m.index, m.index + m[0].length);
  }

  for (const m of rest.matchAll(ANGLE_URL_RE)) {
    hits.push({ index: m.index, end: m.index + m[0].length, url: m[1], label: null });
    rest = mask(rest, m.index, m.index + m[0].length);
  }

  for (const m of rest.matchAll(BARE_URL_RE)) {
    const url = trimTrailing(m[0]);
    // `https://` だけ等、剥がした結果ホストが残らないものは捨てる
    if (!/^https?:\/\/[^/]/.test(url)) continue;
    hits.push({ index: m.index, end: m.index + url.length, url, label: null });
  }

  return hits.sort((a, b) => a.index - b.index).map(({ url, label, index, end }) => ({ url, label, index, end }));
}

function squash(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function clip(str, max) {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// 文脈の中で「その URL があった位置」を示す目印
export const CONTEXT_LINK_MARK = '〔リンク〕';

// 文脈の中の他のリンクを読める形に縮める。Markdown リンクはラベルだけ残し、山括弧・裸の URL は落とす
// （URL が並ぶと文脈が読めず、絞り込みで別の URL の行まで引っかかるため）
function condenseOtherLinks(str) {
  return (
    str
      .replace(MARKDOWN_LINK_RE, (_m, label) => label)
      .replace(ANGLE_URL_RE, '')
      // 裸の URL の正規表現は文末の `。` や `)` まで含むので、extractUrls と同じく剥がした分は文に返す
      .replace(BARE_URL_RE, (m) => m.slice(trimTrailing(m).length))
  );
}

// URL の前後の片側を 1 行に整える。目印の側の空白は原文にあったときだけ 1 つ残し（`と 〔リンク〕。` のように
// 原文の詰め方を保つ）、遠い側を CONTEXT_SIDE_CHARS 文字で切って `…` を付ける
function contextSide(raw, side) {
  const flat = condenseOtherLinks(raw).replace(/\s+/g, ' ');
  const core = flat.trim();
  if (!core) return { core: '', text: '' };
  if (side === 'before') {
    const cut = core.length > CONTEXT_SIDE_CHARS ? `…${core.slice(-CONTEXT_SIDE_CHARS)}` : core;
    return { core, text: flat.endsWith(' ') ? `${cut} ` : cut };
  }
  const cut = core.length > CONTEXT_SIDE_CHARS ? `${core.slice(0, CONTEXT_SIDE_CHARS)}…` : core;
  return { core, text: flat.startsWith(' ') ? ` ${cut}` : cut };
}

// text の [start, end)（URL・リンク記法）が出てくる行を 1 行の文脈にして返す。
// その URL（Markdown リンクなら記法全体）は目印 〔リンク〕 に置き換え、同じ行の他のリンクは
// condenseOtherLinks で縮める。目印を中心に前後 CONTEXT_SIDE_CHARS 文字ずつに切り、切った側に `…` を付ける。
// 目印を除いた残りに文字・数字が無い（行が URL だけ）なら直前の非空行、それも無ければ null
export function contextOf(text, start, end) {
  if (typeof text !== 'string' || !text) return null;

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;

  const before = contextSide(text.slice(lineStart, start), 'before');
  const after = contextSide(text.slice(end, lineEnd), 'after');
  if (MEANINGFUL_RE.test(`${before.core} ${after.core}`)) {
    return `${before.text}${CONTEXT_LINK_MARK}${after.text}`;
  }

  // 「参考:」の次の行に URL だけ置く書き方では、直前の行が何のリンクかを説明している。
  // URL だけの箇条書きが続く（`- https://a` `- https://b`）こともあるので、他のリンクを縮めて
  // 文字・数字が残らない行は飛ばし、説明の行まで遡る
  const previousLines = text.slice(0, lineStart).split('\n').reverse();
  for (const line of previousLines) {
    const condensed = squash(condenseOtherLinks(line));
    if (MEANINGFUL_RE.test(condensed)) return clip(condensed, CONTEXT_LINE_CHARS);
  }
  return null;
}

// ツール呼び出しの入力（WebFetch の {url, prompt}、Bash の {command} など）を再帰的に辿って URL を拾う。
// 文脈は URL を含む文字列ごとに contextOf で取る（WebFetch の prompt で差し替えるのは linksInMessage 側）
export function extractUrlsFromToolInput(input, depth = 0) {
  if (input == null || depth > TOOL_INPUT_MAX_DEPTH) return [];
  if (typeof input === 'string') {
    const str = input.slice(0, TOOL_INPUT_MAX_STRING);
    return extractUrls(str).map(({ url, index, end }) => ({ url, label: null, context: contextOf(str, index, end) }));
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

// 1 メッセージから [{url, label, context, source}] を出現順に拾う
function linksInMessage(msg) {
  if (!msg) return [];

  if (msg.role === 'artifact') {
    if (typeof msg.url !== 'string' || !/^https?:\/\//.test(msg.url)) return [];
    // title は label に出すので文脈にはしない
    return [{ url: msg.url, label: msg.title || null, context: null, source: 'artifact' }];
  }

  if (msg.role !== 'human' && msg.role !== 'assistant') return [];

  const content = msg.content;
  // タグ注入（タスク通知・system-reminder 等）や isMeta の user レコードは人が打ったものではないので、
  // 人の指示（human）と区別して 'system' にする（サブエージェントが見つけた URL を「自分が渡した」にしない）
  const source = msg.role === 'human' && msg.injected ? 'system' : msg.role;
  const hits = extractUrls(content).map(({ url, label, index, end }) => ({
    url,
    label,
    context: contextOf(content, index, end),
    source,
  }));
  if (msg.role === 'assistant' && Array.isArray(msg.toolUses)) {
    for (const tool of msg.toolUses) {
      if (!tool) continue;
      const toolSource = `tool:${tool.name || 'unknown'}`;
      // WebFetch は「何を知りたくて読んだか」の prompt がそのまま文脈になる
      const fetchPrompt =
        tool.name === 'WebFetch' && typeof tool.input?.prompt === 'string' ? squash(tool.input.prompt) : '';
      for (const hit of extractUrlsFromToolInput(tool.input)) {
        const context = fetchPrompt && hit.url === tool.input.url ? clip(fetchPrompt, CONTEXT_LINE_CHARS) : hit.context;
        hits.push({ ...hit, context, source: toolSource });
      }
    }
  }
  return hits;
}

// 文脈の採用順位（小さいほど優先）。人の指示が一番「なぜそのリンクか」を表している。
// タグ注入（system）はツール入力と同じ扱い
function contextRank(source) {
  if (source === 'human') return 0;
  if (source === 'assistant') return 1;
  return 2;
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

// messages から URL ごとに 1 件の一覧を作る。並びは最後の出現が新しい順。
// 各項目の origin は最初の出現が人の指示なら 'user'、それ以外（応答・ツール入力・Artifact・WebFetch・
// タグ注入などの system）なら 'claude'。
// role: 'webfetch'（WebFetch の結果）は数に入れず、同じ URL の項目に title / code を補うだけ
// （出現は tool_use 側で数えている）。対応する項目が無ければ tool:WebFetch として作る
export function collectLinks(messages) {
  if (!Array.isArray(messages)) return [];

  const byUrl = new Map();
  messages.forEach((msg, index) => {
    if (msg && msg.role === 'webfetch') {
      if (!isHttpUrl(msg.url)) return;
      const title = msg.title || null;
      const code = typeof msg.code === 'number' ? msg.code : null;
      const existing = byUrl.get(msg.url);
      if (existing) {
        if (title) existing.title = title;
        existing.code = code;
        return;
      }
      // webfetch のレコードはチャットに描かないので、会話へのジャンプ先にはしない
      byUrl.set(msg.url, {
        url: msg.url,
        origin: 'claude',
        label: null,
        title,
        code,
        context: null,
        host: hostOf(msg.url),
        count: 1,
        sources: ['tool:WebFetch'],
        firstUuid: null,
        lastUuid: null,
        lastTimestamp: msg.timestamp || '',
        lastIndex: index,
        contextRank: Infinity,
      });
      return;
    }

    for (const hit of linksInMessage(msg)) {
      const uuid = msg.uuid || null;
      const timestamp = msg.timestamp || '';
      const existing = byUrl.get(hit.url);

      if (!existing) {
        byUrl.set(hit.url, {
          url: hit.url,
          // 誰が持ち込んだ URL か。最初の出現で決める（Claude が見つけた URL を後で人が引用しても user にしない）
          origin: hit.source === 'human' ? 'user' : 'claude',
          label: hit.label || null,
          title: null,
          code: null,
          context: hit.context || null,
          host: hostOf(hit.url),
          count: 1,
          sources: [hit.source],
          firstUuid: uuid,
          lastUuid: uuid,
          lastTimestamp: timestamp,
          lastIndex: index,
          contextRank: hit.context ? contextRank(hit.source) : Infinity,
        });
        continue;
      }

      existing.count += 1;
      if (!existing.label && hit.label) existing.label = hit.label;
      // 文脈は優先順位の高い出どころのものを、同順位なら最初の出現を採る
      if (hit.context && contextRank(hit.source) < existing.contextRank) {
        existing.context = hit.context;
        existing.contextRank = contextRank(hit.source);
      }
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
  return sorted.map(({ lastIndex: _lastIndex, contextRank: _contextRank, ...link }) => link);
}

// クリップボードコピー用の Markdown（1 行 1 リンク）
export function linksToMarkdown(links) {
  if (!Array.isArray(links)) return '';
  return links
    .map((link) => {
      const line = `- [${link.label || link.title || link.url}](${link.url})`;
      return link.context ? `${line} — ${link.context}` : line;
    })
    .join('\n');
}
