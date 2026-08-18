import { readdirSync, statSync } from "fs";
import { open, readFile } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR } from "./jsonl-utils.js";
import { parseHistoryLines } from "./claude-sessions.js";

// ファイルパスに使う ID なのでトラバーサル対策で文字種を絞る
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_RE = /^[\w-]+$/;

// 親 JSONL から拾った tool_use_id（jsonlPath -> { offset, ids }）。
// JSONL は追記のみなので、前回読んだオフセット以降だけを読み足す（数十 MB を毎回読まない）。
const toolResultCache = new Map();

// 親セッションの JSONL に現れた tool_use_id の集合。サブエージェントの完了は
// 「その toolUseId の tool_result が親に書かれたか」で判定する。
// 一覧とドロワーのポーリングは別メッセージとして並行に走るため、同じファイルの
// 読み足しは直列化する（並行に走ると offset が二重に進んで未走査領域が生まれる）。
async function collectToolResultIds(jsonlPath) {
  let entry = toolResultCache.get(jsonlPath);
  if (!entry) {
    entry = { offset: 0, ids: new Set(), lock: Promise.resolve() };
    toolResultCache.set(jsonlPath, entry);
  }
  const run = entry.lock.then(() => scanAppendedLines(jsonlPath, entry));
  entry.lock = run.catch(() => {});
  await run;
  return entry.ids;
}

// 前回オフセット以降の追記分だけを読み、tool_use_id を entry.ids に足す
async function scanAppendedLines(jsonlPath, entry) {
  let fileStat;
  try {
    fileStat = statSync(jsonlPath);
  } catch {
    return;
  }

  // ファイルが縮んでいたら別物（ローテート等）なので先頭から読み直す
  if (fileStat.size < entry.offset) {
    entry.offset = 0;
    entry.ids = new Set();
  }
  if (fileStat.size === entry.offset) return;

  const fh = await open(jsonlPath, "r");
  try {
    const length = fileStat.size - entry.offset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, entry.offset);
    // 末尾が書きかけの行だと ID が途中で切れるので、最後の改行までしか取り込まない
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      const text = buf.subarray(0, lastNewline + 1).toString("utf-8");
      for (const m of text.matchAll(/"tool_use_id"\s*:\s*"([^"]+)"/g)) {
        entry.ids.add(m[1]);
      }
      entry.offset += lastNewline + 1;
    }
  } finally {
    await fh.close();
  }
}

// サブエージェントのトランスクリプトが置かれるディレクトリ
function subagentsDir(projectsDir, projectDir, claudeSessionId) {
  return join(projectsDir, projectDir, claudeSessionId, "subagents");
}

function validTarget(projectDir, claudeSessionId) {
  return (
    typeof projectDir === "string" &&
    projectDir.length > 0 &&
    typeof claudeSessionId === "string" &&
    SESSION_ID_RE.test(claudeSessionId)
  );
}

// セッションが起動したサブエージェント（Agent ツール）の一覧。
// 情報源は ~/.claude/projects/<projectDir>/<claudeSessionId>/subagents/agent-*.meta.json
export async function listSubagentTasks({
  projectDir,
  claudeSessionId,
  projectsDir = CLAUDE_PROJECTS_DIR,
} = {}) {
  if (!validTarget(projectDir, claudeSessionId)) return [];

  const dir = subagentsDir(projectsDir, projectDir, claudeSessionId);
  let metaFiles;
  try {
    metaFiles = readdirSync(dir).filter(
      (f) => f.startsWith("agent-") && f.endsWith(".meta.json")
    );
  } catch {
    // サブエージェントを起こしていないセッションではディレクトリ自体が無い
    return [];
  }

  const doneIds = await collectToolResultIds(
    join(projectsDir, projectDir, `${claudeSessionId}.jsonl`)
  );

  const tasks = [];
  for (const file of metaFiles) {
    const agentId = file.slice("agent-".length, -".meta.json".length);
    let meta;
    try {
      meta = JSON.parse(await readFile(join(dir, file), "utf-8"));
    } catch {
      continue;
    }

    // 更新時刻・サイズはトランスクリプト側を見る（無ければ meta の mtime）
    let updatedAt = "";
    let size = 0;
    try {
      const st = statSync(join(dir, `agent-${agentId}.jsonl`));
      updatedAt = st.mtime.toISOString();
      size = st.size;
    } catch {
      try {
        updatedAt = statSync(join(dir, file)).mtime.toISOString();
      } catch {
        updatedAt = "";
      }
    }

    tasks.push({
      agentId,
      agentType: meta.agentType || "",
      description: meta.description || "",
      // toolUseId が無い古い形式は完了判定ができないので完了扱いにする
      status: !meta.toolUseId || doneIds.has(meta.toolUseId) ? "completed" : "running",
      updatedAt,
      size,
    });
  }

  // 実行中を先頭に、その中では更新の新しい順
  tasks.sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return tasks;
}

// サブエージェントの会話。通常セッションの JSONL と同じ形式なのでパースも共通。
// 読めない（存在しない・agentId が不正）場合は null。
export async function readSubagentTranscript({
  projectDir,
  claudeSessionId,
  agentId,
  projectsDir = CLAUDE_PROJECTS_DIR,
} = {}) {
  if (!validTarget(projectDir, claudeSessionId)) return null;
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return null;

  const filePath = join(
    subagentsDir(projectsDir, projectDir, claudeSessionId),
    `agent-${agentId}.jsonl`
  );
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return parseHistoryLines(content);
}
