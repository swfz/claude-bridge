import { join } from "path";
import { homedir } from "os";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// cwd からプロジェクトディレクトリ名を算出
// e.g. /path/to/project → -path-to-project
export function cwdToProjectDir(cwd) {
  return cwd.replace(/\//g, "-");
}

// message オブジェクトからテキストを取り出す（maxLen=0 で全文）
export function extractTextContent(msg, maxLen = 0) {
  let text = "";
  if (typeof msg === "string") {
    text = msg;
  } else if (!msg) {
    return "";
  } else {
    const content = msg.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
    }
  }
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

// message オブジェクトから tool_use ブロックを抽出
export function extractToolUses(msg) {
  if (!msg || typeof msg === "string") return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use")
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
    case "Bash":
      return input.description || input.command?.slice(0, 120) || "Bash";
    case "Read": case "Edit": case "Write":
      return shortPath(input.file_path);
    case "Grep": case "Glob":
      return `${input.pattern}${input.path ? " in " + shortPath(input.path) : ""}`;
    case "Agent":
      return input.description || "Agent";
    default:
      return name;
  }
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
}
