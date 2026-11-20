import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  attachmentExt,
  checkUploadRequest,
  prepareAttachmentDir,
  readCwdByPid,
  resolveAttachmentCwd,
  sanitizeAttachmentName,
  saveAttachment,
} from '../server/attachments.js';

const okHeaders = (extra = {}) => ({
  'x-bridge-upload': '1',
  'content-type': 'application/octet-stream',
  host: 'localhost:3000',
  ...extra,
});

describe('checkUploadRequest', () => {
  it('accepts the custom header with octet-stream and no origin', () => {
    assert.equal(checkUploadRequest(okHeaders()), null);
  });

  it('accepts a same-host origin regardless of the host name', () => {
    assert.equal(checkUploadRequest(okHeaders({ origin: 'http://localhost:3000' })), null);
    assert.equal(checkUploadRequest(okHeaders({ host: 'mybox:3000', origin: 'http://mybox:3000' })), null);
  });

  it('rejects without the custom header', () => {
    assert.deepEqual(checkUploadRequest({ 'content-type': 'application/octet-stream' }).status, 403);
    assert.equal(checkUploadRequest(okHeaders({ 'x-bridge-upload': '0' })).status, 403);
    assert.equal(checkUploadRequest().status, 403);
  });

  it('rejects other content types with 415 (parameters are ignored)', () => {
    assert.equal(checkUploadRequest(okHeaders({ 'content-type': 'text/plain' })).status, 415);
    assert.equal(checkUploadRequest(okHeaders({ 'content-type': undefined })).status, 415);
    assert.equal(checkUploadRequest(okHeaders({ 'content-type': 'Application/Octet-Stream; x=1' })), null);
  });

  it('rejects a cross-origin or broken origin', () => {
    assert.equal(checkUploadRequest(okHeaders({ origin: 'http://evil.example' })).status, 403);
    assert.equal(checkUploadRequest(okHeaders({ origin: 'http://localhost:5173' })).status, 403);
    assert.equal(checkUploadRequest(okHeaders({ origin: 'null' })).status, 403);
  });
});

describe('attachmentExt', () => {
  it('lowercases a short alphanumeric extension', () => {
    assert.equal(attachmentExt('Screen Shot.PNG'), '.png');
    assert.equal(attachmentExt('a.tar.gz'), '.gz');
    assert.equal(attachmentExt('x.abcdefghij'), '.abcdefghij');
  });

  it('drops missing or unsafe extensions', () => {
    assert.equal(attachmentExt('Makefile'), '');
    assert.equal(attachmentExt('x.abcdefghijk'), '');
    assert.equal(attachmentExt('x.p-g'), '');
    assert.equal(attachmentExt('x.日本'), '');
    assert.equal(attachmentExt(undefined), '');
    assert.equal(attachmentExt('.bashrc'), '');
  });
});

describe('sanitizeAttachmentName', () => {
  it('removes newlines, control chars and backticks', () => {
    assert.equal(sanitizeAttachmentName('a\nb\r\tc`d\u0000e\u2028.png'), 'abcde.png');
  });

  it('cuts to 100 characters by code point', () => {
    const name = '😀'.repeat(150);
    assert.equal(Array.from(sanitizeAttachmentName(name)).length, 100);
  });

  it('falls back to "file" when nothing is left', () => {
    assert.equal(sanitizeAttachmentName('``\n'), 'file');
    assert.equal(sanitizeAttachmentName(undefined), 'file');
  });
});

describe('readCwdByPid / resolveAttachmentCwd', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attach-meta-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an absolute cwd from the status file', async () => {
    await writeFile(join(dir, '123.json'), JSON.stringify({ cwd: '/repo/.claude/worktrees/x' }));
    await writeFile(join(dir, '124.json'), JSON.stringify({ cwd: 'relative' }));
    await writeFile(join(dir, '125.json'), '{broken');
    assert.equal(await readCwdByPid(123, { dir }), '/repo/.claude/worktrees/x');
    assert.equal(await readCwdByPid(124, { dir }), null);
    assert.equal(await readCwdByPid(125, { dir }), null);
    assert.equal(await readCwdByPid(999, { dir }), null);
    assert.equal(await readCwdByPid(null, { dir }), null);
  });

  it('prefers the status file cwd', async () => {
    const cwd = await resolveAttachmentCwd({
      claudePid: 1,
      jsonlPath: '/p.jsonl',
      sessionCwd: '/start',
      readPidCwd: async () => '/moved',
      readSummaryCwd: async () => '/summary',
    });
    assert.equal(cwd, '/moved');
  });

  it('falls back to the JSONL summary, then the session cwd', async () => {
    let read = null;
    const fromSummary = await resolveAttachmentCwd({
      claudePid: null,
      jsonlPath: '/p.jsonl',
      sessionCwd: '/start',
      readPidCwd: async () => null,
      readSummaryCwd: async (p) => {
        read = p;
        return '/summary';
      },
    });
    assert.equal(fromSummary, '/summary');
    assert.equal(read, '/p.jsonl');

    const fromSession = await resolveAttachmentCwd({
      jsonlPath: '/p.jsonl',
      sessionCwd: '/start',
      readPidCwd: async () => null,
      readSummaryCwd: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(fromSession, '/start');

    const noJsonl = await resolveAttachmentCwd({ sessionCwd: '/start', readPidCwd: async () => null });
    assert.equal(noJsonl, '/start');

    const relativeSummary = await resolveAttachmentCwd({
      jsonlPath: '/p.jsonl',
      sessionCwd: 'nope',
      readPidCwd: async () => null,
      readSummaryCwd: async () => 'rel',
    });
    assert.equal(relativeSummary, null);
  });

  it('uses the real status file reader by default', async () => {
    // 既定の SESSIONS_DIR に存在しない pid → session の cwd へ落ちる
    assert.equal(await resolveAttachmentCwd({ claudePid: 2 ** 31, sessionCwd: '/start' }), '/start');
  });
});

