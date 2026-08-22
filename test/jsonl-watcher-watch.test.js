import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JsonlWatcher } from '../server/jsonl-watcher.js';

// startWatching の統合テスト（実ファイルの監視）

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRecord(type, content) {
  return JSON.stringify({
    type,
    message: { content },
    timestamp: new Date().toISOString(),
  });
}

describe('JsonlWatcher startWatching integration', () => {
  let watcher;
  let tmpDir;

  beforeEach(() => {
    watcher = new JsonlWatcher();
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-watch-'));
  });

  afterEach(() => {
    watcher.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects new file and reads messages', async () => {
    const messages = [];

    // startWatching (ファイルはまだない → ポーリング開始)
    watcher.startWatching({
      bridgeSessionId: 'test',
      cwd: '/fake/path',
      onMessage: (msg) => messages.push(msg),
    });

    // watcher の projectPath を tmpDir に差し替え
    const state = watcher.watchers.get('test');
    state.projectPath = tmpDir;

    // ファイルを作成
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, makeRecord('user', 'hello') + '\n');

    // ポーリング間隔（1秒）+ 余裕を待つ
    await wait(1500);

    assert.ok(messages.length >= 1, `Expected messages, got ${messages.length}`);
    assert.equal(messages[0].role, 'human');
    assert.equal(messages[0].content, 'hello');
  });

  it('reads appended lines after initial detection', async () => {
    const messages = [];

    // 先にファイルを作成
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, makeRecord('user', 'first') + '\n');

    watcher.startWatching({
      bridgeSessionId: 'test',
      cwd: '/fake/path',
      onMessage: (msg) => messages.push(msg),
    });

    const state = watcher.watchers.get('test');
    state.projectPath = tmpDir;

    // ポーリングでファイル検出を待つ
    await wait(1500);
    const initialCount = messages.length;

    // 新しい行を追加
    appendFileSync(filePath, makeRecord('assistant', 'response') + '\n');

    // ファイル変更の検出を待つ
    await wait(500);

    assert.ok(
      messages.length > initialCount,
      `Expected new messages after append, got ${messages.length} (was ${initialCount})`,
    );
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, 'assistant');
    assert.equal(lastMsg.content, 'response');
  });

  it('attachExisting skips existing lines and watches for new ones', async () => {
    const messages = [];

    // 既存ファイルを作成
    const filePath = join(tmpDir, 'existing.jsonl');
    writeFileSync(
      filePath,
      [makeRecord('user', 'old message 1'), makeRecord('assistant', 'old response')].join('\n') + '\n',
    );

    // startWatching 時に _findLatestJsonl が動くよう、
    // cwd からの projectPath が tmpDir になるようにする代わりに、
    // 直接 state を構築してテスト
    const state = {
      bridgeSessionId: 'test',
      cwd: '/fake',
      projectPath: tmpDir,
      targetFile: filePath,
      linesRead: 2, // attachExisting で既存行をスキップ済み
      attachExisting: true,
      onMessage: (msg) => messages.push(msg),
      fsWatcher: null,
      pollTimer: null,
    };

    watcher.watchers.set('test', state);
    watcher._startFileWatch(state);

    // 既存行はスキップされるはず
    assert.equal(messages.length, 0, 'Should not read existing lines');

    // 新しい行を追加
    appendFileSync(filePath, makeRecord('user', 'new message') + '\n');
    await wait(500);

    assert.ok(messages.length >= 1, 'Should read new lines');
    assert.equal(messages[0].content, 'new message');

    if (state.fsWatcher) state.fsWatcher.close();
  });

  it('resumeSessionId watches specific file', async () => {
    const messages = [];
    const sessionId = 'abc-123';

    // 既存ファイル
    const filePath = join(tmpDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, [makeRecord('user', 'history 1'), makeRecord('assistant', 'history 2')].join('\n') + '\n');

    // _findLatestJsonl は CLAUDE_PROJECTS_DIR を使うので直接テストできない
    // resumeSessionId 指定時は projectPath + sessionId.jsonl を監視
    // → state を手動で構築してテスト

    const state = {
      bridgeSessionId: 'test',
      cwd: '/fake',
      projectPath: tmpDir,
      targetFile: filePath,
      linesRead: 2, // 既存行はスキップ
      attachExisting: false,
      onMessage: (msg) => messages.push(msg),
      fsWatcher: null,
      pollTimer: null,
    };

    watcher.watchers.set('test', state);
    watcher._startFileWatch(state);

    // 新しい行を追加
    appendFileSync(filePath, makeRecord('assistant', 'new response') + '\n');
    await wait(500);

    assert.ok(messages.length >= 1);
    assert.equal(messages[0].content, 'new response');
    assert.equal(messages[0].role, 'assistant');
  });

  it('stopWatching stops detecting new messages', async () => {
    const messages = [];

    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, makeRecord('user', 'hello') + '\n');

    watcher.startWatching({
      bridgeSessionId: 'test',
      cwd: '/fake/path',
      onMessage: (msg) => messages.push(msg),
    });

    const state = watcher.watchers.get('test');
    state.projectPath = tmpDir;

    await wait(1500);
    const countAfterDetect = messages.length;

    watcher.stopWatching('test');

    // 停止後に追加しても検出されない
    appendFileSync(filePath, makeRecord('assistant', 'after stop') + '\n');
    await wait(500);

    assert.equal(messages.length, countAfterDetect);
  });

  it('emits both queue-operation and user record for same input (client dedup scenario)', async () => {
    // リグレッションテスト: tmux セッションで InputBar から送信すると
    // queue-operation(enqueue) と user の両方が JSONL に記録される。
    // watcher は両方配信し、クライアント側で重複チェックする。
    const messages = [];

    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, makeRecord('assistant', 'initial') + '\n');

    const state = {
      bridgeSessionId: 'test',
      cwd: '/fake',
      projectPath: tmpDir,
      targetFile: filePath,
      linesRead: 1,
      attachExisting: true,
      onMessage: (msg) => messages.push(msg),
      fsWatcher: null,
      pollTimer: null,
    };

    watcher.watchers.set('test', state);
    watcher._startFileWatch(state);

    // InputBar送信をシミュレート: queue-operation + user が追記される
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          content: 'my input',
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'user', message: { content: 'my input' }, timestamp: new Date().toISOString() }),
      ].join('\n') + '\n',
    );

    await wait(500);

    const humanMsgs = messages.filter((m) => m.role === 'human');
    assert.equal(humanMsgs.length, 2, 'Both queue-operation and user should be emitted');
    assert.equal(humanMsgs[0].content, 'my input');
    assert.equal(humanMsgs[1].content, 'my input');

    if (state.fsWatcher) state.fsWatcher.close();
  });
});
