import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// storage.js は import 時に DATA_DIR を確定するため、import 前に環境変数を設定する
const TMP = mkdtempSync(join(tmpdir(), 'bridge-storage-'));
process.env.CLAUDE_BRIDGE_DIR = TMP;

const { Storage } = await import('../server/storage.js');

describe('Storage review draft (pending review の永続化)', () => {
  let storage;
  before(() => {
    storage = new Storage();
  });
  after(() => {
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
  before(() => {
    storage = new Storage();
  });
  after(() => {
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
});
