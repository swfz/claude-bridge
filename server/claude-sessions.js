import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  CLAUDE_PROJECTS_DIR,
  extractArtifactPublish,
  extractWebFetchResult,
  extractToolResultFlags,
  extractContextUsage,
  extractTextContent,
  extractToolUses,
  humanMessageFields,
} from './jsonl-utils.js';
import { readFirstLines, readSessionSummary, summarizeHead } from './session-summary.js';
import { readSessionCompletion } from './session-completion.js';

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

// `claude -p`（非対話の print モード）で動いたセッションか。JSONL の各レコードに書かれる
// `entrypoint` が `sdk-cli`（対話は `cli`）になる。セッション内で変わらないので見つかった
// 値はファイル単位で永続キャッシュする（先頭が session-owner / queue-operation のように
// entrypoint を持たないレコードのこともあるので数行読む。見つからなければキャッシュしない）
const entrypointCache = new Map();
const ENTRYPOINT_HEAD_LINES = 20;

export async function readSessionEntrypoint(filePath) {
  if (entrypointCache.has(filePath)) return entrypointCache.get(filePath);
  let lines;
  try {
    lines = await readFirstLines(filePath, ENTRYPOINT_HEAD_LINES);
  } catch {
    return null;
  }
  for (const line of lines) {
    if (!line.includes('"entrypoint"')) continue;
    try {
      const { entrypoint } = JSON.parse(line);
      if (typeof entrypoint === 'string') {
        entrypointCache.set(filePath, entrypoint);
        return entrypoint;
      }
    } catch {
      // 書きかけの行は飛ばす
    }
  }
  return null;
}

export function clearEntrypointCache() {
  entrypointCache.clear();
}

export const isHeadlessEntrypoint = (entrypoint) => entrypoint === 'sdk-cli';

// ホーム画面用: 直近 days 日以内に更新されたセッション。
// 起動中かどうかは見ない（突合はクライアント側）。
export async function listRecentSessions({
  days = 7,
  limit = 50,
  dir = CLAUDE_PROJECTS_DIR,
  now = Date.now(),
  includeSessionIds = [],
  sessionIds = null,
  includeHeadless = true,
} = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  // Star を付けたセッションは「続きをやる」印なので、期間外でも limit で切らずに必ず返す
  const pinned = new Set(includeSessionIds);
  const files = collectSessionFiles(dir);
  // 活動グラフの棒で期間を選んだときは ID の集合で絞る。mtime は「最後に更新した日」
  // でしかなく、その日に活動して後日また続けたセッションが漏れるため使わない
  const inRange = sessionIds ? (c) => sessionIds.has(c.sessionId) : (c) => c.mtimeMs >= since;
  let candidates = files.filter((c) => !pinned.has(c.sessionId) && inRange(c));
  // `claude -p` のセッション（スケジュール実行など）は数が多く一覧を埋めるので、
  // 除外するときは limit で切る前に落とす（後で落とすと表示件数が減るだけになる）。
  // Star を付けたものは明示的に残したい印なので除外しない
  if (!includeHeadless) {
    const entrypoints = await Promise.all(candidates.map((c) => readSessionEntrypoint(c.filePath)));
    candidates = candidates.filter((_, i) => !isHeadlessEntrypoint(entrypoints[i]));
  }
  const top = [...files.filter((c) => pinned.has(c.sessionId)), ...candidates.slice(0, limit)].sort(
    (a, b) => b.mtimeMs - a.mtimeMs,
  );

  return Promise.all(
    top.map(async (c) => {
      // タイトル・冒頭の依頼・直近のやりとり（カードで中身が分かるように）
      const summary = await readSessionSummary(c.filePath);
      const cwd = summary.cwd || c.cwd;
      return {
        sessionId: c.sessionId,
        projectDir: c.projectDir,
        updatedAt: c.updatedAt,
        size: c.size,
        ...summary,
        // ディレクトリ名にハイフンを含むと projectDir からは cwd を復元できないので
        // JSONL に書かれた cwd を優先する（再開時の起動先になる）
        cwd,
        // やり残し判定（編集したファイルが未コミットのまま残っていないか）
        completion: await readSessionCompletion({ filePath: c.filePath, cwd }),
      };
    }),
  );
}

