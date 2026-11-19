import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JsonlWatcher } from '../server/jsonl-watcher.js';
import { createTaskNotificationState } from '../server/jsonl-utils.js';

// _findLatestJsonl と findSessionForCwd のテスト用に
// CLAUDE_PROJECTS_DIR を差し替えることはできないが、
// watcher のメソッドを直接テストする

describe('JsonlWatcher', () => {
  let watcher;
  let tmpDir;

  beforeEach(() => {
    watcher = new JsonlWatcher();
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-test-'));
  });

  afterEach(() => {
    watcher.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('_findLatestJsonl', () => {
    it('returns null for empty directory', () => {
      assert.equal(watcher._findLatestJsonl(tmpDir), null);
    });

    it('returns null for nonexistent directory', () => {
      assert.equal(watcher._findLatestJsonl('/nonexistent/path'), null);
    });

    it('returns the most recently modified jsonl file', () => {
      const older = join(tmpDir, 'old.jsonl');
      const newer = join(tmpDir, 'new.jsonl');
      writeFileSync(older, '{}');
      writeFileSync(newer, '{}');

      // older のタイムスタンプを過去に設定
      const past = new Date(Date.now() - 60000);
      utimesSync(older, past, past);

      assert.equal(watcher._findLatestJsonl(tmpDir), newer);
    });

    it('ignores non-jsonl files', () => {
      writeFileSync(join(tmpDir, 'readme.md'), 'hello');
      writeFileSync(join(tmpDir, 'data.json'), '{}');
      const jsonl = join(tmpDir, 'session.jsonl');
      writeFileSync(jsonl, '{}');

      assert.equal(watcher._findLatestJsonl(tmpDir), jsonl);
    });
  });

  describe('_readNewLines', () => {
    it('reads new lines and calls onMessage for user/assistant records', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      const records = [
        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant', message: { content: 'hi there' }, timestamp: '2024-01-01T00:00:01Z' }),
        JSON.stringify({ type: 'system', message: 'ignored' }),
      ];
      writeFileSync(filePath, records.join('\n') + '\n');

      const messages = [];
      const state = {
        bridgeSessionId: 'test-session',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'human');
      assert.equal(messages[0].content, 'hello');
      assert.equal(messages[0].bridgeSessionId, 'test-session');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'hi there');
    });

    it('emits an artifact message for a successful Artifact publish', () => {
      const filePath = join(tmpDir, 'artifact.jsonl');
      const url = 'https://claude.ai/code/artifact/46f54464-0000-0000-0000-000000000000';
      const records = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-19T07:50:17.709Z',
          message: {
            role: 'user',
            content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: `Published at ${url}` }],
          },
          toolUseResult: { url, path: '/tmp/report.html', title: 'dotfiles レポート' },
        }),
        // 失敗した publish は出さない
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          message: {
            role: 'user',
            content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'Error', is_error: true }],
          },
          toolUseResult: 'Error: publish failed',
        }),
      ];
      writeFileSync(filePath, records.join('\n') + '\n');

      const messages = [];
      const state = {
        bridgeSessionId: 'test-session',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      // 失敗した publish はツール失敗の印（toolresult）としてだけ流れる
      // 成功した publish の結果も {id} だけの印として流れるので、失敗の印だけを見る
      const failed = messages.filter((m) => m.role === 'toolresult' && m.results.some((r) => r.error));
      assert.deepEqual(
        failed.map((m) => m.results),
        [[{ id: 'toolu_2', error: true }]],
      );
      messages.splice(0, messages.length, ...messages.filter((m) => m.role !== 'toolresult'));
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'chat_message');
      assert.equal(messages[0].role, 'artifact');
      assert.equal(messages[0].bridgeSessionId, 'test-session');
      assert.equal(messages[0].url, url);
      assert.equal(messages[0].title, 'dotfiles レポート');
      assert.equal(messages[0].content, 'dotfiles レポート');
      assert.equal(messages[0].path, '/tmp/report.html');
      assert.equal(messages[0].uuid, 'u1');
      assert.equal(messages[0].timestamp, '2026-06-19T07:50:17.709Z');
    });

    it('marks injected user records (isMeta / tag) with injected: true', () => {
      const filePath = join(tmpDir, 'injected.jsonl');
      const records = [
        { type: 'user', uuid: 'h1', message: { role: 'user', content: 'hello' } },
        { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'meta text' } },
      ];
      writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const messages = [];
      watcher._readNewLines({
        bridgeSessionId: 'test-session',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      });

      assert.equal(messages.length, 2);
      assert.equal('injected' in messages[0], false);
      assert.equal(messages[1].injected, true);
    });

    it('emits a webfetch message for a WebFetch result', () => {
      const filePath = join(tmpDir, 'webfetch.jsonl');
      const record = {
        type: 'user',
        uuid: 'u-fetch',
        timestamp: '2026-10-07T00:00:00.000Z',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_f', type: 'tool_result', content: '...' }] },
        toolUseResult: {
          bytes: 10,
          code: 301,
          codeText: 'Moved',
          result: 'REDIRECT DETECTED: x',
          durationMs: 5,
          url: 'https://example.com/a',
        },
      };
      writeFileSync(filePath, JSON.stringify(record) + '\n');

      const messages = [];
      const state = {
        bridgeSessionId: 'test-session',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.deepEqual(
        messages.filter((m) => m.role !== 'toolresult'),
        [
          {
            type: 'chat_message',
            bridgeSessionId: 'test-session',
            role: 'webfetch',
            // タイトルが取れない（リダイレクト）ときは URL を content にする
            content: 'https://example.com/a',
            url: 'https://example.com/a',
            title: null,
            code: 301,
            uuid: 'u-fetch',
            timestamp: '2026-10-07T00:00:00.000Z',
          },
        ],
      );
    });

    it('skips already-read lines', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({ type: 'user', message: { content: 'first' } }),
          JSON.stringify({ type: 'assistant', message: { content: 'response' } }),
        ].join('\n') + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 1, // skip first line
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'response');
      assert.equal(state.linesRead, 2);
    });

    it('handles array content blocks', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'part1' },
              { type: 'tool_use', id: 't1' },
              { type: 'text', text: 'part2' },
            ],
          },
        }) + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'part1\n\npart2');
    });

    it('skips malformed JSON lines', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        ['not json', JSON.stringify({ type: 'assistant', message: { content: 'valid' } }), '{broken'].join('\n') + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'valid');
    });

    it('reads queue-operation enqueue as human message', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            content: '途中の指示',
            timestamp: '2024-01-01T00:00:00Z',
          }),
          JSON.stringify({ type: 'queue-operation', operation: 'remove' }),
        ].join('\n') + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'human');
      assert.equal(messages[0].content, '途中の指示');
    });

    it('extracts toolUses from assistant messages', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '確認します' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
              { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/user/project/index.js' } },
            ],
          },
        }) + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, '確認します');
      assert.equal(messages[0].toolUses.length, 2);
      assert.equal(messages[0].toolUses[0].name, 'Bash');
      assert.equal(messages[0].toolUses[0].summary, 'Run tests');
      assert.equal(messages[0].toolUses[1].name, 'Read');
      assert.ok(messages[0].toolUses[1].summary.includes('index.js'));
    });

    it('emits message for tool_use only (no text) assistant records', () => {
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Edit',
                input: { file_path: '/a/b.js', old_string: 'old', new_string: 'new' },
              },
            ],
          },
        }) + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, '');
      assert.equal(messages[0].toolUses.length, 1);
      assert.equal(messages[0].toolUses[0].name, 'Edit');
    });

    it('does not deduplicate at watcher level (dedup is client responsibility)', () => {
      // 同一内容のメッセージが2回 JSONL に書かれた場合、watcher は両方配信する
      // 重複排除はクライアント側 (App.jsx setMessages) の責務
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({ type: 'user', message: { content: 'hello' } }),
          JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        ].join('\n') + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 2, 'Watcher should emit both messages without dedup');
      assert.equal(messages[0].content, 'hello');
      assert.equal(messages[1].content, 'hello');
    });

    it('emits queue-operation and regular user message independently', () => {
      // InputBar送信 → addUserMessage(即座) + JSONL(queue-operation + user)
      // watcher は両方配信し、クライアント側で重複チェック
      const filePath = join(tmpDir, 'test.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            content: 'test input',
            timestamp: '2024-01-01T00:00:00Z',
          }),
          JSON.stringify({ type: 'queue-operation', operation: 'remove' }),
          JSON.stringify({ type: 'user', message: { content: 'test input' }, timestamp: '2024-01-01T00:00:01Z' }),
        ].join('\n') + '\n',
      );

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      // queue-operation(enqueue) と user の両方が human として配信される
      const humanMessages = messages.filter((m) => m.role === 'human');
      assert.equal(humanMessages.length, 2);
      assert.equal(humanMessages[0].content, 'test input');
      assert.equal(humanMessages[1].content, 'test input');
    });

    it('does nothing when targetFile is null', () => {
      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        targetFile: null,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);
      assert.equal(messages.length, 0);
    });
  });

  describe('_detectNewFile', () => {
    it('detects a recently modified file', () => {
      const filePath = join(tmpDir, 'session.jsonl');
      writeFileSync(filePath, JSON.stringify({ type: 'user', message: { content: 'test' } }) + '\n');

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: false,
        onMessage: (msg) => messages.push(msg),
        fsWatcher: null,
        pollTimer: setInterval(() => {}, 99999),
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, filePath);
      assert.equal(messages.length, 1);

      // cleanup
      if (state.fsWatcher) state.fsWatcher.close();
      clearInterval(state.pollTimer);
    });

    it('skips old files when attachExisting is false', () => {
      const filePath = join(tmpDir, 'session.jsonl');
      writeFileSync(filePath, '{}');
      // ファイルを20秒前のタイムスタンプに設定
      const past = new Date(Date.now() - 20000);
      utimesSync(filePath, past, past);

      const state = {
        bridgeSessionId: 'test',
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: false,
        onMessage: () => {},
        fsWatcher: null,
        pollTimer: null,
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, null);
    });

    it('accepts old files when attachExisting is true', () => {
      const filePath = join(tmpDir, 'session.jsonl');
      writeFileSync(filePath, JSON.stringify({ type: 'user', message: { content: 'old' } }) + '\n');
      const past = new Date(Date.now() - 60000);
      utimesSync(filePath, past, past);

      const messages = [];
      const state = {
        bridgeSessionId: 'test',
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: true,
        onMessage: (msg) => messages.push(msg),
        fsWatcher: null,
        pollTimer: null,
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, filePath);
      assert.equal(messages.length, 1);

      if (state.fsWatcher) state.fsWatcher.close();
    });
  });

  describe('stopWatching', () => {
    it('removes watcher and cleans up', () => {
      const projectPath = tmpDir;
      mkdirSync(projectPath, { recursive: true });

      watcher.startWatching({
        bridgeSessionId: 'test',
        cwd: '/nonexistent/path/for/test',
        onMessage: () => {},
      });

      assert.equal(watcher.watchers.size, 1);

      watcher.stopWatching('test');
      assert.equal(watcher.watchers.size, 0);
    });

    it('stopAll clears all watchers', () => {
      watcher.startWatching({
        bridgeSessionId: 'a',
        cwd: '/nonexistent/a',
        onMessage: () => {},
      });
      watcher.startWatching({
        bridgeSessionId: 'b',
        cwd: '/nonexistent/b',
        onMessage: () => {},
      });

      assert.equal(watcher.watchers.size, 2);

      watcher.stopAll();
      assert.equal(watcher.watchers.size, 0);
    });
  });

  describe('getSessionMeta', () => {
    it('returns null for unknown bridgeSessionId', () => {
      assert.equal(watcher.getSessionMeta('nope'), null);
    });

    it('returns null when targetFile is not yet resolved', () => {
      // ファイル未特定の状態（startWatching で resumeSessionId/sessionId/attachExisting なしの新規）
      watcher.watchers.set('bridge-1', {
        bridgeSessionId: 'bridge-1',
        cwd: '/tmp/proj',
        targetFile: null,
      });
      assert.equal(watcher.getSessionMeta('bridge-1'), null);
    });

    it('returns claudeSessionId and projectDir derived from targetFile', () => {
      const sessionId = 'abc-123-uuid';
      const cwd = '/home/user/work/myproj';
      watcher.watchers.set('bridge-2', {
        bridgeSessionId: 'bridge-2',
        cwd,
        targetFile: `/some/path/${sessionId}.jsonl`,
      });

      const meta = watcher.getSessionMeta('bridge-2');
      assert.ok(meta);
      assert.equal(meta.claudeSessionId, sessionId);
      // projectDir は cwdToProjectDir(cwd) なので非空文字列であることを確認
      assert.equal(typeof meta.projectDir, 'string');
      assert.ok(meta.projectDir.length > 0);
    });
  });
});

