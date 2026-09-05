import { basename, join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_BRIDGE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

// cwd からプロジェクトディレクトリ名を算出。Claude Code は `/` だけでなく英数字以外を
// すべて `-` にする（`.claude/worktrees/x` → `--claude-worktrees-x`。実測 v2.1.260）ので同じ規則で写す。
// `/` だけ置換すると worktree 配下の cwd で JSONL が見つからず、tmux タブに履歴もタスクも出ない
// e.g. /path/to/project → -path-to-project
export function cwdToProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// message オブジェクトからテキストを取り出す（maxLen=0 で全文）
export function extractTextContent(msg, maxLen = 0) {
  let text = '';
  if (typeof msg === 'string') {
    text = msg;
  } else if (!msg) {
    return '';
  } else {
    const content = msg.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
    }
  }
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

// Artifact ツールの publish 成功レコードから公開先を取り出す。
// 成功時だけ toolUseResult がオブジェクトで url/path/title を持つ（失敗時は文字列 + is_error、
// read/list の結果は url を持たない）ので、それを判定条件にしている。
const ARTIFACT_URL_PATTERN = /^https:\/\/claude\.ai\//;

export function extractArtifactPublish(record) {
  if (!record || record.type !== 'user') return null;

  const result = record.toolUseResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  const url = result.url;
  if (typeof url !== 'string' || !ARTIFACT_URL_PATTERN.test(url)) return null;

  const content = record.message?.content;
  if (!Array.isArray(content)) return null;
  const hasSuccess = content.some((b) => b && b.type === 'tool_result' && !b.is_error);
  if (!hasSuccess) return null;

  const path = typeof result.path === 'string' && result.path ? result.path : null;
  const title = result.title || (path ? basename(path) : '') || url;
  return { url, title, path };
}

// message オブジェクトから tool_use ブロックを抽出
export function extractToolUses(msg) {
  if (!msg || typeof msg === 'string') return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input,
      summary: toolUseSummary(b.name, b.input),
    }));
}

function toolUseSummary(name, input) {
  if (!input) return name;
  switch (name) {
    case 'Bash':
      return input.description || input.command?.slice(0, 120) || 'Bash';
    case 'Read':
    case 'Edit':
    case 'Write':
      return shortPath(input.file_path);
    case 'Grep':
    case 'Glob':
      return `${input.pattern}${input.path ? ' in ' + shortPath(input.path) : ''}`;
    case 'Agent':
      return input.description || 'Agent';
    case 'Artifact':
      // publish 以外（read/list 等）は action 名、publish は対象ファイルを出す
      return input.action && input.action !== 'publish' ? input.action : `publish ${shortPath(input.file_path)}`.trim();
    case 'AskUserQuestion':
      // 回答済みの選択肢は会話ログに残るので、何を聞かれたかが分かるようにする
      return (
        (input.questions || [])
          .map((q) => q?.question)
          .filter(Boolean)
          .join(' / ') || 'AskUserQuestion'
      );
    default:
      return name;
  }
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

// コンテキスト窓の上限。JSONL には窓サイズが書かれないので、モデル ID からのヒューリスティック。
// - `[1m]` 付き（Claude Code の 1M 設定）は 1M
// - opus 4.6 以降・opus 5 以降・fable / mythos 系は 1M（この環境の JSONL で `[1m]` 表記なしに
//   700k〜900k の文脈量が実測されたため。200k にすると常時 100% にクランプされて意味を失う）
// - sonnet / haiku / それ以外（不明）は 200k
// さらに実測の文脈量が窓を超えていれば 1M に繰り上げる（表が古くなっても 100% 張り付きにはならない）。
const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_1M = 1_000_000;
const MODELS_1M = /claude-(opus-4-(?:[6-9]|[1-9]\d)|opus-(?:[5-9]|[1-9]\d)|fable|mythos)/;

export function contextWindowFor(model, contextTokens = 0) {
  const id = typeof model === 'string' ? model : '';
  if (id.includes('[1m]') || MODELS_1M.test(id)) return CONTEXT_WINDOW_1M;
  return contextTokens > CONTEXT_WINDOW_DEFAULT ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT;
}

// assistant レコードから「今そのセッションが使っているコンテキスト量」を取り出す。
// Claude Code の statusline と同じ考え方で、直近の assistant の
// input + cache_creation + cache_read が現在の文脈量（output は次ターンの入力になるまで含まれない）。
// usage を持たないレコード（API エラー等）は null を返すので、呼び出し側が末尾から遡って探す。
export function extractContextUsage(record) {
  if (!record || record.type !== 'assistant') return null;

  const usage = record.message?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const inputTokens = num(usage.input_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const model = typeof record.message?.model === 'string' ? record.message.model : '';
  const contextTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  // 全部 0 は API を呼んでいない合成レコード（`<synthetic>` のエラー表示等）。文脈量としては無効
  if (contextTokens === 0) return null;

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    contextTokens,
    contextWindow: contextWindowFor(model, contextTokens),
    model,
  };
}
