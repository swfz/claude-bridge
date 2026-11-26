import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { isSensitivePath } from './sensitive-paths.js';
import { sessionJsonlPaths, toRepoRelative } from './session-completion.js';
import { capPatches, git, parseUnifiedDiff, untrackedPatch } from './session-diff.js';
import { buildTurns, resolveCommitHashes, turnPrompt } from './session-turns.js';

// 差分ドロワーの「コミット」「ターン」の範囲。
//   listDiffSources … 選べるコミット（このセッションのコミット。無ければリポジトリの直近 20 件）と、
//                      編集のあったターン（番号は編集の無いターンも含めた通し番号）
//   readCommitDiff  … 1 コミットの差分（git show。マージコミットは 1 つ目の親との差分）
//   readTurnDiff    … 1 ターンで Claude（本体＋サブエージェント）が編集した差分。JSONL の toolUseResult から
//                      組み立てる（~/.claude/file-history はサブエージェントの編集が載らないので使わない）
// Bash（sed・スクリプト）で書き換えたファイルは JSONL に編集として残らないので拾えない。

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10000;
const RECENT_COMMITS = 20;
const PROMPT_MAX = 80;
// 開始・終了の内容を組み立てるファイルの大きさの上限（超えたら編集ごとの差分に倒す）
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
export const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

// JSONL の 1 行が編集の結果（成功した Edit / Write / MultiEdit の toolUseResult）か。parse の前の安価な絞り込み
export function mayBeEditResult(line) {
  return line.includes('"toolUseResult"') && line.includes('"structuredPatch"');
}

function hasErrorResult(record) {
  const content = record.message?.content;
  return Array.isArray(content) && content.some((b) => b?.type === 'tool_result' && b.is_error === true);
}

// user レコード → 編集（{ts, filePath, kind, ...}）か null。full が偽なら中身（originalFile 等）を持たない。
// 形は Claude Code の現行版の実データに合わせる:
//   Write 新規  {type: 'create', filePath, content, originalFile: null, structuredPatch}
//   Write 上書き {type: 'update', filePath, content, originalFile, structuredPatch}
//   Edit        {filePath, oldString, newString, replaceAll, originalFile, structuredPatch}（originalFile は null のことがある）
//   MultiEdit   {filePath, edits: [{old_string, new_string, replace_all}], originalFile, structuredPatch}
export function editFromRecord(record, { full = true } = {}) {
  if (record?.type !== 'user' || hasErrorResult(record)) return null;
  const r = record.toolUseResult;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.filePath !== 'string' || !isAbsolute(r.filePath) || !Array.isArray(r.structuredPatch)) return null;
  let kind;
  if (r.type === 'create') kind = 'create';
  else if (r.type === 'update') kind = 'write';
  else if (typeof r.oldString === 'string' && typeof r.newString === 'string') kind = 'edit';
  else if (Array.isArray(r.edits)) kind = 'multi';
  else return null;
  const edit = { ts: record.timestamp || '', filePath: r.filePath, kind };
  if (!full) return edit;
  return {
    ...edit,
    content: typeof r.content === 'string' ? r.content : null,
    originalFile: typeof r.originalFile === 'string' ? r.originalFile : null,
    oldString: r.oldString,
    newString: r.newString,
    replaceAll: r.replaceAll === true,
    edits: Array.isArray(r.edits) ? r.edits : null,
    structuredPatch: r.structuredPatch,
    // 人が許可のダイアログで中身を書き換えた（oldString / newString と実際の書き込みが違い得る）
    userModified: r.userModified === true,
  };
}

// 行数（末尾の改行は数えない。jsdiff の hunk の行数と同じ数え方）
export function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// structuredPatch が示す行数の増減。hunk が無ければ null（検算できない）
export function patchLineDelta(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  let delta = 0;
  for (const h of structuredPatch) {
    if (!h || !Number.isFinite(h.newLines) || !Number.isFinite(h.oldLines)) return null;
    delta += h.newLines - h.oldLines;
  }
  return delta;
}

// String.prototype.replace は置き換え後の文字列の $& $1 などを展開するので使わない
export function applyEdit(text, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (oldString === '') return text === '' ? newString : null;
  if (replaceAll) return text.includes(oldString) ? text.split(oldString).join(newString) : null;
  const i = text.indexOf(oldString);
  return i < 0 ? null : text.slice(0, i) + newString + text.slice(i + oldString.length);
}

