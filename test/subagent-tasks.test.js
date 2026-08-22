import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSubagentTasks, readSubagentTranscript } from '../server/subagent-tasks.js';
import { loadSessionHistory, parseHistoryLines } from '../server/claude-sessions.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_DIR = '-home-user-proj';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// projectsDir/<projectDir>/<sessionId>/subagents/ を用意する
async function setupProject({ parentRecords = [] } = {}) {
  const projectsDir = await mkdtemp(join(tmpdir(), 'subagent-tasks-'));
  const projectPath = join(projectsDir, PROJECT_DIR);
  const subagents = join(projectPath, SESSION_ID, 'subagents');
  await mkdir(subagents, { recursive: true });
  const parentJsonl = join(projectPath, `${SESSION_ID}.jsonl`);
  await writeFile(parentJsonl, jsonl(parentRecords));
  return { projectsDir, subagents, parentJsonl };
}

async function writeAgent(subagents, agentId, meta, records = []) {
  await writeFile(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  await writeFile(join(subagents, `agent-${agentId}.jsonl`), jsonl(records));
}

// 親 JSONL に書かれる tool_result（サブエージェント完了の印）
const toolResult = (toolUseId) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
  },
});

const agentRecords = [
  {
    type: 'user',
    isSidechain: true,
    uuid: 'u1',
    timestamp: '2026-08-18T10:00:00.000Z',
    message: { role: 'user', content: 'レビューしてください' },
  },
  {
    type: 'assistant',
    isSidechain: true,
    uuid: 'a1',
    timestamp: '2026-08-18T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '見ました' },
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a/b.js' } },
      ],
    },
  },
];

describe('listSubagentTasks', () => {
  it('returns an empty array when there is no subagents directory', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'subagent-tasks-'));
    const tasks = await listSubagentTasks({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    });
    assert.deepEqual(tasks, []);
  });

  it('reports running while the parent JSONL has no matching tool_result', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(
      subagents,
      'ac2af120c7bf76371',
      {
        agentType: 'general-purpose',
        description: 'テストを書く',
        toolUseId: 'toolu_running',
      },
      agentRecords,
    );

    const tasks = await listSubagentTasks({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].agentId, 'ac2af120c7bf76371');
    assert.equal(tasks[0].agentType, 'general-purpose');
    assert.equal(tasks[0].description, 'テストを書く');
    assert.equal(tasks[0].status, 'running');
    assert.ok(tasks[0].size > 0);
    assert.ok(tasks[0].updatedAt);
  });

  it('reports completed when the parent JSONL has the tool_use_id', async () => {
    const { projectsDir, subagents } = await setupProject({
      parentRecords: [toolResult('toolu_done')],
    });
    await writeAgent(
      subagents,
      'b1',
      { agentType: 'Explore', description: '探索', toolUseId: 'toolu_done' },
      agentRecords,
    );

    const tasks = await listSubagentTasks({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    });
    assert.equal(tasks[0].status, 'completed');
  });

  it('picks up a tool_result appended after the first call (incremental scan)', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject({
      parentRecords: [{ type: 'assistant', message: { role: 'assistant', content: '作業中' } }],
    });
    await writeAgent(
      subagents,
      'c1',
      { agentType: 'general-purpose', description: '後で終わる', toolUseId: 'toolu_later' },
      agentRecords,
    );
    const target = {
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    };

    const first = await listSubagentTasks(target);
    assert.equal(first[0].status, 'running');

    await appendFile(parentJsonl, jsonl([toolResult('toolu_later')]));

    const second = await listSubagentTasks(target);
    assert.equal(second[0].status, 'completed');
  });

  it('does not lose appended tool_results when polled concurrently', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject({
      parentRecords: [{ type: 'assistant', message: { role: 'assistant', content: 'しばらく作業中です。'.repeat(5) } }],
    });
    await writeAgent(subagents, 'g1', { description: '並行ポーリング', toolUseId: 'toolu_race' }, agentRecords);
    const target = {
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    };

    // 一覧（5秒）とドロワー（4秒）のポーリングが同じ親 JSONL を同時に読む状況。
    // 直列化していないと offset が二重に進み、この後の追記分に未走査領域ができる
    const [first, second] = await Promise.all([listSubagentTasks(target), listSubagentTasks(target)]);
    assert.equal(first[0].status, 'running');
    assert.equal(second[0].status, 'running');

    const padded = toolResult('toolu_race');
    padded.message.content[0].content = 'done '.repeat(200);
    await appendFile(parentJsonl, jsonl([padded]));

    const after = await listSubagentTasks(target);
    assert.equal(after[0].status, 'completed');
  });

  it('puts running tasks first, then the most recently updated', async () => {
    const { projectsDir, subagents } = await setupProject({
      parentRecords: [toolResult('toolu_done1'), toolResult('toolu_done2')],
    });
    await writeAgent(subagents, 'd1', { description: '完了1', toolUseId: 'toolu_done1' }, agentRecords);
    await writeAgent(subagents, 'd2', { description: '完了2', toolUseId: 'toolu_done2' }, agentRecords);
    await writeAgent(subagents, 'd3', { description: '実行中', toolUseId: 'toolu_open' }, agentRecords);

    const tasks = await listSubagentTasks({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    });
    assert.equal(tasks[0].description, '実行中');
    assert.deepEqual(
      tasks.slice(1).map((t) => t.status),
      ['completed', 'completed'],
    );
  });

  it('treats a meta without toolUseId as completed (old format)', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'e1', { agentType: 'general-purpose', description: '旧形式' }, agentRecords);

    const tasks = await listSubagentTasks({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      projectsDir,
    });
    assert.equal(tasks[0].status, 'completed');
  });
});