// ~/.claude/projects/ 以下のセッションを非同期で一覧
// 新規セッションの作業ディレクトリ候補にするディレクトリへ寄せる。
// `claude -w` / EnterWorktree の worktree（<repo>/.claude/worktrees/<name>）は使い捨てなのでリポジトリのルートに、
// サブエージェント・スキルが使うスクラッチパッド（<tmpdir>/claude-<uid>/...）は候補にしない。
export function projectRootOf(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  if (/^\/tmp\/claude-\d+(\/|$)/.test(cwd)) return null;
  const i = cwd.indexOf('/.claude/worktrees/');
  return i > 0 ? cwd.slice(0, i) : cwd;
}

// セッション開始時の cwd（先頭 40 行の cwd。途中で worktree に入ったものは worktree-state の元の cwd）。
// 開始時の値は変わらないのでファイル単位で永続キャッシュする
const startCwdCache = new Map();
async function readStartCwd(filePath) {
  if (startCwdCache.has(filePath)) return startCwdCache.get(filePath);
  let cwd = '';
  try {
    const lines = await readFirstLines(filePath, 40);
    for (const line of lines) {
      if (!line.includes('"originalCwd"')) continue;
      try {
        const o = JSON.parse(line);
        if (typeof o.worktreeSession?.originalCwd === 'string') cwd = o.worktreeSession.originalCwd;
      } catch {
        // 書きかけの行は飛ばす
      }
      if (cwd) break;
    }
    if (!cwd) cwd = summarizeHead(lines).cwd;
  } catch {
    return '';
  }
  if (cwd) startCwdCache.set(filePath, cwd);
  return cwd;
}

// 新規セッションの作業ディレクトリ候補: 直近 days 日に動いたセッションの開始ディレクトリをユニークにして返す
// （最近使った順・セッション数つき）。projectDir 名からの復元はハイフンを区別できないので JSONL の cwd を使い、
// Artifact の全文走査を伴う readSessionSummary は使わない。消えたディレクトリは候補にしない。
export async function listRecentDirs({ days = 90, dir = CLAUDE_PROJECTS_DIR, now = Date.now(), limit = 300 } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const files = [];
  for (const c of collectSessionFiles(dir)) {
    if (c.mtimeMs < since) break; // 更新日時の降順なので以降は全部期間外
    files.push(c);
  }
  const cwds = await Promise.all(files.map((c) => readStartCwd(c.filePath)));
  const merged = new Map();
  files.forEach((c, i) => {
    const root = projectRootOf(cwds[i] || c.cwd);
    if (!root) return;
    const prev = merged.get(root);
    if (prev) prev.count += 1;
    else merged.set(root, { cwd: root, lastUsedAt: c.updatedAt, count: 1 }); // files は新しい順
  });
  return [...merged.values()].filter((e) => existsSync(e.cwd)).slice(0, limit);
}

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
            ...humanMessageFields(record, text),
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
        // ツールの失敗・新規作成。チャットのツール行に印を付けるのに使う（それ自体は描かない）
        const toolResults = extractToolResultFlags(record);
        if (toolResults.length > 0) {
          messages.push({
            role: 'toolresult',
            content: '',
            results: toolResults,
            uuid: record.uuid,
            timestamp: record.timestamp || record.updatedAt || '',
          });
        }
        // WebFetch の結果。LinkDrawer が URL に読んだページの見出しを添えるのに使う（チャットには描かない）
        const webFetch = extractWebFetchResult(record);
        if (webFetch) {
          messages.push({
            role: 'webfetch',
            content: webFetch.title || webFetch.url,
            url: webFetch.url,
            title: webFetch.title,
            code: webFetch.code,
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
