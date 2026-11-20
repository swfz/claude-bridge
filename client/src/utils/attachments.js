// 入力欄の添付ファイルまわりの純粋関数（InputBar から使う）。
// 添付はサーバーに保存し（POST /attachments）、返ってきたパスを本文の末尾に足して既存の送信経路に流す。

// サーバーの MAX_ATTACHMENT_BYTES と同じ。超えるものは送る前に弾く
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const NAME_MAX = 100;

// 本文の行に埋める元の名前。改行・制御文字・バッククォートを落として 100 文字（コードポイント）に切る
// （インラインコードや 1 ファイル 1 行の形を壊さないため）
export function sanitizeAttachmentName(name) {
  const cleaned = Array.from(
    String(name || '')
      .replace(/[\p{Cc}\p{Zl}\p{Zp}`]/gu, '')
      .trim(),
  )
    .slice(0, NAME_MAX)
    .join('')
    .trim();
  return cleaned || 'file';
}

// 1 ファイル 1 行。パスはバッククォートで囲む（チャットの MdCode がインラインコードのパスをピルにする）
export function attachmentLine({ path, name }) {
  return `添付: \`${path}\` (${sanitizeAttachmentName(name)})`;
}

// 本文の末尾に空行を挟んで添付行を足す。本文が空なら添付行だけ。
// 添付行どうしも空行で区切る（チャットは Markdown で描くので、改行 1 つだと 1 段落につながって読みにくい）
export function appendAttachmentLines(text, attachments) {
  const body = (text || '').trim();
  const lines = (attachments || []).filter((a) => a && a.path).map(attachmentLine);
  if (lines.length === 0) return body;
  return body ? `${body}\n\n${lines.join('\n\n')}` : lines.join('\n\n');
}

// 送信できるか。{ok, reason}。reason は送信ボタンの title に出す
export function submitState(text, attachments = []) {
  const body = (text || '').trim();
  const list = attachments || [];
  if (list.some((a) => a.status === 'uploading')) return { ok: false, reason: 'アップロード中です' };
  const ready = list.filter((a) => a.status === 'done');
  if (ready.length > 0 && body.startsWith('/')) {
    return { ok: false, reason: 'スラッシュコマンドには添付を付けて送れません。添付を外してください' };
  }
  if (!body && ready.length === 0) return { ok: false, reason: '' };
  return { ok: true, reason: '' };
}

export function isImageType(type) {
  return typeof type === 'string' && type.startsWith('image/');
}

// ドラッグ中のものがファイルか（テキストやリンクのドラッグには反応しない）
export function hasDraggedFiles(types) {
  return Array.from(types || []).includes('Files');
}

// 貼り付けを添付として横取りするか。Excel / Word などからテキストをコピーすると、
// 描画した画像（image/png）も files に入る。テキストがあるときは通常の貼り付けに任せる
export function shouldAttachPaste(types, fileCount) {
  if (!fileCount) return false;
  const list = Array.from(types || []);
  return !list.includes('text/plain') && !list.includes('text/html');
}

export function attachmentUploadUrl(sessionId, name) {
  const params = new URLSearchParams({ sessionId: sessionId || '', name: name || '' });
  return `/attachments?${params}`;
}

// アップロード前の検査。問題があればエラー文、無ければ null
export function precheckAttachment(file) {
  if (!file) return '読み込めません';
  if (file.size > MAX_ATTACHMENT_BYTES) return `20MB を超えるファイルは添付できません（${formatBytes(file.size)}）`;
  return null;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