// 1 ファイルの編集（時刻順）を再生して {start, end, created} を作る。開始内容が分からない・
// 途中で合わなくなった（間に Bash や整形が入った）ときは null（編集ごとの差分に倒す）。
// 次の編集の originalFile が無い（最後の編集・originalFile が null）ところは照合できないので、編集ごとに
// 再生前後の行数の増減を structuredPatch の (newLines − oldLines) の合計と突き合わせる。
// 人が許可のダイアログで書き換えた編集（userModified）は記録と実際の書き込みがずれ得るので再生しない
export function replayEdits(edits) {
  const first = edits[0];
  let start;
  if (first.kind === 'create') start = '';
  else if (typeof first.originalFile === 'string') start = first.originalFile;
  else return null;
  let cur = start;
  for (const e of edits) {
    if (cur.length > MAX_REPLAY_BYTES) return null;
    // 編集の直前の内容が記録されていれば、ここまでの再生と同じか確かめる（違えば間に別の書き換えがある）
    if (typeof e.originalFile === 'string' && e.originalFile !== cur) return null;
    if (e.kind === 'create' && cur !== '' && e !== first) return null;
    if (e.userModified) return null;
    const before = cur;
    if (e.kind === 'create' || e.kind === 'write') {
      if (typeof e.content !== 'string') return null;
      cur = e.content;
    } else if (e.kind === 'edit') {
      cur = applyEdit(cur, e.oldString, e.newString, e.replaceAll);
    } else {
      for (const sub of e.edits || []) {
        if (cur == null) break;
        cur = applyEdit(cur, sub?.old_string, sub?.new_string, sub?.replace_all === true);
      }
    }
    if (cur == null) return null;
    const delta = patchLineDelta(e.structuredPatch);
    if (delta != null && lineCount(cur) - lineCount(before) !== delta) return null;
  }
  if (cur.length > MAX_REPLAY_BYTES) return null;
  return { start, end: cur, created: first.kind === 'create' };
}

function fileHeader(rel, created) {
  return created
    ? `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`
    : `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n`;
}

