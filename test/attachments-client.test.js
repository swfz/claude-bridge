import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENT_BYTES,
  appendAttachmentLines,
  attachmentLine,
  attachmentUploadUrl,
  formatBytes,
  hasDraggedFiles,
  isImageType,
  precheckAttachment,
  sanitizeAttachmentName,
  shouldAttachPaste,
  submitState,
} from '../client/src/utils/attachments.js';

describe('sanitizeAttachmentName', () => {
  it('drops newlines, control characters and backticks', () => {
    const lineSep = String.fromCharCode(0x2028);
    assert.equal(sanitizeAttachmentName(`a\nb\tc\`d${String.fromCharCode(0x7f)}e${lineSep}.png`), 'abcde.png');
  });

  it('cuts to 100 code points and falls back to "file"', () => {
    assert.equal(Array.from(sanitizeAttachmentName('あ'.repeat(120))).length, 100);
    assert.equal(sanitizeAttachmentName('``'), 'file');
    assert.equal(sanitizeAttachmentName(null), 'file');
  });
});

describe('attachmentLine / appendAttachmentLines', () => {
  const a = { path: '/repo/.claude/bridge-attachments/u1.png', name: 'shot.png' };
  const b = { path: '/repo/.claude/bridge-attachments/u2', name: 'Make`file\n' };

  it('wraps the path in backticks and appends the original name', () => {
    assert.equal(attachmentLine(a), '添付: `/repo/.claude/bridge-attachments/u1.png` (shot.png)');
    assert.equal(attachmentLine(b), '添付: `/repo/.claude/bridge-attachments/u2` (Makefile)');
  });

  it('separates the body and the lines with a blank line', () => {
    assert.equal(
      appendAttachmentLines('  見てください \n', [a, b]),
      '見てください\n\n添付: `/repo/.claude/bridge-attachments/u1.png` (shot.png)\n\n添付: `/repo/.claude/bridge-attachments/u2` (Makefile)',
    );
  });

  it('returns only the lines when the body is empty', () => {
    assert.equal(appendAttachmentLines('', [a]), '添付: `/repo/.claude/bridge-attachments/u1.png` (shot.png)');
    assert.equal(appendAttachmentLines(undefined, [a]), '添付: `/repo/.claude/bridge-attachments/u1.png` (shot.png)');
  });

  it('returns the trimmed body when nothing usable is attached', () => {
    assert.equal(appendAttachmentLines(' hi ', []), 'hi');
    assert.equal(appendAttachmentLines('hi', undefined), 'hi');
    assert.equal(appendAttachmentLines('hi', [{ name: 'x' }, null]), 'hi');
  });
});

describe('submitState', () => {
  const done = { status: 'done', path: '/p' };
  it('blocks while uploading', () => {
    assert.deepEqual(submitState('hi', [done, { status: 'uploading' }]), { ok: false, reason: 'アップロード中です' });
  });

  it('blocks a slash command with attachments', () => {
    const s = submitState(' /commit', [done]);
    assert.equal(s.ok, false);
    assert.match(s.reason, /スラッシュコマンド/);
    assert.equal(submitState('/commit', []).ok, true);
    // 失敗した添付は送られないので邪魔しない
    assert.equal(submitState('/commit', [{ status: 'error' }]).ok, true);
  });

  it('allows an empty body with a ready attachment, not with nothing', () => {
    assert.equal(submitState('', [done]).ok, true);
    assert.deepEqual(submitState('  ', []), { ok: false, reason: '' });
    assert.equal(submitState('', [{ status: 'error' }]).ok, false);
    assert.equal(submitState(undefined, undefined).ok, false);
    assert.equal(submitState('hi', null).ok, true);
  });
});

describe('small helpers', () => {
  it('isImageType', () => {
    assert.equal(isImageType('image/png'), true);
    assert.equal(isImageType('application/pdf'), false);
    assert.equal(isImageType(undefined), false);
  });

  it('hasDraggedFiles', () => {
    assert.equal(hasDraggedFiles(['text/plain', 'Files']), true);
    assert.equal(hasDraggedFiles(['text/uri-list']), false);
    assert.equal(hasDraggedFiles(undefined), false);
  });

  it('shouldAttachPaste takes only file-only pastes', () => {
    assert.equal(shouldAttachPaste(['Files'], 1), true);
    assert.equal(shouldAttachPaste(['Files', 'image/png'], 1), true);
    // Excel / Word のコピーはテキストと描画画像の両方を持つ
    assert.equal(shouldAttachPaste(['text/plain', 'text/html', 'Files'], 1), false);
    assert.equal(shouldAttachPaste(['text/html', 'Files'], 1), false);
    assert.equal(shouldAttachPaste(['text/plain'], 0), false);
    assert.equal(shouldAttachPaste(['Files'], 0), false);
    assert.equal(shouldAttachPaste(undefined, 2), true);
  });

  it('attachmentUploadUrl encodes the query', () => {
    assert.equal(attachmentUploadUrl('abc', 'a b&c.png'), '/attachments?sessionId=abc&name=a+b%26c.png');
    assert.equal(attachmentUploadUrl(undefined, undefined), '/attachments?sessionId=&name=');
  });

  it('precheckAttachment', () => {
    assert.equal(precheckAttachment({ size: 10 }), null);
    assert.equal(precheckAttachment({ size: MAX_ATTACHMENT_BYTES }), null);
    assert.match(precheckAttachment({ size: MAX_ATTACHMENT_BYTES + 1 }), /20MB/);
    assert.equal(precheckAttachment(null), '読み込めません');
  });

  it('formatBytes', () => {
    assert.equal(formatBytes(512), '512B');
    assert.equal(formatBytes(2048), '2.0KB');
    assert.equal(formatBytes(20 * 1024), '20KB');
    assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5MB');
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes(NaN), '');
  });
});
