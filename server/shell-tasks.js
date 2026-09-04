import { readdirSync, statSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';

// ファイルパスに使う ID なのでトラバーサル対策で文字種を絞る
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_RE = /^[\w-]+$/;

// Claude Code が Bash ツールの出力をライブで書き出す先の起点。
// 実測（v2.1.260）で <os.tmpdir()>/claude-<uid>/<projectDir>/<claudeSessionId>/tasks/<taskId>.output。
// E2E ではフィクスチャに差し替えたいので env で上書きできるようにする（CLAUDE_PROJECTS_DIR と同じ流儀）。
function defaultShellTasksRoot() {
  // Windows には getuid が無いので、その場合は uid 無しの固定名に落とす
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `claude-${uid}`);
}

export const SHELL_TASKS_ROOT = process.env.CLAUDE_BRIDGE_SHELL_TASKS_ROOT || defaultShellTasksRoot();

// 実行中／終了済みの Bash 出力ファイルが置かれるディレクトリ
export function shellTasksDir({ projectDir, claudeSessionId, rootDir = SHELL_TASKS_ROOT } = {}) {
  return join(rootDir, projectDir, claudeSessionId, 'tasks');
}

function validTarget(projectDir, claudeSessionId) {
  return (
    typeof projectDir === 'string' &&
    projectDir.length > 0 &&
    typeof claudeSessionId === 'string' &&
    SESSION_ID_RE.test(claudeSessionId)
  );
}

// 出力には ANSI エスケープ（色・カーソル移動・タイトル設定）が混じるので落とす。
// CSI（ESC [ ... 終端）と OSC（ESC ] ... BEL または ESC \）の 2 種類だけを対象にする。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// バックグラウンド実行の Bash は終了時にこのフッター行が追記されてファイルが残る。
// 前景の Bash は終了するとファイルごと消えるので、フッターが無い＝実行中とみなせる。
const EXIT_FOOTER_RE = /^\[exited with code (-?\d+)\]$/;

// 出力ファイルの末尾だけを読むためのバイト数。status 判定にはフッター 1 行あれば足りるが、
// preview（末尾の非空行）が途中で切れないよう少し多めに取る（全文は読まない）。
const TAIL_BYTES = 4096;

// ファイル末尾の最大 bytes バイトを読む。先頭が行の途中で切れている可能性があるので
// truncated で知らせる（呼び出し側で壊れた 1 行目を捨てる）。
async function readTail(filePath, size, bytes) {
  const length = Math.min(size, bytes);
  if (length <= 0) return { text: '', truncated: false };

  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, size - length);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), truncated: length < size };
  } finally {
    await fh.close();
  }
}

// 末尾から読んだテキストの、先頭の壊れた行を捨てる
function dropPartialFirstLine(text) {
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : '';
}

// ANSI 除去済みの本文からフッター行を取り除き、status / exitCode を決める
function splitExitFooter(text) {
  const lines = text.split('\n');
  // 末尾の空行はフッターの後ろに付くので飛ばす
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last >= 0) {
    const m = EXIT_FOOTER_RE.exec(lines[last].trim());
    if (m) {
      lines.splice(last, 1);
      return { body: lines.join('\n'), status: 'exited', exitCode: Number(m[1]) };
    }
  }
  return { body: text, status: 'running', exitCode: null };
}

// フッターを除いた末尾の非空行 1 行（チップに出す 1 行サマリ）
function lastNonEmptyLine(body) {
  const lines = body.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.slice(0, 120);
  }
  return '';
}

// 末尾だけを読んで status / exitCode / preview を得る
async function readTailInfo(filePath, size) {
  let raw;
  let truncated;
  try {
    ({ text: raw, truncated } = await readTail(filePath, size, TAIL_BYTES));
  } catch {
    return { status: 'running', exitCode: null, preview: '' };
  }
  if (truncated) raw = dropPartialFirstLine(raw);
  const { body, status, exitCode } = splitExitFooter(stripAnsi(raw));
  return { status, exitCode, preview: lastNonEmptyLine(body) };
}

