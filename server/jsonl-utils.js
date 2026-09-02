import { basename, join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_BRIDGE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

// cwd からプロジェクトディレクトリ名を算出
// e.g. /path/to/project → -path-to-project
export function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, '-');
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