// 編集ごとの structuredPatch を時刻順に並べた patch。hunk の行番号は「その編集の時点」のもの。
// hunk 見出しの後ろに「編集 k/n」を添える（@@ … @@ の後ろは関数名などの自由な文字列）
export function perEditPatch(rel, edits) {
  const created = edits[0]?.kind === 'create';
  let body = '';
  edits.forEach((e, k) => {
    const tag = ` 編集 ${k + 1}/${edits.length}`;
    let hunks = e.structuredPatch || [];
    // 新規作成は structuredPatch が空なので中身から作る
    if (hunks.length === 0 && e.kind === 'create' && typeof e.content === 'string' && e.content !== '') {
      const lines = e.content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
    }
    for (const h of hunks) {
      if (!h || !Array.isArray(h.lines)) continue;
      body += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${tag}\n${h.lines.join('\n')}\n`;
    }
  });
  return fileHeader(rel, created) + body;
}

// git diff --no-index は差分があると exit 1 で終わる（execFile は reject する）。1 は成功として扱う
async function gitNoIndex(dir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', 'a', 'b'],
      { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch (e) {
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
    throw e;
  }
}

// 開始・終了の内容から patch を作る。ヘッダは一時ファイルのパスを置き換えず、最初の @@ 以降だけ使って組み直す
export async function contentPatch(rel, start, end, dir) {
  await writeFile(join(dir, 'a'), start, { mode: 0o600 });
  await writeFile(join(dir, 'b'), end, { mode: 0o600 });
  const out = await gitNoIndex(dir);
  const at = out.search(/^@@/m);
  return at < 0 ? '' : fileHeader(rel, false) + out.slice(at);
}

// ── JSONL の走査 ─────────────────────────────────────

async function* readLines(path) {
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

// 本体の JSONL を 1 回読み、ターン（session-turns.js の buildTurns と同じ区切り）と編集を集める。
// keepEdit(turnIndex) が真のターンの編集だけ中身ごと持ち、それ以外は数えるだけ（ファイルの集合）
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// buildTurns（ターンの区切り・コミットの件名・PR・トークン・所要時間）に要る部分だけのレコード。要らなければ null。
// 指示のレコードはそのまま（turnPrompt が本文を読む）、tool_result は id と失敗だけ、assistant は usage と
// Bash・編集のツール呼び出しの入力だけを残す
export function slimRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'user') {
    if (turnPrompt(record)) {
      const { toolUseResult: _drop, ...rest } = record;
      return rest;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) return null;
    const results = content
      .filter((b) => b?.type === 'tool_result')
      .map((b) => ({ type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error }));
    return results.length > 0 ? { type: 'user', timestamp: record.timestamp, message: { content: results } } : null;
  }
  if (record.type === 'assistant') {
    const m = record.message || {};
    const content = Array.isArray(m.content)
      ? m.content
          .filter((b) => b?.type === 'tool_use' && (b.name === 'Bash' || EDIT_TOOLS.has(b.name)))
          .map((b) => ({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input:
              b.name === 'Bash'
                ? { command: b.input?.command }
                : { file_path: b.input?.file_path, notebook_path: b.input?.notebook_path },
          }))
      : [];
    return {
      type: 'assistant',
      timestamp: record.timestamp,
      message: { id: m.id, model: m.model, usage: m.usage, content },
    };
  }
  if (record.type === 'system' && record.subtype === 'turn_duration') return record;
  if (record.type === 'pr-link') return record;
  return null;
}

async function scanMain(filePath, keepEdit) {
  const records = [];
  const editedByTurn = new Map(); // turnIndex(1 始まり) -> Set<filePath>
  const kept = [];
  let turnIndex = 0;
  let seq = 0;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (turnPrompt(record)) turnIndex++;
    if (turnIndex > 0 && mayBeEditResult(line)) {
      const keep = keepEdit(turnIndex);
      const edit = editFromRecord(record, { full: keep });
      if (edit) {
        if (!editedByTurn.has(turnIndex)) editedByTurn.set(turnIndex, new Set());
        editedByTurn.get(turnIndex).add(edit.filePath);
        if (keep) kept.push({ ...edit, seq: seq++ });
      }
    }
    // buildTurns に要る部分だけを残す（JSONL は数十 MB になり得るので全レコードを抱えない）
    const slim = slimRecord(record);
    if (slim) records.push(slim);
  }
  return { turns: buildTurns(records), editedByTurn, kept, seq };
}

// サブエージェントの編集。ターンへは timestamp で割り当てる（[ターン開始, 次のターン開始)）
async function scanSubagent(path, onEdit, full) {
  for await (const line of readLines(path)) {
    if (!mayBeEditResult(line)) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const edit = editFromRecord(record, { full });
    if (edit) onEdit(edit);
  }
}

// ターンの開始時刻（ms）から、時刻 ts の属するターン番号（1 始まり）。最初のターンより前は 0
export function turnIndexAt(starts, ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  let idx = 0;
  for (let i = 0; i < starts.length; i++) {
    if (Number.isFinite(starts[i]) && starts[i] <= t) idx = i + 1;
  }
  return idx;
}

// keepIndex: 中身ごと持つターンの番号（null なら数えるだけ。一覧の取得では Edit の中身を保持しない）
async function scanSession(filePath, keepIndex = null) {
  const keepEdit = (i) => keepIndex != null && i === keepIndex;
  const paths = await sessionJsonlPaths(filePath);
  const main = await scanMain(filePath, keepEdit);
  const starts = main.turns.map((t) => Date.parse(t.startedAt));
  let seq = main.seq;
  for (const path of paths.slice(1)) {
    await scanSubagent(
      path,
      (edit) => {
        const idx = turnIndexAt(starts, edit.ts);
        if (idx === 0) return;
        if (!main.editedByTurn.has(idx)) main.editedByTurn.set(idx, new Set());
        main.editedByTurn.get(idx).add(edit.filePath);
        if (keepEdit(idx)) main.kept.push({ ...edit, seq: seq++ });
      },
      keepIndex != null,
    );
  }
  return main;
}

async function recentCommits(cwd) {
  if (!cwd) return [];
  try {
    const { stdout } = await git(['log', '-n', String(RECENT_COMMITS), '--format=%h%x09%s'], cwd);
    return stdout
      .split('\n')
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab > 0 ? { hash: line.slice(0, tab), subject: line.slice(tab + 1), turnIndex: null } : null;
      })
      .filter((c) => c && COMMIT_HASH_RE.test(c.hash));
  } catch {
    return [];
  }
}

// 同じセッションの一覧を ‹ › で送るたびに JSONL 全文と git log を読み直さないよう、ファイルの mtime と大きさで覚える
const sourcesCache = new Map();
const SOURCES_CACHE_MAX = 20;

async function signatureOf(filePath, cwd) {
  const paths = await sessionJsonlPaths(filePath);
  const parts = await Promise.all(
    paths.map((p) =>
      stat(p).then(
        (s) => `${p}:${s.mtimeMs}:${s.size}`,
        () => `${p}:-`,
      ),
    ),
  );
  // HEAD も入れる（ターミナルでコミットしても JSONL は変わらないので、ファイルだけ見ていると直近 20 件や
  // 件名で引いたハッシュが古いまま返る。「取り直す」でも新しいコミットが出ない）
  const head = cwd
    ? await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).then(
        ({ stdout }) => stdout.trim(),
        () => '-',
      )
    : '-';
  return `${cwd || ''}\n${head}\n${parts.join('\n')}`;
}

// コミットはこのセッションのもの（ハッシュの引けたもの）を新しい順に。0 件ならリポジトリの直近 20 件（recent: true）。
// ターンは編集のあったものだけを新しい順に（fileCount は本体＋サブエージェントが編集したファイル数）
export async function listDiffSources({ filePath, cwd }) {
  const signature = await signatureOf(filePath, cwd);
  const hit = sourcesCache.get(filePath);
  if (hit && hit.signature === signature) return hit.promise;
  const promise = (async () => {
    const { turns, editedByTurn } = await scanSession(filePath);
    await resolveCommitHashes(turns, cwd);
    let commits = [];
    const seen = new Set();
    for (let i = turns.length - 1; i >= 0; i--) {
      for (const c of [...turns[i].commits].reverse()) {
        if (!c.hash || seen.has(c.hash)) continue;
        seen.add(c.hash);
        commits.push({ hash: c.hash, subject: c.subject, turnIndex: i + 1 });
      }
    }
    let recent = false;
    if (commits.length === 0) {
      commits = await recentCommits(cwd);
      recent = commits.length > 0;
    }
    const list = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const fileCount = editedByTurn.get(i + 1)?.size || 0;
      if (fileCount === 0) continue;
      list.push({
        index: i + 1,
        startedAt: turns[i].startedAt,
        prompt: turns[i].prompt.slice(0, PROMPT_MAX),
        fileCount,
      });
    }
    return { commits, recent, turns: list };
  })();
  if (sourcesCache.size >= SOURCES_CACHE_MAX) sourcesCache.clear();
  sourcesCache.set(filePath, { signature, promise });
  // 失敗したら覚えない。後から入った同じ filePath のエントリ（別の Promise）は消さない
  promise.catch(() => {
    if (sourcesCache.get(filePath)?.promise === promise) sourcesCache.delete(filePath);
  });
  return promise;
}

export function clearDiffSourcesCache() {
  sourcesCache.clear();
}

async function repoOf(cwd) {
  if (!cwd) return null;
  try {
    const [{ stdout }, realCwd] = await Promise.all([git(['rev-parse', '--show-toplevel'], cwd), realpath(cwd)]);
    return { root: stdout.trim(), realCwd };
  } catch {
    return null;
  }
}

// 1 コミットの差分。hash は呼び出し側で一覧（listDiffSources）に含まれることを確かめておく。
// マージコミットは git show の既定（combined diff）だと parseUnifiedDiff が読めないので、
// --diff-merges=first-parent で 1 つ目の親との差分を出す（root コミットも git show ならそのまま読める）
export async function readCommitDiff({ cwd, hash }) {
  if (typeof hash !== 'string' || !COMMIT_HASH_RE.test(hash)) throw new Error('コミットの指定が正しくありません');
  const repo = await repoOf(cwd);
  if (!repo) throw new Error('git リポジトリではないか、作業ディレクトリが削除されています');
  let text;
  let parents;
  try {
    const [{ stdout: show }, { stdout: revs }] = await Promise.all([
      git(
        [
          'show',
          '--format=',
          '--patch',
          '--no-color',
          '--no-ext-diff',
          '--find-renames',
          '--diff-merges=first-parent',
          hash,
          '--',
        ],
        repo.root,
      ),
      git(['rev-list', '--parents', '-n', '1', hash, '--'], repo.root),
    ]);
    text = show;
    parents = revs.trim().split(/\s+/).length - 1;
  } catch (e) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('差分が大きすぎて表示できません', { cause: e });
    throw new Error('コミットの差分を読めませんでした', { cause: e });
  }
  // 資格情報の置き場（.env など）は中身を出さない。直近 20 件に倒れたときはセッションと無関係なコミットも
  // 読めるので、作業ツリーの未追跡ファイルと同じ見せ方にする
  const files = parseUnifiedDiff(text)
    .map((f) =>
      [f.path, f.oldPath].some((p) => p && isSensitivePath(join(repo.root, p)))
        ? { ...f, patch: '', additions: 0, deletions: 0, sensitive: true }
        : f,
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const capped = capPatches(files);
  return { root: repo.root, files: capped.files, truncated: capped.truncated, outside: 0, merge: parents > 1 };
}

// ‹ › で行き来するたびに JSONL を全文走査しないよう、ターンの差分を JSONL（本体・サブエージェント）の
// mtime・大きさと HEAD で覚える（作業中のセッションは JSONL が伸び続けるので効かないが、それは許容する）
const turnDiffCache = new Map();
const TURN_DIFF_CACHE_MAX = 10;

export function clearTurnDiffCache() {
  turnDiffCache.clear();
}

// 1 ターンの差分。index はターン番号（1 始まり。listDiffSources の turns[].index）
export async function readTurnDiff({ filePath, cwd, index }) {
  if (!Number.isInteger(index) || index < 1) throw new Error('ターンの指定が正しくありません');
  const key = `${filePath}\n${index}`;
  const signature = await signatureOf(filePath, cwd);
  const hit = turnDiffCache.get(key);
  if (hit && hit.signature === signature) return hit.promise;
  const promise = buildTurnDiff({ filePath, cwd, index });
  turnDiffCache.delete(key);
  if (turnDiffCache.size >= TURN_DIFF_CACHE_MAX) turnDiffCache.delete(turnDiffCache.keys().next().value);
  turnDiffCache.set(key, { signature, promise });
  promise.catch(() => {
    if (turnDiffCache.get(key)?.promise === promise) turnDiffCache.delete(key);
  });
  return promise;
}

async function buildTurnDiff({ filePath, cwd, index }) {
  const { turns, kept } = await scanSession(filePath, index);
  if (index > turns.length) throw new Error('ターンが見つかりません');

  const repo = await repoOf(cwd);
  const root = repo?.root || cwd || '/';
  const realCwd = repo?.realCwd || cwd;

  const byFile = new Map();
  for (const e of kept) {
    if (!byFile.has(e.filePath)) byFile.set(e.filePath, []);
    byFile.get(e.filePath).push(e);
  }
  const files = [];
  let outside = 0;
  let dir = null;
  try {
    for (const [abs, list] of byFile) {
      const rel = toRepoRelative(abs, { cwd, realCwd, root });
      if (!rel) {
        outside++;
        continue;
      }
      const base = { path: rel, binary: false, additions: 0, deletions: 0, patch: '' };
      if (isSensitivePath(abs)) {
        files.push({ ...base, status: 'modified', sensitive: true });
        continue;
      }
      list.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.seq - b.seq);
      const replay = replayEdits(list);
      if (replay) {
        if (replay.start === replay.end) {
          files.push({ ...base, status: 'unchanged' });
          continue;
        }
        if (replay.end.includes('\0') || replay.start.includes('\0')) {
          files.push({ ...base, status: replay.created ? 'added' : 'modified', binary: true });
          continue;
        }
        let patch;
        if (replay.created) {
          patch = untrackedPatch(rel, replay.end).patch;
        } else {
          dir ||= await mkdtemp(join(tmpdir(), 'claude-bridge-diff-'));
          patch = await contentPatch(rel, replay.start, replay.end, dir);
        }
        const parsed = parseUnifiedDiff(patch)[0];
        files.push({
          ...base,
          status: replay.created ? 'added' : 'modified',
          additions: parsed?.additions || 0,
          deletions: parsed?.deletions || 0,
          patch,
        });
        continue;
      }
      // 開始内容が分からない・再生できない: 編集ごとの差分（まとめられない）
      const patch = perEditPatch(rel, list);
      const parsed = parseUnifiedDiff(patch)[0];
      files.push({
        ...base,
        status: list[0].kind === 'create' ? 'added' : 'modified',
        additions: parsed?.additions || 0,
        deletions: parsed?.deletions || 0,
        patch,
        perEdit: true,
        editCount: list.length,
      });
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const capped = capPatches(files);
  const turn = turns[index - 1];
  return {
    root,
    files: capped.files,
    truncated: capped.truncated,
    outside,
    turn: { index, startedAt: turn.startedAt, prompt: turn.prompt.slice(0, PROMPT_MAX) },
  };
}
