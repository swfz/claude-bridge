import { describe, it, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// storage.js は import 時に DATA_DIR を確定するため、import 前に環境変数を設定する
const TMP = mkdtempSync(join(tmpdir(), 'bridge-storage-'));
process.env.CLAUDE_BRIDGE_DIR = TMP;

const { Storage } = await import('../server/storage.js');

describe('Storage review draft (pending review の永続化)', () => {
  let storage;
  beforeAll(() => {
    storage = new Storage();
  });
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('returns { items: [] } for an unknown key', () => {
    assert.deepEqual(storage.loadReviewDraft('nope'), { items: [] });
  });

  it('round-trips a draft for a key', () => {
    const draft = { items: [{ id: 'r1', text: 'fix this' }], updatedAt: 't1' };
    storage.saveReviewDraft('rk', draft);
    const loaded = storage.loadReviewDraft('rk');
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].text, 'fix this');
  });

  it('falls back to { items: [] } when the file is malformed', () => {
    // items が配列でない壊れた下書きは空として扱う
    storage.saveReviewDraft('rk2', { items: 'broken' });
    assert.deepEqual(storage.loadReviewDraft('rk2'), { items: [] });
  });

  it('clears the draft when saved empty (Submit 後)', () => {
    storage.saveReviewDraft('rk3', { items: [{ id: 'x', text: 'a' }] });
    storage.saveReviewDraft('rk3', { items: [] });
    assert.deepEqual(storage.loadReviewDraft('rk3').items, []);
  });
});

describe('Storage pins (ピン留めの永続化)', () => {
  let storage;
  beforeAll(() => {
    storage = new Storage();
  });
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('returns [] for an unknown key', () => {
    assert.deepEqual(storage.loadPins('nope'), []);
  });

  it('round-trips pins for a key', () => {
    const pins = [{ messageUuid: 'u1', role: 'assistant', excerpt: 'x', messageTimestamp: 't', pinnedAt: 'p' }];
    storage.savePins('claude-uuid', pins);
    assert.deepEqual(storage.loadPins('claude-uuid'), pins);
  });

  it('保存内容が配列でなければ [] として扱う', () => {
    storage.savePins('broken', { messageUuid: 'u1' });
    assert.deepEqual(storage.loadPins('broken'), []);
  });
});

describe('Storage sessions (内蔵 PTY セッションの永続化)', () => {
  let storage;
  beforeAll(() => {
    storage = new Storage();
  });
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('保存が無ければ空配列を返す', () => {
    assert.deepEqual(storage.loadSessions(), []);
  });

  it('sessions.json に保存して読み戻せる', () => {
    const sessions = [{ id: 'a1', name: 'n', cwd: '/c', alive: true }];
    storage.saveSessions(sessions);
    assert.deepEqual(JSON.parse(readFileSync(join(TMP, 'sessions.json'), 'utf-8')), sessions);
    assert.deepEqual(storage.loadSessions(), sessions);
  });

  it('既にデータディレクトリがあっても作り直しで落ちない', () => {
    assert.doesNotThrow(() => new Storage());
    assert.doesNotThrow(() => new Storage());
  });
});

describe('Storage のデータディレクトリ', () => {
  const saved = { dir: process.env.CLAUDE_BRIDGE_DIR, home: process.env.HOME };
  let home;
  afterAll(() => {
    if (saved.dir === undefined) delete process.env.CLAUDE_BRIDGE_DIR;
    else process.env.CLAUDE_BRIDGE_DIR = saved.dir;
    process.env.HOME = saved.home;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('CLAUDE_BRIDGE_DIR が無ければ ~/.claude-bridge を使う', async () => {
    home = mkdtempSync(join(tmpdir(), 'bridge-home-'));
    delete process.env.CLAUDE_BRIDGE_DIR;
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('../server/storage.js');
    assert.equal(mod.DATA_DIR, join(home, '.claude-bridge'));
    new mod.Storage();
    assert.ok(existsSync(join(home, '.claude-bridge')));
  });

  it('CLAUDE_BRIDGE_DIR が深い未作成のパスでも途中ごと作る', async () => {
    const nested = join(home, 'a', 'b', 'c');
    process.env.CLAUDE_BRIDGE_DIR = nested;
    vi.resetModules();
    const mod = await import('../server/storage.js');
    new mod.Storage();
    assert.ok(existsSync(nested));
  });
});
