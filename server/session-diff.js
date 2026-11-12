import { execFile } from 'child_process';
import { lstat, open, realpath, stat } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { isSensitivePath } from './sensitive-paths.js';
import { toRepoRelative } from './session-completion.js';

// 入力欄の /diff で開く差分ドロワーのデータ。Claude Code の /diff は TUI 内のモーダルで
// ブラウザからは見えないので、ブリッジ自身が git から差分を取る。
//   scope: 'all'     … cwd のリポジトリ全体（git diff HEAD ＋未追跡ファイル）
//          'session' … このセッションが Edit / Write したファイルだけ（並行セッションの変更を混ぜない）
// git はシェルを通さず execFile で呼び、パスは pathspec の :(literal) で渡す。

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// クライアントに返す patch の合計（超えたら残りのファイルは patch なしで truncated）
export const MAX_TOTAL_PATCH = 2 * 1024 * 1024;
// 1 ファイルの patch の上限
export const MAX_FILE_PATCH = 512 * 1024;
// 未追跡ファイルの中身を読む上限と件数
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_UNTRACKED_FILES = 200;
// session スコープで pathspec に渡すファイル数（コマンドラインの長さを抑える）
const MAX_PATHSPECS = 500;
// コミットが 1 つも無いリポジトリで HEAD の代わりに比べる空の tree
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args, cwd) {
  return execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function literal(paths) {
  return paths.map((p) => `:(literal)${p}`);
}

// `--- a/x` / `+++ b/x` の行からパスを取る。git は空白を含むパスの行末にタブを付け、
// 制御文字・引用符・バックスラッシュを含むパスは "..." で囲むので、それぞれ剥がす
export function headerPath(line) {
  let path = line.slice(4).replace(/\t$/, '');
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return path.replace(/^[ab]\//, '');
}

// `diff --git a/x b/y` の塊からパスを取る。--- / +++ 行があればそちらを信じる
// （空白を含むパスでヘッダ行の区切りが曖昧になるため）。本文の行と取り違えないよう最初の @@ より前だけを見る
function pathOfChunk(lines) {
  const hunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = hunk < 0 ? lines : lines.slice(0, hunk);
  const plus = header.find((l) => l.startsWith('+++ '));
  const minus = header.find((l) => l.startsWith('--- '));
  if (plus && plus !== '+++ /dev/null') return headerPath(plus);
  if (minus && minus !== '--- /dev/null') return headerPath(minus);
  const rename = header.find((l) => l.startsWith('rename to '));
  if (rename) return rename.slice('rename to '.length);
  const first = lines[0].match(/^diff --git a\/(.*) b\/(.*)$/);
  return first ? first[2] : lines[0];
}

// git diff の出力をファイルごとに分ける純粋関数
export function parseUnifiedDiff(text) {
  if (!text) return [];
  const files = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const lines = chunk.replace(/\n$/, '').split('\n');
    let status = 'modified';
    if (lines.some((l) => l.startsWith('new file mode'))) status = 'added';
    else if (lines.some((l) => l.startsWith('deleted file mode'))) status = 'deleted';
    else if (lines.some((l) => l.startsWith('rename from'))) status = 'renamed';
    const binary = lines.some((l) => /^Binary files .* differ$/.test(l) || l === 'GIT binary patch');
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith('@@')) inHunk = true;
      else if (!inHunk) continue;
      else if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    const oldPath = status === 'renamed' ? lines.find((l) => l.startsWith('rename from '))?.slice(12) : undefined;
    files.push({ path: pathOfChunk(lines), oldPath, status, binary, additions, deletions, patch: chunk });
  }
  return files;
}

// 未追跡ファイルを「全行追加」の patch にする純粋関数
export function untrackedPatch(path, content) {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  if (lines.length === 0) return { patch: header, additions: 0 };
  const body = lines.map((l) => `+${l}`).join('\n');
  const noEol = content.endsWith('\n') ? '' : '\n\\ No newline at end of file';
  return { patch: `${header}@@ -0,0 +1,${lines.length} @@\n${body}${noEol}\n`, additions: lines.length };
}

async function readHead(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_UNTRACKED_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    return { buf, size };
  } finally {
    await handle.close();
  }
}

