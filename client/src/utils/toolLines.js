// チャットのツール行（1 ツール呼び出し = 1 行）と、連続するツール呼び出しの束の整形。純粋関数だけを置く。
// 方針は「既定値は出さない、例外だけ目立たせる」: 目立たせるのは失敗と、ファイル編集の差分行数だけ。

// ファイルを扱うツール。行全体のクリックでプレビューを開き、パスを「薄いディレクトリ＋ファイル名」で出す
export const FILE_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ファイルを書き換えるツール（差分行数を付ける）
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);

export function toolFilePath(tool) {
  if (!tool || !FILE_TOOL_NAMES.has(tool.name)) return null;
  const path = tool.input?.file_path || tool.input?.notebook_path;
  return typeof path === 'string' && path ? path : null;
}

// パスを「ディレクトリ（薄く出す）」と「ファイル名」に分ける。cwd 配下なら cwd からの相対にする
export function splitFilePath(path, cwd) {
  if (!path) return { dir: '', name: '' };
  let shown = path;
  const base = cwd ? cwd.replace(/\/+$/, '') : '';
  if (base && path.startsWith(`${base}/`)) shown = path.slice(base.length + 1);
  const i = shown.lastIndexOf('/');
  return i < 0 ? { dir: '', name: shown } : { dir: shown.slice(0, i + 1), name: shown.slice(i + 1) };
}

// 行数。空文字は 0、末尾の改行は数えない
export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

function linesOf(text) {
  if (typeof text !== 'string' || text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

// 置換前後の行の増減。同じ行は打ち消し合う（多重集合の差）ので、変更していない前後の文脈行は数えない
export function lineDiffStats(oldText, newText) {
  const remaining = new Map();
  for (const line of linesOf(oldText)) remaining.set(line, (remaining.get(line) || 0) + 1);
  let added = 0;
  for (const line of linesOf(newText)) {
    const n = remaining.get(line) || 0;
    if (n > 0) remaining.set(line, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of remaining.values()) removed += n;
  return { added, removed };
}

// ツール 1 回分の差分行数。ファイルを書き換えるツールだけ。flags は結果の印（{created} 等）
export function toolDiffStats(tool, flags) {
  if (!tool || !WRITE_TOOL_NAMES.has(tool.name)) return null;
  const input = tool.input || {};
  if (tool.name === 'Write') {
    return { added: countLines(input.content), removed: 0, created: !!flags?.created };
  }
  if (tool.name === 'MultiEdit') {
    const stats = { added: 0, removed: 0, created: false };
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      const s = lineDiffStats(edit?.old_string, edit?.new_string);
      stats.added += s.added;
      stats.removed += s.removed;
    }
    return stats;
  }
  return { ...lineDiffStats(input.old_string, input.new_string), created: false };
}

// toolresult メッセージ（サーバーが流すツールの失敗・新規作成の印）を tool_use の id で引けるようにする
export function buildToolResultIndex(messages) {
  const index = new Map();
  for (const m of messages || []) {
    if (m?.role !== 'toolresult' || !Array.isArray(m.results)) continue;
    for (const r of m.results) {
      if (r?.id) index.set(r.id, { ...index.get(r.id), ...r });
    }
  }
  return index;
}

// ChatMessage（memo）に渡すための、そのメッセージのツールの印を表す文字列。
// Map をそのまま渡すと参照が毎回変わって memo が効かないので、中身が同じなら同じ文字列にする
export function toolFlagsKey(toolUses, index) {
  if (!Array.isArray(toolUses) || !index || index.size === 0) return '';
  const parts = [];
  for (const tool of toolUses) {
    const f = index.get(tool?.id);
    if (!f) continue;
    if (f.error) parts.push(`e:${tool.id}`);
    else if (f.created) parts.push(`c:${tool.id}`);
  }
  return parts.join('|');
}

export function parseToolFlagsKey(key) {
  const flags = new Map();
  if (!key) return flags;
  for (const part of key.split('|')) {
    const kind = part.slice(0, 1);
    const id = part.slice(2);
    if (!id) continue;
    flags.set(id, kind === 'e' ? { error: true } : { created: true });
  }
  return flags;
}

// 本文が無くツール呼び出しだけの assistant メッセージ（JSONL では content ブロックごとに 1 レコードになるので多い）
export function isToolOnlyMessage(m) {
  return m?.role === 'assistant' && !(m.content || '').trim() && Array.isArray(m.toolUses) && m.toolUses.length > 0;
}

// 描画単位に並べ直す。ツールだけのメッセージが続いて合計 2 件以上のツール呼び出しになったら 1 つの束にする。
// 束の key は先頭メッセージの id（後ろに伸びても変わらないので開閉の状態が保たれる）
export function groupChatItems(messages) {
  const items = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const count = run.reduce((n, m) => n + m.toolUses.length, 0);
    if (count >= 2) items.push({ kind: 'tools', key: `tools-${run[0].id}`, messages: run });
    else items.push({ kind: 'message', key: run[0].id, message: run[0] });
    run = [];
  };
  for (const m of messages || []) {
    if (isToolOnlyMessage(m)) {
      // 過去の会話と新着の境目では束を切る（「ここから新規」の区切り線を束の途中に埋もれさせない）
      if (run.length > 0 && !!run[run.length - 1].isHistory !== !!m.isHistory) flush();
      run.push(m);
      continue;
    }
    flush();
    items.push({ kind: 'message', key: m.id, message: m });
  }
  flush();
  return items;
}

// ファイル以外のツール行に出す説明。サーバーの summary（コマンド・説明・パターン）を優先し、
// summary がツール名のままのとき（WebFetch など）は入力の URL・クエリ、それも無ければツール名
export function toolDescription(tool) {
  if (!tool) return '';
  if (tool.summary && tool.summary !== tool.name) return tool.summary;
  const input = tool.input || {};
  return input.url || input.query || input.prompt || input.description || tool.name || '';
}

// 束の見出しに出す集計（件数・失敗件数・差分の合計）。畳んでも失敗と差分が隠れないようにするため
export function summarizeToolRun(tools, index) {
  const summary = { count: 0, failed: 0, added: 0, removed: 0 };
  for (const tool of tools || []) {
    summary.count += 1;
    const flags = index?.get(tool?.id);
    if (flags?.error) summary.failed += 1;
    const stats = toolDiffStats(tool, flags);
    if (stats) {
      summary.added += stats.added;
      summary.removed += stats.removed;
    }
  }
  return summary;
}
