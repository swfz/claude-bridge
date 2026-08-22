import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// storage.js は import 時に DATA_DIR を確定するため、import 前に環境変数を設定する
const TMP = mkdtempSync(join(tmpdir(), 'bridge-comments-'));
process.env.CLAUDE_BRIDGE_DIR = TMP;

const { Storage } = await import('../server/storage.js');

describe('Storage comments (参照専用コメントの永続化)', () => {
  let storage;
  before(() => {
    storage = new Storage();
  });
  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('returns [] for an unknown key', () => {
    assert.deepEqual(storage.loadComments('nope'), []);
  });

  it('round-trips comments for a key', () => {
    const comments = [{ id: 'c1', text: 'a', role: 'assistant', messageSnippet: 'snip', timestamp: 't1' }];
    storage.saveComments('claude-uuid', comments);
    assert.deepEqual(storage.loadComments('claude-uuid'), comments);
  });

  it('isolates comments by key (claudeSessionId vs bridgeId)', () => {
    // 同じ Claude セッションを別のブリッジ ID で開き直しても、claudeSessionId を
    // キーにしていれば同じコメントを参照できる、という設計をキー分離として担保する。
    storage.saveComments('key-A', [{ id: 'a1', text: 'for A' }]);
    storage.saveComments('key-B', [{ id: 'b1', text: 'for B' }]);
    assert.equal(storage.loadComments('key-A').length, 1);
    assert.equal(storage.loadComments('key-A')[0].text, 'for A');
    assert.equal(storage.loadComments('key-B')[0].text, 'for B');
  });
});

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