describe('JsonlWatcher が配るメッセージ', () => {
  let watcher;
  let tmpDir;

  beforeEach(() => {
    watcher = new JsonlWatcher();
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-msg-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    watcher.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const TASK_TEXT =
    '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<summary>テスト完了</summary>\n</task-notification>';

  // records を書いたファイルを先頭から読み、配られたメッセージを返す
  function readAll(records) {
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const messages = [];
    watcher._readNewLines({
      bridgeSessionId: 'b1',
      targetFile: filePath,
      linesRead: 0,
      pendingTasks: createTaskNotificationState(),
      onMessage: (msg) => messages.push(msg),
    });
    return messages;
  }

  const base = { type: 'chat_message', bridgeSessionId: 'b1' };

  it('人の発言・Artifact・ツール結果の印・WebFetch に時刻（無ければ空文字）を付けて配る', () => {
    const url = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001';
    const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
    const messages = readAll([
      { type: 'user', uuid: 'u1', timestamp: 'T1', message: { content: 'a' } },
      // 監視側は updatedAt を見ない
      { type: 'user', uuid: 'u2', updatedAt: 'U2', message: { content: 'b' } },
      { type: 'user', uuid: 'p1', message: toolResult('toolu_1'), toolUseResult: { url, path: '/r.html', title: 'R' } },
      {
        type: 'user',
        uuid: 'f1',
        message: toolResult('toolu_2'),
        toolUseResult: { url: 'https://example.com/', code: 200, result: '# Example\n本文' },
      },
    ]);
    assert.deepEqual(messages, [
      { ...base, role: 'human', content: 'a', uuid: 'u1', timestamp: 'T1' },
      { ...base, role: 'human', content: 'b', uuid: 'u2', timestamp: '' },
      { ...base, role: 'artifact', content: 'R', url, title: 'R', path: '/r.html', uuid: 'p1', timestamp: '' },
      { ...base, role: 'toolresult', content: '', results: [{ id: 'toolu_1' }], uuid: 'p1', timestamp: '' },
      { ...base, role: 'toolresult', content: '', results: [{ id: 'toolu_2' }], uuid: 'f1', timestamp: '' },
      {
        ...base,
        role: 'webfetch',
        content: 'Example',
        url: 'https://example.com/',
        title: 'Example',
        code: 200,
        uuid: 'f1',
        timestamp: '',
      },
    ]);
  });

  it('assistant の thinking・本文・ツール呼び出しを分けて配り、中身の無い応答や他の種類は配らない', () => {
    const messages = readAll([
      {
        type: 'assistant',
        uuid: 'k1',
        timestamp: 'T1',
        message: { content: [{ type: 'thinking', thinking: '考え1' }] },
      },
      { type: 'assistant', uuid: 'k2', message: { content: [{ type: 'thinking', thinking: '考え2' }] } },
      { type: 'assistant', uuid: 'e1', message: { content: [] } },
      { type: 'system', uuid: 's1', message: { content: [{ type: 'text', text: 'system の本文' }] } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '本文だけ' }] } },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: 'T2',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 10, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
        },
      },
    ]);
    assert.deepEqual(messages, [
      { ...base, role: 'thinking', content: '考え1', uuid: 'k1', timestamp: 'T1' },
      { ...base, role: 'thinking', content: '考え2', uuid: 'k2', timestamp: '' },
      {
        ...base,
        role: 'assistant',
        content: '本文だけ',
        toolUses: undefined,
        contextUsage: undefined,
        uuid: 'a1',
        timestamp: '',
      },
      {
        ...base,
        role: 'assistant',
        content: '',
        toolUses: [{ id: 't1', name: 'Read', input: { file_path: '/x' }, summary: '/x' }],
        contextUsage: {
          inputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          contextTokens: 10,
          contextWindow: 200000,
          model: 'claude-sonnet-4',
        },
        uuid: 'a2',
        timestamp: 'T2',
      },
    ]);
  });

  it('attachment はフックの失敗だけを配る', () => {
    const messages = readAll([
      {
        type: 'attachment',
        uuid: 'h1',
        timestamp: 'T1',
        attachment: { type: 'hook_non_blocking_error', hookName: 'Stop', stderr: 'boom' },
      },
      { type: 'attachment', uuid: 'h2', attachment: { type: 'file', path: '/x' } },
    ]);
    assert.deepEqual(messages, [
      {
        ...base,
        uuid: 'h1',
        timestamp: 'T1',
        role: 'hookerror',
        content: 'boom',
        hook: { name: 'Stop', exitCode: null, command: '', detail: 'boom' },
      },
    ]);
  });

  it('queue-operation は本文のある enqueue だけを人の発言として配る', () => {
    const messages = readAll([
      { type: 'queue-operation', operation: 'enqueue', uuid: 'q1', timestamp: 'T1', content: '積んだ指示' },
      { type: 'queue-operation', operation: 'enqueue', uuid: 'q2', content: '時刻なし' },
      { type: 'queue-operation', operation: 'remove', uuid: 'q3', content: '取り消し' },
      { type: 'queue-operation', operation: 'enqueue', uuid: 'q4', content: '' },
      { type: 'system', operation: 'enqueue', uuid: 'q5', content: '別の種類' },
    ]);
    assert.deepEqual(messages, [
      { ...base, role: 'human', content: '積んだ指示', uuid: 'q1', timestamp: 'T1' },
      { ...base, role: 'human', content: '時刻なし', uuid: 'q2', timestamp: '' },
    ]);
  });

  it('enqueue されたタスク通知は積み直しや後の user レコードがあっても 1 件だけ配る', () => {
    const messages = readAll([
      { type: 'queue-operation', operation: 'enqueue', uuid: 'q1', timestamp: 'T1', content: TASK_TEXT },
      { type: 'queue-operation', operation: 'enqueue', uuid: 'q2', timestamp: 'T2', content: TASK_TEXT },
      { type: 'user', uuid: 'u1', timestamp: 'T3', message: { content: TASK_TEXT } },
      { type: 'user', uuid: 'u2', timestamp: 'T4', message: { content: TASK_TEXT } },
      { type: 'user', uuid: 'u3', timestamp: 'T5', message: { content: '次の指示' } },
    ]);
    assert.deepEqual(
      messages.map((m) => [m.type, m.bridgeSessionId, m.role, m.content, m.uuid]),
      [
        ['chat_message', 'b1', 'task', 'テスト完了', 'q1'],
        ['chat_message', 'b1', 'human', '次の指示', 'u3'],
      ],
    );
  });

  it('enqueue されていないタスク通知の user レコードはタスク通知として配る', () => {
    const messages = readAll([{ type: 'user', uuid: 'u1', timestamp: 'T1', message: { content: TASK_TEXT } }]);
    assert.deepEqual(
      messages.map((m) => [m.type, m.bridgeSessionId, m.role, m.content, m.uuid, m.timestamp]),
      [['chat_message', 'b1', 'task', 'テスト完了', 'u1', 'T1']],
    );
  });

  it('Agent ツールで起動したサブエージェントの報告には種別名を付ける', () => {
    const messages = readAll([
      {
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'Explore' } }] },
      },
      {
        type: 'user',
        uuid: 'r1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'launched' }] },
        toolUseResult: { agentId: 'agent123' },
      },
      {
        type: 'queue-operation',
        operation: 'enqueue',
        uuid: 'q1',
        content: '<agent-message from="agent123">\n[Subagent hand-back] 終わりました\n</agent-message>',
      },
    ]);
    const report = messages.find((m) => m.uuid === 'q1');
    assert.equal(report.role, 'human');
    assert.deepEqual(report.sender, { kind: 'subagent', name: 'Explore' });
  });

  it('監視先のファイルが消えていても例外を投げず何も配らない', () => {
    const messages = [];
    watcher._readNewLines({
      bridgeSessionId: 'b1',
      targetFile: join(tmpDir, 'missing.jsonl'),
      linesRead: 0,
      pendingTasks: createTaskNotificationState(),
      onMessage: (msg) => messages.push(msg),
    });
    assert.deepEqual(messages, []);
  });

  it('_findLatestJsonl は更新日時が最も新しい .jsonl を返す（他の拡張子は新しくても見ない）', () => {
    const names = ['a.jsonl', 'b.jsonl', 'c.jsonl'];
    for (const n of names) writeFileSync(join(tmpDir, n), '{}');
    writeFileSync(join(tmpDir, 'z.txt'), 'x');
    const now = Date.now();
    utimesSync(join(tmpDir, 'z.txt'), new Date(now + 60000), new Date(now + 60000));
    for (const newest of names) {
      names.forEach((n, i) => {
        const at = n === newest ? now : now - (i + 1) * 10000;
        utimesSync(join(tmpDir, n), new Date(at), new Date(at));
      });
      assert.equal(watcher._findLatestJsonl(tmpDir), join(tmpDir, newest));
    }
  });

  it('_detectNewFile は更新からちょうど 10 秒経ったファイルを新しいセッションとみなさない', () => {
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, '{}\n');
    const at = Math.floor(Date.now() / 1000) * 1000 - 60000;
    utimesSync(filePath, new Date(at), new Date(at));
    vi.spyOn(Date, 'now').mockReturnValue(at + 10000);
    const state = {
      bridgeSessionId: 'b1',
      projectPath: tmpDir,
      targetFile: null,
      linesRead: 0,
      attachExisting: false,
      onMessage: () => {},
      fsWatcher: null,
      pollTimer: null,
    };
    watcher._detectNewFile(state);
    assert.equal(state.targetFile, null);
  });

  it('監視していない ID の stopWatching は何もしない', () => {
    assert.doesNotThrow(() => watcher.stopWatching('unknown'));
  });
});