describe('prepareAttachmentDir / saveAttachment', () => {
  let cwd;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'attach-cwd-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates the dirs (0700) and a catch-all .gitignore (0600)', async () => {
    const dir = await prepareAttachmentDir(cwd);
    assert.equal(dir, join(cwd, '.claude', 'bridge-attachments'));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n');
    assert.equal((await stat(join(dir, '.gitignore'))).mode & 0o777, 0o600);
  });

  it('keeps an existing .gitignore and an existing .claude dir', async () => {
    await mkdir(join(cwd, '.claude', 'bridge-attachments'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'bridge-attachments', '.gitignore'), 'custom\n');
    const dir = await prepareAttachmentDir(cwd);
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'custom\n');
  });

  it('rejects a missing cwd, a file cwd, or an unresolved cwd with 400', async () => {
    await assert.rejects(
      prepareAttachmentDir(join(cwd, 'nope')),
      (e) => e instanceof AttachmentError && e.status === 400,
    );
    await writeFile(join(cwd, 'f'), 'x');
    await assert.rejects(prepareAttachmentDir(join(cwd, 'f')), (e) => e.status === 400);
    await assert.rejects(prepareAttachmentDir(null), (e) => e.status === 400);
    await assert.rejects(prepareAttachmentDir('relative'), (e) => e.status === 400);
  });

  it('rejects symlinked .claude or bridge-attachments', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'attach-outside-'));
    try {
      await symlink(outside, join(cwd, '.claude'));
      await assert.rejects(prepareAttachmentDir(cwd), (e) => e.status === 400 && /symlink/.test(e.message));
      await rm(join(cwd, '.claude'));
      await mkdir(join(cwd, '.claude'));
      await symlink(outside, join(cwd, '.claude', 'bridge-attachments'));
      await assert.rejects(prepareAttachmentDir(cwd), (e) => e.status === 400 && /symlink/.test(e.message));
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a non-directory .claude', async () => {
    await writeFile(join(cwd, '.claude'), 'x');
    await assert.rejects(prepareAttachmentDir(cwd), (e) => e.status === 400 && /not a directory/.test(e.message));
  });

  it('saves the bytes under a uuid name with the extension (0600)', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await saveAttachment({ cwd, name: 'Shot\n`x`.PNG', data });
    assert.match(result.path, /\/\.claude\/bridge-attachments\/[0-9a-f-]{36}\.png$/);
    assert.equal(result.name, 'Shotx.PNG');
    assert.equal(result.size, 4);
    assert.deepEqual(await readFile(result.path), data);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  });

  it('saves an empty file and a file without extension', async () => {
    const result = await saveAttachment({ cwd, name: 'Makefile', data: Buffer.alloc(0) });
    assert.match(result.path, /\/[0-9a-f-]{36}$/);
    assert.equal(result.size, 0);
  });

  it('rejects a non-buffer body (400) and an oversized body (413)', async () => {
    await assert.rejects(saveAttachment({ cwd, name: 'a', data: {} }), (e) => e.status === 400);
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    await assert.rejects(saveAttachment({ cwd, name: 'a', data: big }), (e) => e.status === 413);
  });

  it('handles concurrent uploads into a fresh cwd', async () => {
    const results = await Promise.all(
      ['a.png', 'b.zip', 'c'].map((name) => saveAttachment({ cwd, name, data: Buffer.from(name) })),
    );
    assert.equal(new Set(results.map((r) => r.path)).size, 3);
    const names = await readdir(join(cwd, '.claude', 'bridge-attachments'));
    assert.equal(names.length, 4);
  });

  it('keeps earlier attachments (no automatic cleanup)', async () => {
    const dir = await prepareAttachmentDir(cwd);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await writeFile(join(dir, 'old.png'), 'x');
    await utimes(join(dir, 'old.png'), old, old);
    const result = await saveAttachment({ cwd, name: 'n.txt', data: Buffer.from('hi') });
    const names = await readdir(dir);
    assert.deepEqual(names.sort(), ['.gitignore', 'old.png', result.path.split('/').pop()].sort());
  });
});
