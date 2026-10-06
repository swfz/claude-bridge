import { exec } from 'child_process';
import { readdir, realpath } from 'fs/promises';
import { dirname, basename, join, relative, sep, isAbsolute } from 'path';
import { promisify } from 'util';
import { createIncrementalReader } from './jsonl-incremental.js';
import { clearPrStateCache, getPrState } from './pr-state.js';

// ホームの「やり残し判定」のうち、ファイルとリポジトリを見る部分。
// 「このセッションが Edit / Write したファイル」のうち、今 git で未コミットのものを数える。
// cwd 全体の git status にしないのは、同じリポジトリで並行している別セッションの変更を
// 巻き込まないため。
// あわせて「このセッションで push（または PR 作成）したか」を JSONL から拾う。これも同じ
// 理由で git（リモートとの差分）には聞かず、このセッション自身の記録だけを証拠にする。

// コマンド文字列は固定で、cwd はオプションで渡すのでシェルに値を埋め込まない
const execAsync = promisify(exec);

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const GIT_CACHE_MS = 15 * 1000;
const MAX_LISTED = 20;
// マージ状態を確かめる PR の数（新しい順）
const MAX_PRS = 5;

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

// コマンドの先頭か、&& || ; | ( の直後にある `git [グローバルオプション] push`
const GIT_PUSH_RE = /(?:^|&&|\|\||[;|(])\s*git\s+(?:-\S+\s+(?:\S+\s+)?)*push(?![\w-])/g;
// push の引数の範囲（次のコマンド区切りまで）
const NEXT_COMMAND_RE = /&&|\|\||[;|)]/;

// Bash のコマンド文字列に（dry-run ではない）git push が含まれるか。
// session-turns.js の parseCommitSubjects() と同じ流儀で、行ごとにコマンドの位置にある
// git push だけを数え、ヒアドキュメントの本文・コメント・引用符で囲んだ文字列の中は拾わない。
export function hasGitPush(command) {
  if (typeof command !== 'string') return false;
  const lines = command.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    // 引用符の中（echo "git push" やコミットメッセージ）を消してから探す
    const code = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    if (!/^\s*#/.test(code)) {
      for (const match of code.matchAll(GIT_PUSH_RE)) {
        const rest = code.slice(match.index + match[0].length);
        const args = rest.split(NEXT_COMMAND_RE)[0];
        if (!/(?:^|\s)(?:--dry-run|-n)(?=\s|$)/.test(args)) return true;
      }
    }
    if (heredoc) {
      // 本文を読み飛ばす（スクリプトやファイルの書き出しの中の文字列を拾わない）
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== heredoc[1]) j++;
      i = j;
    }
  }
  return false;
}

const pushReader = createIncrementalReader({
  // git push を含み得る Bash の tool_use、エラーになった tool_result、PR 作成の記録だけ parse する
  prefilter: (line) =>
    (line.includes('"Bash"') && line.includes('push')) ||
    line.includes('"pr-link"') ||
    line.includes('"is_error":true'),
  createValue: () => ({ pushIds: new Set(), errorIds: new Set(), prUrls: new Set() }),
  collect: (record, value) => {
    if (record.type === 'pr-link') {
      if (typeof record.prUrl === 'string' && record.prUrl) value.prUrls.add(record.prUrl);
      return;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (record.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Bash') {
        if (block.id && hasGitPush(block.input?.command)) value.pushIds.add(block.id);
      } else if (record.type === 'user' && block?.type === 'tool_result' && block.is_error === true) {
        if (block.tool_use_id) value.errorIds.add(block.tool_use_id);
      }
    }
  },
});

// セッション本体とサブエージェント（<sessionId>/subagents/agent-*.jsonl）の JSONL のパス
async function sessionJsonlPaths(filePath) {
  const subDir = join(dirname(filePath), basename(filePath, '.jsonl'), 'subagents');
  let entries = [];
  try {
    entries = await readdir(subDir);
  } catch {
    // サブエージェントを使っていないセッション
  }
  return [filePath, ...entries.filter((name) => name.endsWith('.jsonl')).map((name) => join(subDir, name))];
}

// セッション本体とサブエージェントが編集したファイル
export async function readSessionEditedFiles(filePath) {
  const files = new Set();
  for (const path of await sessionJsonlPaths(filePath)) {
    for (const file of (await editsReader.read(path)) || []) files.add(file);
  }
  return [...files];
}

// このセッション（本体＋サブエージェント）で push したか・PR を作ったか。
// push はエラーで返った（拒否・認証失敗など）ものを除く。PR は pr-link レコードの URL で数える。
// prUrls は出現順（本体 → サブエージェント）で重複なし
export async function readSessionPushes(filePath) {
  const pushIds = new Set();
  const errorIds = new Set();
  const prUrls = new Set();
  for (const path of await sessionJsonlPaths(filePath)) {
    const value = await pushReader.read(path);
    if (!value) continue;
    for (const id of value.pushIds) pushIds.add(id);
    for (const id of value.errorIds) errorIds.add(id);
    for (const url of value.prUrls) prUrls.add(url);
  }
  const pushed = prUrls.size > 0 || [...pushIds].some((id) => !errorIds.has(id));
  return { pushed, prCount: prUrls.size, prUrls: [...prUrls] };
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
    const [{ stdout: top }, { stdout: status }, { stdout: remotes }, realCwd] = await Promise.all([
      execAsync('git rev-parse --show-toplevel', opts),
      execAsync('git status --porcelain -z --untracked-files=all', opts),
      // リモートの無いローカル専用リポジトリは push しようがないので、コミットで完了とみなす
      execAsync('git remote', opts),
      realpath(cwd),
    ]);
    const hasRemote = remotes.split('\n').some((line) => line.trim() !== '');
    return { root: top.trim(), realCwd, dirty: parsePorcelainZ(status), hasRemote };
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
//   pushed   … このセッションで push（エラーで返ったものを除く）か PR 作成をした
//   prCount  … このセッションで作った PR の数（pr-link レコードの URL で数える）
//   hasRemote … リポジトリにリモートがあるか（git: 'none' / 'unknown' のときは null）
//   prs       … このセッションで作った PR（新しい順に最大 5 件）とマージ状態 [{url, state}]。
//               git の状態に関わらず見る（編集なしで ship だけしたセッションも PR の状態で判定するため）
// prState は PR の状態の取得（テスト用の差し替え口。既定は gh pr view）
export async function readSessionCompletion({ filePath, cwd, prState = getPrState }) {
  const [edited, { pushed, prCount, prUrls }] = await Promise.all([
    readSessionEditedFiles(filePath),
    readSessionPushes(filePath),
  ]);
  const recentPrs = prUrls.slice(-MAX_PRS).reverse();
  const prs = await Promise.all(recentPrs.map(async (url) => ({ url, state: await prState(url) })));
  const base = { pushed, prCount, hasRemote: null, prs };
  if (edited.length === 0) return { edited: 0, git: 'none', uncommitted: [], uncommittedCount: 0, ...base };
  const state = cwd ? await getGitState(cwd) : null;
  if (!state) return { edited: edited.length, git: 'unknown', uncommitted: [], uncommittedCount: 0, ...base };

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
    ...base,
    hasRemote: state.hasRemote,
  };
}

// テスト用
export function clearSessionCompletionCache() {
  editsReader.clear();
  pushReader.clear();
  gitCache.clear();
  clearPrStateCache();
}
