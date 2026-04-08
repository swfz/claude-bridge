import { readdirSync, statSync, createReadStream } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// JSONL の先頭 N 行だけ非同期で読む
function readFirstLines(filePath, maxLines) {
  return new Promise((resolve) => {
    const lines = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      lines.push(line);
      if (lines.length >= maxLines) rl.close();
    });
    rl.on("close", () => resolve(lines));
    rl.on("error", () => resolve(lines));
  });
}

// セッション JSONL から最初のユーザーメッセージを抽出
function extractFirstUserMessage(lines) {
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === "user") {
        return extractTextContent(record.message);
      }
    } catch {
      continue;
    }
  }
  return "";
}

// message オブジェクトからテキストを取り出す（maxLen=0 で全文）
function extractTextContent(msg, maxLen = 100) {
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
      // 全テキストブロックを結合
      text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
    }
  }
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

// ~/.claude/projects/ 以下のセッションを非同期で一覧
export async function listClaudeSessions({ limit = 30 } = {}) {
  let projectDirs;
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  // まずファイル情報だけ集める（高速）
  const candidates = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const cwd = projectDir.replace(/^-/, "/").replace(/-/g, "/");

    let files;
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectPath, file);
      try {
        const fileStat = statSync(filePath);
        candidates.push({
          sessionId: file.replace(".jsonl", ""),
          projectDir,
          cwd,
          filePath,
          updatedAt: fileStat.mtime.toISOString(),
          size: fileStat.size,
        });
      } catch {
        continue;
      }
    }
  }

  // 更新日時の降順でソートし、上位だけ詳細を読む
  candidates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const top = candidates.slice(0, limit);

  // 先頭行だけ並列で読む
  const sessions = await Promise.all(
    top.map(async (c) => {
      const lines = await readFirstLines(c.filePath, 15);
      return {
        sessionId: c.sessionId,
        projectDir: c.projectDir,
        cwd: c.cwd,
        firstUserMessage: extractFirstUserMessage(lines),
        updatedAt: c.updatedAt,
        size: c.size,
      };
    })
  );

  return sessions;
}

// セッション JSONL から会話履歴を抽出
export async function loadSessionHistory(sessionId, projectDir) {
  const filePath = join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === "user") {
        const text = extractTextContent(record.message, 0);
        if (text) {
          messages.push({
            role: "human",
            content: text,
            timestamp: record.timestamp || record.updatedAt || "",
          });
        }
      } else if (record.type === "assistant") {
        const text = extractTextContent(record.message, 0);
        if (text) {
          messages.push({
            role: "assistant",
            content: text,
            timestamp: record.timestamp || record.updatedAt || "",
          });
        }
      }
    } catch {
      continue;
    }
  }

  return messages;
}