// 親 JSONL から拾った Bash の tool_use / tool_result（jsonlPath -> entry）。
// JSONL は追記のみなので、前回読んだオフセット以降だけを読み足す（数十 MB を毎回読まない）。
const jsonlCache = new Map();

function newCacheEntry() {
  return {
    offset: 0,
    lock: Promise.resolve(),
    // toolUseId -> { description, order }。order は JSONL の出現順（前景の対応づけに使う）
    bashUses: new Map(),
    // tool_result が書かれた tool_use_id（= もう終わっている Bash）
    doneIds: new Set(),
    // taskId -> toolUseId。バックグラウンド Bash は tool_result のテキストに出力先パスが載る
    taskToToolUse: new Map(),
    order: 0,
  };
}

export function clearShellTasksCache() {
  jsonlCache.clear();
}

// 一覧のポーリングが並行しても offset が二重に進まないよう、同じファイルの読み足しは直列化する
async function collectBashContext(jsonlPath) {
  let entry = jsonlCache.get(jsonlPath);
  if (!entry) {
    entry = newCacheEntry();
    jsonlCache.set(jsonlPath, entry);
  }
  const run = entry.lock.then(() => scanAppendedLines(jsonlPath, entry));
  entry.lock = run.catch(() => {});
  await run;
  return entry;
}

// バックグラウンド Bash の tool_result の冒頭に出る定型文（ここから taskId を拾う）。
// 出力先パスの `tasks/<id>.output` だけで判定すると、後で別のツール（ファイル読みや
// ブラウザ操作の結果など）がその文字列を含んだときに対応表を上書きしてラベルが消えるので、
// この定型文＋「Bash の tool_use に対する tool_result」に限る
const BACKGROUND_TASK_RE = /Command running in background with ID: ([A-Za-z0-9_-]+)/;

// tool_result ブロックのテキストを取り出す（content は文字列にも配列にもなる）
function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// 前回オフセット以降の追記分だけを読み、Bash の tool_use / tool_result を entry に足す
async function scanAppendedLines(jsonlPath, entry) {
  let fileStat;
  try {
    fileStat = statSync(jsonlPath);
  } catch {
    return;
  }

  // ファイルが縮んでいたら別物（ローテート等）なので先頭から読み直す
  if (fileStat.size < entry.offset) {
    const fresh = newCacheEntry();
    entry.offset = 0;
    entry.bashUses = fresh.bashUses;
    entry.doneIds = fresh.doneIds;
    entry.taskToToolUse = fresh.taskToToolUse;
    entry.order = 0;
  }
  if (fileStat.size === entry.offset) return;

  const fh = await open(jsonlPath, 'r');
  let text;
  try {
    const length = fileStat.size - entry.offset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, entry.offset);
    // 末尾が書きかけの行だと JSON が途中で切れるので、最後の改行までしか取り込まない
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    text = buf.subarray(0, lastNewline + 1).toString('utf-8');
    entry.offset += lastNewline + 1;
  } finally {
    await fh.close();
  }

  for (const line of text.split('\n')) {
    // JSON.parse は高くつくので、関係のある行だけに絞ってから通す
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block) continue;
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
        const input = block.input || {};
        entry.bashUses.set(block.id, {
          description: input.description || (input.command || '').slice(0, 120) || null,
          order: entry.order++,
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        entry.doneIds.add(block.tool_use_id);
        if (!entry.bashUses.has(block.tool_use_id)) continue;
        const m = BACKGROUND_TASK_RE.exec(toolResultText(block));
        // 最初の対応だけを信じる（同じ taskId が後から出てきても上書きしない）
        if (m && !entry.taskToToolUse.has(m[1])) entry.taskToToolUse.set(m[1], block.tool_use_id);
      }
    }
  }
}

