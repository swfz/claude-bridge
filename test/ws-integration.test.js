import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { listShellTasks, readShellTaskOutput, shellTasksDir } from '../server/shell-tasks.js';

// index.js の全体起動は避け、WebSocket メッセージルーティングの
// コア部分を再現してテスト

function setupTestServer({ shellTarget = null } = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sessions = new Map();
  let messageLog = [];

  wss.on('connection', (ws) => {
    // 接続時にセッション一覧を送信
    ws.send(
      JSON.stringify({
        type: 'session_list',
        sessions: Array.from(sessions.values()),
      }),
    );

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      messageLog.push(msg);

      switch (msg.type) {
        case 'new_session': {
          const id = `test-${Date.now()}`;
          const session = {
            id,
            name: msg.name || 'Test',
            cwd: msg.cwd || '/tmp',
            alive: true,
          };
          sessions.set(id, session);

          // broadcast
          const list = JSON.stringify({
            type: 'session_list',
            sessions: Array.from(sessions.values()),
          });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(list);
            }
          }
          break;
        }

        // シェル出力の 2 メッセージは index.js と同じ形（読み先はテスト側が固定で渡す）
        case 'list_shell_tasks': {
          (async () => {
            const tasks = shellTarget ? await listShellTasks(shellTarget) : [];
            ws.send(JSON.stringify({ type: 'shell_tasks', sessionId: msg.sessionId, tasks }));
          })();
          break;
        }

        case 'get_shell_task_output': {
          (async () => {
            const output = shellTarget ? await readShellTaskOutput({ ...shellTarget, taskId: msg.taskId }) : null;
            ws.send(
              JSON.stringify(
                output
                  ? { type: 'shell_task_output', sessionId: msg.sessionId, ...output }
                  : {
                      type: 'shell_task_output',
                      sessionId: msg.sessionId,
                      taskId: msg.taskId,
                      status: null,
                      text: '',
                      error: 'シェル出力を読み込めませんでした。',
                    },
              ),
            );
          })();
          break;
        }

        case 'kill_session': {
          sessions.delete(msg.sessionId);
          const list = JSON.stringify({
            type: 'session_list',
            sessions: Array.from(sessions.values()),
          });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(list);
            }
          }
          break;
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({
        server,
        wss,
        port,
        messageLog,
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
  });
}

function connectClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const received = [];
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => {
      resolve({ ws, received });
    });
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WebSocket message routing', () => {
  let testServer;

  afterEach(() => {
    if (testServer) testServer.close();
  });

  it('sends session_list on connect', async () => {
    testServer = await setupTestServer();
    const { ws, received } = await connectClient(testServer.port);

    await wait(50);

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'session_list');
    assert.deepEqual(received[0].sessions, []);

    ws.close();
  });

  it('new_session creates session and broadcasts', async () => {
    testServer = await setupTestServer();
    const { ws, received } = await connectClient(testServer.port);

    await wait(50);
    ws.send(JSON.stringify({ type: 'new_session', name: 'Test Session', cwd: '/home' }));
    await wait(50);

    // 初回の session_list + new_session 後の session_list
    const sessionLists = received.filter((m) => m.type === 'session_list');
    assert.ok(sessionLists.length >= 2);

    const latest = sessionLists[sessionLists.length - 1];
    assert.equal(latest.sessions.length, 1);
    assert.equal(latest.sessions[0].name, 'Test Session');
    assert.equal(latest.sessions[0].cwd, '/home');

    ws.close();
  });

  it('kill_session removes session and broadcasts', async () => {
    testServer = await setupTestServer();
    const { ws, received } = await connectClient(testServer.port);

    await wait(50);
    ws.send(JSON.stringify({ type: 'new_session', name: 'ToKill' }));
    await wait(50);

    const afterCreate = received.filter((m) => m.type === 'session_list');
    const sessionId = afterCreate[afterCreate.length - 1].sessions[0].id;

    ws.send(JSON.stringify({ type: 'kill_session', sessionId }));
    await wait(50);

    const afterKill = received.filter((m) => m.type === 'session_list');
    const latest = afterKill[afterKill.length - 1];
    assert.equal(latest.sessions.length, 0);

    ws.close();
  });

  it('multiple clients receive broadcasts', async () => {
    testServer = await setupTestServer();
    const client1 = await connectClient(testServer.port);
    const client2 = await connectClient(testServer.port);

    await wait(50);
    client1.ws.send(JSON.stringify({ type: 'new_session', name: 'Shared' }));
    await wait(50);

    // 両方のクライアントが session_list を受信
    const lists1 = client1.received.filter((m) => m.type === 'session_list');
    const lists2 = client2.received.filter((m) => m.type === 'session_list');

    assert.ok(lists1.length >= 2); // initial + after create
    assert.ok(lists2.length >= 2); // initial + broadcast

    const latest1 = lists1[lists1.length - 1];
    const latest2 = lists2[lists2.length - 1];
    assert.equal(latest1.sessions.length, 1);
    assert.equal(latest2.sessions.length, 1);
    assert.equal(latest1.sessions[0].name, 'Shared');

    client1.ws.close();
    client2.ws.close();
  });

  it('server logs received messages', async () => {
    testServer = await setupTestServer();
    const { ws } = await connectClient(testServer.port);

    await wait(50);
    ws.send(JSON.stringify({ type: 'new_session', name: 'Logged' }));
    await wait(50);

    assert.ok(testServer.messageLog.length >= 1);
    assert.equal(testServer.messageLog[0].type, 'new_session');
    assert.equal(testServer.messageLog[0].name, 'Logged');

    ws.close();
  });
});

