import { readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  CLAUDE_PROJECTS_DIR,
  extractArtifactPublish,
  extractContextUsage,
  extractTextContent,
  extractToolUses,
} from './jsonl-utils.js';
import { readFirstLines, readSessionSummary } from './session-summary.js';

// セッション JSONL から最初のユーザーメッセージを抽出
function extractFirstUserMessage(lines) {
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'user') {
        return extractTextContent(record.message, 100);
      }
    } catch {
      continue;
    }
  }
  return '';
}

// ~/.claude/projects/ 以下の JSONL をファイル情報だけ集める（中身は読まない）。
// dir はテストから差し替えられるようにしている。
function collectSessionFiles(dir) {
  let projectDirs;
  try {
    projectDirs = readdirSync(dir);
  } catch {
    return [];
  }

  const candidates = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(dir, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const cwd = projectDir.replace(/^-/, '/').replace(/-/g, '/');

    let files;
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectPath, file);
      try {
        const fileStat = statSync(filePath);
        candidates.push({
          sessionId: file.replace('.jsonl', ''),
          projectDir,
          cwd,
          filePath,
          updatedAt: fileStat.mtime.toISOString(),
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        });
      } catch {
        continue;
      }
    }
  }

  // 更新日時の降順
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

// ホーム画面用: 直近 days 日以内に更新されたセッション。
// 起動中かどうかは見ない（突合はクライアント側）。
export async function listRecentSessions({
  days = 7,
  limit = 50,
  dir = CLAUDE_PROJECTS_DIR,
  now = Date.now(),
  includeSessionIds = [],
  sessionIds = null,
} = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  // Star を付けたセッションは「続きをやる」印なので、期間外でも limit で切らずに必ず返す
  const pinned = new Set(includeSessionIds);
  const files = collectSessionFiles(dir);
  // 活動グラフの棒で期間を選んだときは ID の集合で絞る。mtime は「最後に更新した日」
  // でしかなく、その日に活動して後日また続けたセッションが漏れるため使わない
  const inRange = sessionIds ? (c) => sessionIds.has(c.sessionId) : (c) => c.mtimeMs >= since;
  const top = [
    ...files.filter((c) => pinned.has(c.sessionId)),
    ...files.filter((c) => !pinned.has(c.sessionId) && inRange(c)).slice(0, limit),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);

  return Promise.all(
    top.map(async (c) => {
      // タイトル・冒頭の依頼・直近のやりとり（カードで中身が分かるように）
      const summary = await readSessionSummary(c.filePath);
      return {
        sessionId: c.sessionId,
        projectDir: c.projectDir,
        updatedAt: c.updatedAt,
        size: c.size,
        ...summary,
        // ディレクトリ名にハイフンを含むと projectDir からは cwd を復元できないので
        // JSONL に書かれた cwd を優先する（再開時の起動先になる）
        cwd: summary.cwd || c.cwd,
      };
    }),
  );
}

// ~/.claude/projects/ 以下のセッションを非同期で一覧
export async function listClaudeSessions({ limit = 30 } = {}) {
  const top = collectSessionFiles(CLAUDE_PROJECTS_DIR).slice(0, limit);

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
    }),
  );

  return sessions;
}

// JSONL の文字列を会話履歴（メッセージ配列）に変換する。
// セッション本体とサブエージェントのトランスクリプトは同じ形式なので両方から使う。
export function parseHistoryLines(content) {
  const messages = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === 'user') {
        const text = extractTextContent(record.message, 0);
        if (text) {
          messages.push({
            role: 'human',
            content: text,
            // 安定アンカー用に JSONL の uuid を持たせる
            uuid: record.uuid,
            timestamp: record.timestamp || record.updatedAt || '',
          });
        }
        // Artifact の publish は tool_result だけの user レコードなので、
        // テキスト抽出とは独立に見る（本文が無くても公開リンクは出したい）
        const artifact = extractArtifactPublish(record);
        if (artifact) {
          messages.push({
            role: 'artifact',
            content: artifact.title,
            url: artifact.url,
            title: artifact.title,
            path: artifact.path,
            uuid: record.uuid,
            timestamp: record.timestamp || record.updatedAt || '',
          });
        }
      } else if (record.type === 'queue-operation' && record.operation === 'enqueue' && record.content) {
        messages.push({
          role: 'human',
          content: record.content,
          uuid: record.uuid,
          timestamp: record.timestamp || '',
        });
      } else if (record.type === 'assistant') {
        const text = extractTextContent(record.message, 0);
        const toolUses = extractToolUses(record.message);
        if (text || toolUses.length > 0) {
          // コンテキスト使用量は usage のある assistant にだけ付ける（クライアントが末尾から探す）
          const contextUsage = extractContextUsage(record);
          messages.push({
            role: 'assistant',
            content: text,
            toolUses: toolUses.length > 0 ? toolUses : undefined,
            contextUsage: contextUsage || undefined,
            uuid: record.uuid,
            timestamp: record.timestamp || record.updatedAt || '',
          });
        }
      }
    } catch {
      continue;
    }
  }

  return messages;
}

// セッション JSONL から会話履歴を抽出
export async function loadSessionHistory(sessionId, projectDir) {
  const filePath = join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  return parseHistoryLines(content);
}