// 実行中／終了済みの Bash 出力の一覧。
// 情報源は <tmpdir>/claude-<uid>/<projectDir>/<claudeSessionId>/tasks/*.output なので
// ファイルを読むだけ＝readonly セッションでも動く。
export async function listShellTasks({
  projectDir,
  claudeSessionId,
  rootDir = SHELL_TASKS_ROOT,
  projectsDir = CLAUDE_PROJECTS_DIR,
} = {}) {
  if (!validTarget(projectDir, claudeSessionId)) return [];

  const dir = shellTasksDir({ projectDir, claudeSessionId, rootDir });
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.output'));
  } catch {
    // Bash を一度も動かしていないセッションではディレクトリ自体が無い
    return [];
  }

  const ctx = await collectBashContext(join(projectsDir, projectDir, `${claudeSessionId}.jsonl`));

  const tasks = [];
  for (const file of files) {
    const taskId = file.slice(0, -'.output'.length);
    if (!TASK_ID_RE.test(taskId)) continue;

    let st;
    try {
      st = statSync(join(dir, file));
    } catch {
      continue;
    }

    const { status, exitCode, preview } = await readTailInfo(join(dir, file), st.size);
    // birthtime は取れないファイルシステムがあるので、その場合は mtime で代用する
    const born = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
    tasks.push({
      taskId,
      status,
      exitCode,
      size: st.size,
      updatedAt: st.mtime.toISOString(),
      startedAt: born.toISOString(),
      background: ctx.taskToToolUse.has(taskId),
      label: null,
      preview,
    });
  }

  assignLabels(tasks, ctx);

  // 実行中を先頭に（その中では新しく始まったものが上）、終了済みは更新の新しい順
  tasks.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
    if (a.status === 'running') return b.startedAt.localeCompare(a.startedAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return tasks;
}

// 「どの Bash コマンドか」のラベルを最善努力で割り当てる。
// バックグラウンドは tool_result に出力先パスが載るので taskId から一意に引ける。
// 一方 **前景の Bash はファイル名と tool_use を結ぶ手がかりが無い**ので、
// 「まだ tool_result が来ていない Bash」を JSONL の出現順に、前景の実行中ファイルを
// 開始時刻の昇順に並べて順番に対応づける。並列実行や取りこぼしでズレ得る点は許容する。
function assignLabels(tasks, ctx) {
  const backgroundToolUseIds = new Set(ctx.taskToToolUse.values());

  const foregroundRunning = [];
  for (const task of tasks) {
    const toolUseId = ctx.taskToToolUse.get(task.taskId);
    if (toolUseId) {
      task.label = ctx.bashUses.get(toolUseId)?.description ?? null;
    } else if (task.status === 'running') {
      foregroundRunning.push(task);
    }
  }
  if (foregroundRunning.length === 0) return;

  const candidates = [...ctx.bashUses.entries()]
    .filter(([id]) => !ctx.doneIds.has(id) && !backgroundToolUseIds.has(id))
    .sort((a, b) => a[1].order - b[1].order);

  foregroundRunning.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // 本数が合わないときは余った側を label: null のままにする
  const pairs = Math.min(foregroundRunning.length, candidates.length);
  for (let i = 0; i < pairs; i++) {
    foregroundRunning[i].label = candidates[i][1].description;
  }
}

// 1 つの Bash 出力の本文。大きいファイルは末尾 maxBytes だけを返す（truncated で知らせる）。
// 読めない（存在しない・taskId が不正）場合は null。
export async function readShellTaskOutput({
  projectDir,
  claudeSessionId,
  taskId,
  rootDir = SHELL_TASKS_ROOT,
  maxBytes = 256 * 1024,
} = {}) {
  if (!validTarget(projectDir, claudeSessionId)) return null;
  // join より前に検証する（../ でディレクトリの外へ出られないように）
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null;

  const filePath = join(shellTasksDir({ projectDir, claudeSessionId, rootDir }), `${taskId}.output`);
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }

  let raw;
  let truncated;
  try {
    ({ text: raw, truncated } = await readTail(filePath, st.size, maxBytes));
  } catch {
    return null;
  }
  if (truncated) raw = dropPartialFirstLine(raw);

  const { body, status, exitCode } = splitExitFooter(stripAnsi(raw));
  return { taskId, status, exitCode, text: body, truncated, size: st.size };
}
