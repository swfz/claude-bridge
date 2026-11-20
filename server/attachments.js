// 入力欄から添付したファイルの保存。
// ブラウザから POST /attachments で受けたバイト列を <cwd>/.claude/bridge-attachments/<uuid>.<拡張子> に書き、
// クライアントはそのパスを本文に足して既存の送信経路（input / send_to_agent）に流す。Claude は Read で読む。
// 添付は自動では消さない（後から会話を遡ったときに読めるように）。不要になったら置き場を手で消す。
// index.js はテストの母数外なので、判定・保存はここに寄せ、index.js は配線だけにする。
import { lstat, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { extname, isAbsolute, join } from 'path';
import { SESSIONS_DIR } from './claude-session-meta.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_HEADER = 'x-bridge-upload';
const ATTACHMENT_DIR_PARTS = ['.claude', 'bridge-attachments'];
const GITIGNORE = '.gitignore';
const NAME_MAX = 100;

// HTTP の状態コードを持つエラー。index.js はこれを見て応答を組み立てる
export class AttachmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// CSRF 対策。別オリジンのページからの form 送信・単純リクエストを弾く:
// 独自ヘッダはプリフライト無しでは付けられず、application/octet-stream も単純リクエストの型ではない。
// Origin は固定値で照合しない（server.listen はホスト未指定で、localhost 以外の名前でも来る）。
// 問題なければ null、あれば {status, error}
export function checkUploadRequest(headers = {}) {
  if (headers[UPLOAD_HEADER] !== '1') return { status: 403, error: 'missing upload header' };
  const type = String(headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/octet-stream')
    return { status: 415, error: 'content-type must be application/octet-stream' };
  const origin = headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // "null"（サンドボックスの iframe 等）や壊れた値
    }
    if (!host || host !== headers.host) return { status: 403, error: 'origin mismatch' };
  }
  return null;
}

// 元の名前から保存用の拡張子を取る。英数字 1〜10 文字だけ許し、それ以外は拡張子なし
export function attachmentExt(name) {
  const ext = extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// 応答に載せる元の名前。改行・制御文字・バッククォートを落として 100 文字に切る
// （クライアントはこれを本文の行に埋めるので、行やインラインコードを壊さないようにする）
export function sanitizeAttachmentName(name) {
  const cleaned = Array.from(
    String(name || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, '')
      .trim(),
  )
    .slice(0, NAME_MAX)
    .join('')
    .trim();
  return cleaned || 'file';
}

// claude のステータスファイル（<pid>.json）の cwd。`claude -w` や EnterWorktree で worktree に移ったあとの
// cwd はここにしか書かれない（ブリッジのセッションの cwd は起動時の値のまま）
export async function readCwdByPid(pid, { dir = SESSIONS_DIR } = {}) {
  if (pid == null) return null;
  try {
    const o = JSON.parse(await readFile(join(dir, `${pid}.json`), 'utf8'));
    return typeof o.cwd === 'string' && isAbsolute(o.cwd) ? o.cwd : null;
  } catch {
    return null;
  }
}

// 保存先の cwd を決める。クライアントからは受け取らず、次の順で最初に取れたものを使う:
// (1) claudePid のステータスファイルの cwd、(2) JSONL のサマリの cwd、(3) セッションの cwd
export async function resolveAttachmentCwd({
  claudePid,
  jsonlPath,
  sessionCwd,
  readPidCwd = readCwdByPid,
  readSummaryCwd,
}) {
  const fromPid = await readPidCwd(claudePid);
  if (fromPid) return fromPid;
  if (jsonlPath && readSummaryCwd) {
    try {
      const cwd = await readSummaryCwd(jsonlPath);
      if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
    } catch {
      // 読めなければ次へ
    }
  }
  return typeof sessionCwd === 'string' && isAbsolute(sessionCwd) ? sessionCwd : null;
}

// ディレクトリを用意する。リポジトリが仕込んだシンボリックリンク経由で外へ書かないよう、
// .claude と bridge-attachments のどちらもリンクなら拒否する。無ければ 0700 で作る。
// 先に mkdir してから既存のものを lstat で確かめる（複数ファイルを同時に送ると、
// 「無いのを確かめてから作る」順では別のリクエストが先に作って EEXIST になるため）。
// mkdir はシンボリックリンクがあっても辿らず EEXIST になるので、リンクはここで拒否できる
async function ensureRealDir(path) {
  try {
    await mkdir(path, { mode: 0o700 });
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new AttachmentError(400, `symlink not allowed: ${path}`);
  if (!st.isDirectory()) throw new AttachmentError(400, `not a directory: ${path}`);
}

export async function prepareAttachmentDir(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new AttachmentError(400, 'cwd not resolved');
  let st;
  try {
    st = await stat(cwd);
  } catch {
    throw new AttachmentError(400, `cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) throw new AttachmentError(400, `cwd is not a directory: ${cwd}`);
  let dir = cwd;
  for (const part of ATTACHMENT_DIR_PARTS) {
    dir = join(dir, part);
    await ensureRealDir(dir);
  }
  // リポジトリ直下の .gitignore には触らず、置き場の中に「全部無視」を置く。既にあれば何もしない
  try {
    await writeFile(join(dir, GITIGNORE), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return dir;
}

// 1 ファイルを保存して {path, name, size} を返す
export async function saveAttachment({ cwd, name, data }) {
  if (!Buffer.isBuffer(data)) throw new AttachmentError(400, 'body must be application/octet-stream');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, 'file too large');
  const dir = await prepareAttachmentDir(cwd);
  const path = join(dir, `${randomUUID()}${attachmentExt(name)}`);
  await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  return { path, name: sanitizeAttachmentName(name), size: data.length };
}
