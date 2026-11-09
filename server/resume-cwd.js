import * as fsPromises from 'fs/promises';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';
import { readSessionSummary } from './session-summary.js';

// stat は呼び出し時に引く（fs/promises を mock.module するテストに import 時点で縛られないため）
async function defaultIsDir(path) {
  try {
    return (await fsPromises.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// クライアントから来た projectDir を CLAUDE_PROJECTS_DIR 配下の 1 階層に限る（get_session_turns と同じ検証）
export function isValidProjectDir(projectDir) {
  return typeof projectDir === 'string' && /^[\w.-]+$/.test(projectDir) && !projectDir.startsWith('..');
}

// resume の起動先 cwd を決める。`claude -w` のセッションは終了時に worktree ごと消えるので、
// JSONL に書かれた cwd がもう無いことがある。tmux の `new-window -c` も node-pty の spawn も
// 存在しないディレクトリだと黙ってホームに落ち、claude が「~ で git 管理外」として続行してしまう。
// そこで cwd が無ければ JSONL の relocated / worktree-state の元リポジトリに差し替え、
// それも無ければホームには落とさずエラーにする。
// cwd が与えられた場合だけを扱う（cwd 無しの既定挙動は呼び出し側が持つ）。
export async function resolveResumeCwd(
  { cwd, claudeSessionId, projectDir },
  { isDir = defaultIsDir, readSummary = readSessionSummary, projectsDir = CLAUDE_PROJECTS_DIR } = {},
) {
  if (await isDir(cwd)) return { cwd, relocated: false };

  const notFound = () => new Error(`作業ディレクトリが見つかりません: ${cwd}（worktree が削除済みかもしれません）`);
  if (!isValidProjectDir(projectDir)) throw notFound();
  if (typeof claudeSessionId !== 'string' || !/^[\w-]+$/.test(claudeSessionId)) throw notFound();

  const summary = await readSummary(join(projectsDir, projectDir, `${claudeSessionId}.jsonl`));
  const relocatedCwd = summary?.relocatedCwd;
  if (relocatedCwd && relocatedCwd !== cwd && (await isDir(relocatedCwd))) {
    return { cwd: relocatedCwd, relocated: true, originalCwd: cwd };
  }
  throw notFound();
}