describe('readSubagentTranscript', () => {
  it('parses user and assistant messages like the session history', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(
      subagents,
      'f1',
      { agentType: 'general-purpose', description: '会話', toolUseId: 'toolu_x' },
      agentRecords,
    );

    const messages = await readSubagentTranscript({
      projectDir: PROJECT_DIR,
      claudeSessionId: SESSION_ID,
      agentId: 'f1',
      projectsDir,
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'human');
    assert.equal(messages[0].content, 'レビューしてください');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, '見ました');
    assert.equal(messages[1].toolUses.length, 1);
    assert.equal(messages[1].toolUses[0].name, 'Read');
  });

  it('rejects an agentId that could escape the subagents directory', async () => {
    const { projectsDir } = await setupProject();
    for (const agentId of ['../../etc/passwd', 'a/b', 'a.b', '']) {
      assert.equal(
        await readSubagentTranscript({
          projectDir: PROJECT_DIR,
          claudeSessionId: SESSION_ID,
          agentId,
          projectsDir,
        }),
        null,
      );
    }
  });

  it('returns null when the transcript does not exist', async () => {
    const { projectsDir } = await setupProject();
    assert.equal(
      await readSubagentTranscript({
        projectDir: PROJECT_DIR,
        claudeSessionId: SESSION_ID,
        agentId: 'nope',
        projectsDir,
      }),
      null,
    );
  });
});

describe('parseHistoryLines (loadSessionHistory との共通化)', () => {
  it('keeps the existing behaviour: user/assistant/queue-operation and broken lines', () => {
    const content = [
      '{ broken',
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: '依頼' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', uuid: 'q1', content: 'あとで' }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: '了解' }] },
      }),
      JSON.stringify({ type: 'summary', summary: '無視される' }),
      '',
    ].join('\n');

    const messages = parseHistoryLines(content);
    assert.deepEqual(
      messages.map((m) => [m.role, m.content]),
      [
        ['human', '依頼'],
        ['human', 'あとで'],
        ['assistant', '了解'],
      ],
    );
    assert.equal(messages[0].uuid, 'u1');
    assert.equal(messages[0].timestamp, 't1');
  });

  it('loadSessionHistory returns [] for a missing file', async () => {
    assert.deepEqual(await loadSessionHistory('no-such-session', '-no-such-project'), []);
  });
});
