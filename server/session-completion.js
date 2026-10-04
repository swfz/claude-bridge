import { exec } from 'child_process';
import { readdir, realpath } from 'fs/promises';
import { dirname, basename, join, relative, sep, isAbsolute } from 'path';
import { promisify } from 'util';
import { createIncrementalReader } from './jsonl-incremental.js';

// ホームの「やり残し判定」のうち、ファイルとリポジトリを見る部分。
// 「このセッションが Edit / Write したファイル」のうち、今 git で未コミットのものを数える。
// cwd 全体の git status にしないのは、同じリポジトリで並行している別セッションの変更を
// 巻き込まないため。

// コマンド文字列は固定で、cwd はオプションで渡すのでシェルに値を埋め込まない
const execAsync = promisify(exec);

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const GIT_CACHE_MS = 15 * 1000;
const MAX_LISTED = 20;

const editsReader = createIncrementalReader({
  // Edit 系の tool_use を含む行だけ parse する
  prefilter: (line) =>
    line.includes('"tool_use"') && (line.includes('"file_path"') || line.includes('"notebook_path"')),
  createValue: () => new Set(),
  collect: (record, files) => {
    if (record.type !== 'assistant') return;
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
      const path = block.input?.file_path || block.input?.notebook_path;
      if (typeof path === 'string' && isAbsolute(path)) files.add(path);
    }
  },
});

// セッション本体とサブエージェント（<sessionId>/subagents/agent-*.jsonl）が編集したファイル
export async function readSessionEditedFiles(filePath) {
  const files = new Set((await editsReader.read(filePath)) || []);
  const subDir = join(dirname(filePath), basename(filePath, '.jsonl'), 'subagents');
  let entries = [];
  try {
    entries = await readdir(subDir);
  } catch {
    // サブエージェントを使っていないセッション
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    for (const path of (await editsReader.read(join(subDir, name))) || []) files.add(path);
  }
  return [...files];
}

// git status --porcelain -z の出力を「リポジトリルートからの相対パス」の集合にする。
// rename / copy は「新しいパス\0元のパス」の 2 項目になるので、元のパス側を読み飛ばす。
export function parsePorcelainZ(stdout) {
  const dirty = new Set();
  const items = stdout.split('\0');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.length < 4) continue;
    const status = item.slice(0, 2);
    dirty.add(item.slice(3));
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return dirty;
}

// cwd -> { at, promise }。git status はリポジトリごとに 1 回で済ませ、15 秒使い回す
const gitCache = new Map();

async function readGitState(cwd) {
  try {
    const opts = { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 };
    const [{ stdout: top }, { stdout: status }, realCwd] = await Promise.all([
      execAsync('git rev-parse --show-toplevel', opts),
      execAsync('git status --porcelain -z --untracked-files=all', opts),
      realpath(cwd),
    ]);
    return { root: top.trim(), realCwd, dirty: parsePorcelainZ(status) };
  } catch {
    // cwd が消えている（worktree 削除済みなど）・git 管理外
    return null;
  }
}

export function getGitState(cwd, now = Date.now()) {
  const hit = gitCache.get(cwd);
  if (hit && now - hit.at < GIT_CACHE_MS) return hit.promise;
  const promise = readGitState(cwd);
  if (gitCache.size >= 200) gitCache.clear();
  gitCache.set(cwd, { at: now, promise });
  return promise;
}

// 編集したファイル（絶対パス）を、リポジトリルートからの相対パスに直す。
// Claude が書くパスは JSONL の cwd と同じ表記で、git のルートは実体パス（macOS の
// /tmp → /private/tmp など）なので、cwd の前置きを実体パスに置き換えてから比べる。
export function toRepoRelative(path, { cwd, realCwd, root }) {
  let resolved = path;
  if (cwd && realCwd && cwd !== realCwd && (path === cwd || path.startsWith(cwd + sep))) {
    resolved = realCwd + path.slice(cwd.length);
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return relative(root, resolved);
}

// セッションの「コミット済みか」。
//   git: 'none'    … 編集したファイルが無い（判定の必要なし）
//        'clean'   … 編集したファイルはすべてコミット済み
//        'dirty'   … 未コミットが残っている（uncommitted に先頭 20 件）
//        'unknown' … cwd が git で読めない（worktree 削除済みなど）
export async function readSessionCompletion({ filePath, cwd }) {
  const edited = await readSessionEditedFiles(filePath);
  if (edited.length === 0) return { edited: 0, git: 'none', uncommitted: [], uncommittedCount: 0 };
  const state = cwd ? await getGitState(cwd) : null;
  if (!state) return { edited: edited.length, git: 'unknown', uncommitted: [], uncommittedCount: 0 };

  const uncommitted = [];
  for (const path of edited) {
    const rel = toRepoRelative(path, { cwd, realCwd: state.realCwd, root: state.root });
    if (rel && state.dirty.has(rel)) uncommitted.push(rel);
  }
  uncommitted.sort();
  return {
    edited: edited.length,
    git: uncommitted.length > 0 ? 'dirty' : 'clean',
    uncommitted: uncommitted.slice(0, MAX_LISTED),
    uncommittedCount: uncommitted.length,
  };
}

// テスト用
export function clearSessionCompletionCache() {
  editsReader.clear();
  gitCache.clear();
}
