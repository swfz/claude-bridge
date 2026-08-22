import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// storage.js は import 時に DATA_DIR を確定するため、import 前に環境変数を設定する
const TMP = mkdtempSync(join(tmpdir(), 'bridge-inbox-'));
process.env.CLAUDE_BRIDGE_DIR = TMP;

const { Storage } = await import('../server/storage.js');

describe('Storage.appendInbox', () => {
  let storage;
  before(() => {
    storage = new Storage();
  });
  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('appends one JSONL line per message', () => {
    storage.appendInbox('sess1', { text: 'hello', id: 'm1', ts: 't1' });
    storage.appendInbox('sess1', { text: 'world', id: 'm2', ts: 't2' });

    const file = join(TMP, 'inbox', 'sess1.jsonl');
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { id: 'm1', text: 'hello', ts: 't1' });
    assert.deepEqual(JSON.parse(lines[1]), { id: 'm2', text: 'world', ts: 't2' });
  });

  it('fills missing id/ts and defaults text', () => {
    storage.appendInbox('sess2', {});
    const file = join(TMP, 'inbox', 'sess2.jsonl');
    const obj = JSON.parse(readFileSync(file, 'utf-8').trim());
    assert.equal(obj.text, '');
    assert.ok(obj.id);
    assert.ok(obj.ts);
  });

  it('rejects sessionId with path traversal / unsafe chars', () => {
    assert.throws(() => storage.appendInbox('../etc/passwd', { text: 'x' }));
    assert.throws(() => storage.appendInbox('a/b', { text: 'x' }));
    assert.throws(() => storage.appendInbox('', { text: 'x' }));
    assert.throws(() => storage.appendInbox(undefined, { text: 'x' }));
  });
});
