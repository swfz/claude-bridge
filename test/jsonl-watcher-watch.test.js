import { describe, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JsonlWatcher } from '../server/jsonl-watcher.js';
import { createTaskNotificationState } from '../server/jsonl-utils.js';

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

  it('処理待ちに積まれたサブエージェントの報告は Subagent の 1 件だけ配る（後の user レコードは捨てる）', async () => {
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
      pendingTasks: createTaskNotificationState(),
      fsWatcher: null,
      pollTimer: null,
    };
    watcher.watchers.set('test', state);
    watcher._startFileWatch(state);

    const body = '[Subagent hand-back] report.\nThe report follows:\n  終わりました';
    const enq = `<agent-message from="a1">\n${body}\n</agent-message>`;
    appendFileSync(
      filePath,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: enq }),
        JSON.stringify({
          type: 'user',
          uuid: 'p1',
          origin: { kind: 'peer', from: 'a1', handback: true, body },
          message: { content: `Another Claude session sent a message:\n${enq}` },
        }),
      ].join('\n') + '\n',
    );
    await wait(500);

    const humanMsgs = messages.filter((m) => m.role === 'human');
    assert.equal(humanMsgs.length, 1);
    assert.equal(humanMsgs[0].content, '終わりました');
    assert.equal(humanMsgs[0].sender.kind, 'subagent');

    if (state.fsWatcher) state.fsWatcher.close();
  });
  it('sessionId 指定でファイルもプロジェクトディレクトリも無いとき、後から作られたファイルを読む（claude -w の新規 worktree）', async () => {
    const messages = [];
    const projectPath = join(tmpDir, 'not-yet');
    const id = 'aaaaaaaa-0000-0000-0000-000000000000';

    watcher.startWatching({
      bridgeSessionId: 'test',
      cwd: join(tmpDir, 'no-such-cwd'),
      sessionId: id,
      fromStart: true,
      onMessage: (msg) => messages.push(msg),
    });
    const state = watcher.watchers.get('test');
    state.projectPath = projectPath;
    state.targetFile = join(projectPath, `${id}.jsonl`);
    assert.ok(state.pollTimer, 'ディレクトリが無いのでポーリングで待つ');

    mkdirSync(projectPath);
    writeFileSync(state.targetFile, makeRecord('user', 'first') + '\n');
    await wait(2500);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'first');

    appendFileSync(state.targetFile, makeRecord('user', 'second') + '\n');
    await wait(500);
    assert.deepEqual(
      messages.map((m) => m.content),
      ['first', 'second'],
    );
  });
});