// シンボリックリンクは辿らない（リンク先の秘密鍵などを patch として流さないため。/preview と同じ方針）。
// 資格情報の置き場（.env など ignore されていないもの）も isSensitivePath で中身を出さない
async function readUntracked(root, rel) {
  const path = join(root, rel);
  const empty = { path: rel, status: 'untracked', binary: false, additions: 0, deletions: 0, patch: '' };
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { ...empty, symlink: true };
    if (!info.isFile()) return { ...empty, binary: true };
  } catch {
    return { ...empty, binary: true };
  }
  if (isSensitivePath(path)) return { ...empty, sensitive: true };
  try {
    const { buf, size } = await readHead(path);
    if (buf.includes(0)) return { path: rel, status: 'untracked', binary: true, additions: 0, deletions: 0, patch: '' };
    if (size > MAX_UNTRACKED_BYTES) {
      return { path: rel, status: 'untracked', binary: false, additions: 0, deletions: 0, patch: '', tooLarge: true };
    }
    const { patch, additions } = untrackedPatch(rel, buf.toString('utf-8'));
    return { path: rel, status: 'untracked', binary: false, additions, deletions: 0, patch };
  } catch {
    // ディレクトリへのシンボリックリンク・読めないファイル
    return { path: rel, status: 'untracked', binary: true, additions: 0, deletions: 0, patch: '' };
  }
}

// patch の合計サイズを抑える。上限を超えたファイルは patch を空にして tooLarge / truncated を立てる
export function capPatches(files, { total = MAX_TOTAL_PATCH, perFile = MAX_FILE_PATCH } = {}) {
  let used = 0;
  let truncated = false;
  const capped = files.map((file) => {
    const size = Buffer.byteLength(file.patch || '');
    if (size > perFile) return { ...file, patch: '', tooLarge: true };
    if (used + size > total) {
      truncated = true;
      return { ...file, patch: '', tooLarge: true };
    }
    used += size;
    return file;
  });
  return { files: capped, truncated };
}

// editedFiles は scope: 'session' のときだけ使う（セッションが編集した絶対パス）
export async function readSessionDiff({ cwd, scope = 'all', editedFiles = [] }) {
  if (!cwd) throw new Error('セッションの作業ディレクトリが分かりません');
  let root;
  let realCwd;
  try {
    const [{ stdout }, real] = await Promise.all([git(['rev-parse', '--show-toplevel'], cwd), realpath(cwd)]);
    root = stdout.trim();
    realCwd = real;
  } catch {
    throw new Error('git リポジトリではないか、作業ディレクトリが削除されています');
  }

  let pathspecs = [];
  let sessionFiles = [];
  let outside = 0;
  let overLimit = false;
  if (scope === 'session') {
    const relPaths = editedFiles.map((p) => toRepoRelative(p, { cwd, realCwd, root }));
    outside = relPaths.filter((p) => !p).length;
    sessionFiles = [...new Set(relPaths.filter((p) => p))].sort();
    if (sessionFiles.length === 0) return { root, scope, files: [], truncated: false, outside };
    // 上限を超えた分は git に聞かないので「差分なし」とも言えない。並べずに truncated で知らせる
    overLimit = sessionFiles.length > MAX_PATHSPECS;
    sessionFiles = sessionFiles.slice(0, MAX_PATHSPECS);
    pathspecs = ['--', ...literal(sessionFiles)];
  }

  let base = 'HEAD';
  try {
    await git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  } catch {
    base = EMPTY_TREE;
  }

  let diffText;
  let untrackedText;
  try {
    [{ stdout: diffText }, { stdout: untrackedText }] = await Promise.all([
      git(['diff', base, '--no-color', '--no-ext-diff', '--find-renames', ...pathspecs], root),
      git(['ls-files', '--others', '--exclude-standard', '-z', ...pathspecs], root),
    ]);
  } catch (e) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('差分が大きすぎて表示できません（「このセッション」に絞ると読めることがあります）', {
        cause: e,
      });
    }
    throw e;
  }

  const tracked = parseUnifiedDiff(diffText);
  const untrackedPaths = untrackedText.split('\0').filter(Boolean);
  const untracked = await Promise.all(untrackedPaths.slice(0, MAX_UNTRACKED_FILES).map((p) => readUntracked(root, p)));
  let files = [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));

  if (scope === 'session') {
    // 編集したのに差分が無いファイル＝コミット済み（または元に戻した）。空にすると
    // 何も編集していないように見えるので、差分なしとして並べる
    // 件数の上限で読まなかった未追跡ファイルも「差分あり」側に数える
    const changed = new Set([...files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)), ...untrackedPaths]);
    const clean = [];
    for (const rel of sessionFiles) {
      if (changed.has(rel)) continue;
      const exists = await stat(join(root, rel)).then(
        () => true,
        () => false,
      );
      clean.push({
        path: rel,
        status: exists ? 'committed' : 'missing',
        binary: false,
        additions: 0,
        deletions: 0,
        patch: '',
      });
    }
    files = [...files, ...clean];
  }

  const capped = capPatches(files);
  return {
    root,
    scope,
    files: capped.files,
    truncated: capped.truncated || overLimit || untrackedPaths.length > MAX_UNTRACKED_FILES,
    outside,
  };
}