// シェル出力の一覧・本文取得を WS 越しに一往復させる（メッセージの形の確認）
async function setupShellFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'ws-shell-root-'));
  const projectsDir = await mkdtemp(join(tmpdir(), 'ws-shell-projects-'));
  const projectDir = '-home-user-proj';
  const claudeSessionId = 'ws-shell-session';
  const tasksDir = shellTasksDir({ projectDir, claudeSessionId, rootDir });
  await mkdir(tasksDir, { recursive: true });
  await mkdir(join(projectsDir, projectDir), { recursive: true });
  await writeFile(join(projectsDir, projectDir, `${claudeSessionId}.jsonl`), '');
  await writeFile(join(tasksDir, 'wsjob1.output'), 'compiling\n[exited with code 0]\n');
  return { projectDir, claudeSessionId, rootDir, projectsDir };
}

describe('shell task messages', () => {
  let testServer;

  afterEach(() => {
    if (testServer) testServer.close();
  });

  it('list_shell_tasks returns the tasks found on disk', async () => {
    testServer = await setupTestServer({ shellTarget: await setupShellFixture() });
    const { ws, received } = await connectClient(testServer.port);

    await wait(50);
    ws.send(JSON.stringify({ type: 'list_shell_tasks', sessionId: 'sess-1' }));
    await wait(100);

    const reply = received.find((m) => m.type === 'shell_tasks');
    assert.ok(reply);
    assert.equal(reply.sessionId, 'sess-1');
    assert.equal(reply.tasks.length, 1);
    assert.equal(reply.tasks[0].taskId, 'wsjob1');
    assert.equal(reply.tasks[0].status, 'exited');
    assert.equal(reply.tasks[0].exitCode, 0);

    ws.close();
  });

  it('get_shell_task_output returns the body without the exit footer', async () => {
    testServer = await setupTestServer({ shellTarget: await setupShellFixture() });
    const { ws, received } = await connectClient(testServer.port);

    await wait(50);
    ws.send(JSON.stringify({ type: 'get_shell_task_output', sessionId: 'sess-1', taskId: 'wsjob1' }));
    await wait(100);

    const reply = received.find((m) => m.type === 'shell_task_output');
    assert.ok(reply);
    assert.equal(reply.taskId, 'wsjob1');
    assert.equal(reply.status, 'exited');
    assert.equal(reply.text, 'compiling\n');

    ws.close();
  });
});