// CLAUDE_PROJECTS_DIR は import 時に決まるので、環境変数を tmpdir に向けてから読み込み直す。
// cwd からプロジェクトディレクトリを引く経路（startWatching / findSessionForCwd）を実ファイルで確かめる
describe('JsonlWatcher（CLAUDE_PROJECTS_DIR 配下の監視）', () => {
  const saved = process.env.CLAUDE_BRIDGE_PROJECTS_DIR;
  let projectsDir;
  let Watcher;
  let watcher;
  let messages;
  let seq = 0;
  // テストごとに別の cwd（= 別のプロジェクトディレクトリ）を使う
  let cwd;
  let projectPath;

  beforeAll(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'jsonl-projects-'));
    process.env.CLAUDE_BRIDGE_PROJECTS_DIR = projectsDir;
    vi.resetModules();
    ({ JsonlWatcher: Watcher } = await import('../server/jsonl-watcher.js'));
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.CLAUDE_BRIDGE_PROJECTS_DIR;
    else process.env.CLAUDE_BRIDGE_PROJECTS_DIR = saved;
    vi.resetModules();
    rmSync(projectsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    watcher = new Watcher();
    messages = [];
    seq += 1;
    cwd = `/work/proj-${seq}`;
    projectPath = join(projectsDir, `-work-proj-${seq}`);
  });

  afterEach(() => {
    watcher.stopAll();
    vi.useRealTimers();
  });

  const onMessage = (msg) => messages.push(msg);
  const contents = () => messages.map((m) => m.content);
  const writeSession = (id, lines, mtime) => {
    mkdirSync(projectPath, { recursive: true });
    const file = join(projectPath, `${id}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');
    if (mtime != null) utimesSync(file, new Date(mtime), new Date(mtime));
    return file;
  };

  it('sessionId 指定では既存の行を飛ばし、追記された行だけを配る（空白だけの行は数えない）', async () => {
    const file = writeSession('s1', [makeRecord('user', 'old1'), '   ', makeRecord('user', 'old2')]);
    watcher.startWatching({ bridgeSessionId: 'b', cwd, sessionId: 's1', onMessage });
    appendFileSync(file, makeRecord('user', 'new') + '\n');
    await wait(300);
    assert.deepEqual(contents(), ['new']);
    assert.deepEqual(watcher.getSessionMeta('b'), { claudeSessionId: 's1', projectDir: `-work-proj-${seq}` });
  });

  it('resumeSessionId 指定でも同じファイルを監視し、既存の行は配らない', async () => {
    const file = writeSession('r1', [makeRecord('user', 'old')]);
    watcher.startWatching({ bridgeSessionId: 'b', cwd, resumeSessionId: 'r1', onMessage });
    appendFileSync(file, makeRecord('user', 'new') + '\n');
    await wait(300);
    assert.deepEqual(contents(), ['new']);
  });

  it('fromStart なら既存の行も次の更新で配る', async () => {
    const file = writeSession('s1', [makeRecord('user', 'old')]);
    watcher.startWatching({ bridgeSessionId: 'b', cwd, sessionId: 's1', fromStart: true, onMessage });
    appendFileSync(file, makeRecord('user', 'new') + '\n');
    await wait(300);
    assert.deepEqual(contents(), ['old', 'new']);
  });

  it('attachExisting は最新のファイルに付き、既存の行を飛ばす（空白だけの行は数えない）', async () => {
    writeSession('older', [makeRecord('user', 'x')], Date.now() - 60000);
    const file = writeSession('latest', [makeRecord('user', 'old1'), '   ', makeRecord('user', 'old2')]);
    watcher.startWatching({ bridgeSessionId: 'b', cwd, attachExisting: true, onMessage });
    appendFileSync(file, makeRecord('user', 'new') + '\n');
    await wait(300);
    assert.deepEqual(contents(), ['new']);
    assert.equal(watcher.getSessionMeta('b').claudeSessionId, 'latest');
  });

  it('findSessionForCwd は cwd のプロジェクトディレクトリの最新セッションを返し、無ければ null', () => {
    assert.equal(watcher.findSessionForCwd(cwd), null);
    writeSession('older', ['{}'], Date.now() - 60000);
    writeSession('latest', ['{}']);
    assert.deepEqual(watcher.findSessionForCwd(cwd), { sessionId: 'latest', projectDir: `-work-proj-${seq}` });
  });

  it('プロジェクトディレクトリがあれば、新しいファイルをポーリングを待たずに拾い、停止後は配らない', async () => {
    mkdirSync(projectPath, { recursive: true });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, onMessage });
    const file = writeSession('s1', [makeRecord('user', 'first')]);
    await wait(300);
    assert.deepEqual(contents(), ['first']);

    watcher.stopWatching('b');
    appendFileSync(file, makeRecord('user', 'after-stop') + '\n');
    vi.advanceTimersByTime(3000);
    await wait(300);
    assert.deepEqual(contents(), ['first']);
  });

  it('sessionId のファイルがまだ無くても、プロジェクトディレクトリがあればファイルの作成を拾う', async () => {
    mkdirSync(projectPath, { recursive: true });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, sessionId: 's1', onMessage });
    writeSession('s1', [makeRecord('user', 'first')]);
    await wait(300);
    assert.deepEqual(contents(), ['first']);
  });

  it('sessionId のプロジェクトディレクトリが無いときはポーリングで待ち、見つけた後に停止すれば配らない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, sessionId: 's1', onMessage });
    const file = writeSession('s1', [makeRecord('user', 'first')]);
    vi.advanceTimersByTime(2000);
    assert.deepEqual(contents(), ['first']);

    watcher.stopWatching('b');
    appendFileSync(file, makeRecord('user', 'after-stop') + '\n');
    vi.advanceTimersByTime(4000);
    await wait(300);
    assert.deepEqual(contents(), ['first']);
  });

  it('プロジェクトディレクトリが無いまま停止したら、後でファイルができても配らない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, onMessage });
    watcher.stopWatching('b');
    writeSession('s1', [makeRecord('user', 'late')]);
    vi.advanceTimersByTime(4000);
    await wait(300);
    assert.deepEqual(contents(), []);
  });

  it('attachExisting でなければ 10 秒以上前のファイルを新しいセッションとして拾わない', async () => {
    mkdirSync(projectPath, { recursive: true });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, onMessage });
    writeSession('s1', [makeRecord('user', 'old')], Date.now() - 60000);
    vi.advanceTimersByTime(1000);
    await wait(300);
    assert.deepEqual(contents(), []);
  });

  it('attachExisting なら後から現れた古いファイルも拾う', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, attachExisting: true, onMessage });
    writeSession('s1', [makeRecord('user', 'old')], Date.now() - 60000);
    vi.advanceTimersByTime(1000);
    assert.deepEqual(contents(), ['old']);
  });

  it('新規セッション（ID も attachExisting も無し）は、直前にできたファイルを先頭から配る', () => {
    writeSession('s1', [makeRecord('user', 'first')]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    watcher.startWatching({ bridgeSessionId: 'b', cwd, onMessage });
    vi.advanceTimersByTime(1000);
    assert.deepEqual(contents(), ['first']);
  });
});
