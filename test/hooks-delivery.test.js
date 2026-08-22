import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks');
const CHECK = join(HOOKS, 'bridge-check-inbox.js');

function seedInbox(base, sid, texts) {
  const dir = join(base, 'inbox');
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((t, i) => JSON.stringify({ id: `m${i}`, text: t, ts: 't' }) + '\n').join('');
  writeFileSync(join(dir, `${sid}.jsonl`), lines);
  return dir;
}

function runCheck(base, hookInput) {
  return execFileSync('node', [CHECK], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, CLAUDE_BRIDGE_DIR: base },
    encoding: 'utf-8',
  });
}

describe('bridge-check-inbox.js (turn 配信)', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bridge-hook-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('injects unread comments as a block decision and advances offset', () => {
    seedInbox(base, 'sid', ['first', 'second']);
    const out = runCheck(base, { session_id: 'sid', stop_hook_active: false });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /first/);
    assert.match(parsed.reason, /second/);
    const offset = readFileSync(join(base, 'inbox', 'sid.offset'), 'utf-8').trim();
    assert.equal(offset, '2');
  });

  it('marks the injection as a bridge UI message, not a tool result', () => {
    seedInbox(base, 'sid', ['hello']);
    const out = runCheck(base, { session_id: 'sid', stop_hook_active: false });
    const parsed = JSON.parse(out);
    assert.match(parsed.reason, /\[claude-bridge\]/);
    assert.match(parsed.reason, /ツールの実行結果ではありません/);
  });

  it('records each injection in delivery.log with full texts', () => {
    seedInbox(base, 'sid', ['first', 'second']);
    runCheck(base, { session_id: 'sid', stop_hook_active: false });
    const log = readFileSync(join(base, 'delivery.log'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(log.length, 1);
    const entry = JSON.parse(log[0]);
    assert.equal(entry.sessionId, 'sid');
    assert.equal(entry.count, 2);
    assert.deepEqual(entry.texts, ['first', 'second']);
    assert.ok(entry.ts, 'timestamp recorded');
  });

  it('does not write delivery.log when there is nothing to inject', () => {
    seedInbox(base, 'sid', ['only']);
    runCheck(base, { session_id: 'sid', stop_hook_active: false });
    const out = runCheck(base, { session_id: 'sid', stop_hook_active: false });
    assert.equal(out.trim(), '');
    const log = readFileSync(join(base, 'delivery.log'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(log.length, 1);
  });

  it('emits nothing on the second run (already read)', () => {
    seedInbox(base, 'sid', ['only']);
    runCheck(base, { session_id: 'sid', stop_hook_active: false });
    const out = runCheck(base, { session_id: 'sid', stop_hook_active: false });
    assert.equal(out.trim(), '');
  });

  it('emits nothing when stop_hook_active (loop guard)', () => {
    seedInbox(base, 'sid', ['x']);
    const out = runCheck(base, { session_id: 'sid', stop_hook_active: true });
    assert.equal(out.trim(), '');
  });

  it('rejects malformed session_id', () => {
    seedInbox(base, 'sid', ['x']);
    const out = runCheck(base, { session_id: '../evil', stop_hook_active: false });
    assert.equal(out.trim(), '');
  });
});
