import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, stat, rm } from 'fs/promises';
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

  it('judges a nested subagent by the JSONL of the agent that spawned it', async () => {
    const { projectsDir, subagents } = await setupProject();
    // 孫の tool_result は本体ではなく、呼んだ側（チームメイト）の JSONL に書かれる
    await writeAgent(subagents, 'aimpl-1', { agentType: 'impl', description: '実装' }, [
      ...agentRecords,
      toolResult('toolu_nested_done'),
    ]);
    await writeAgent(
      subagents,
      'n1',
      { description: '終わった孫', toolUseId: 'toolu_nested_done', parentAgentId: 'aimpl-1' },
      agentRecords,
    );
    await writeAgent(
      subagents,
      'n2',
      { description: '動いている孫', toolUseId: 'toolu_nested_open', parentAgentId: 'aimpl-1' },
      agentRecords,
    );

    const tasks = await listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir });
    const statusOf = (id) => tasks.find((t) => t.agentId === id).status;
    assert.equal(statusOf('n1'), 'completed');
    assert.equal(statusOf('n2'), 'running');
  });

  it('falls back to the session JSONL when parentAgentId is not a valid agent id', async () => {
    const { projectsDir, subagents } = await setupProject({ parentRecords: [toolResult('toolu_bad_parent')] });
    await writeAgent(subagents, 'p1', {
      description: '不正な親 ID',
      toolUseId: 'toolu_bad_parent',
      parentAgentId: '../../etc/x',
    });

    const tasks = await listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir });
    assert.equal(tasks[0].status, 'completed');
  });

  it('reports completed when the meta says finished, even without a tool_result', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'f1', { description: '終了済み', toolUseId: 'toolu_nowhere', finished: true });

    const tasks = await listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir });
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

  it('reports completed when a background agent is reported via <task-notification>', async () => {
    const { projectsDir, subagents } = await setupProject({
      parentRecords: [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content:
            '<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n</task-notification>',
        },
      ],
    });
    await writeAgent(subagents, 'bg1', { agentType: 'general-purpose', toolUseId: 'toolu_bg' }, agentRecords);

    const tasks = await listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir });
    assert.equal(tasks[0].status, 'completed');
  });

  it('reports completed when the transcript ends with an end_turn answer but no caller result is found', async () => {
    const { projectsDir, subagents } = await setupProject();
    const finalAnswer = {
      type: 'assistant',
      isSidechain: true,
      uuid: 'a2',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '完了しました' }] },
    };
    // parentAgentId を持たない古い孫（spawnDepth: 2）の meta
    await writeAgent(subagents, 'orphan', { toolUseId: 'toolu_orphan', spawnDepth: 2 }, [...agentRecords, finalAnswer]);
    // 最後が tool_use の途中なら実行中のまま
    await writeAgent(subagents, 'midway', { toolUseId: 'toolu_midway' }, [finalAnswer, ...agentRecords]);

    const tasks = await listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir });
    const byId = Object.fromEntries(tasks.map((t) => [t.agentId, t.status]));
    assert.deepEqual(byId, { orphan: 'completed', midway: 'running' });
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

  it('usage のある assistant には contextUsage が付く（無い側には付かない）', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'usage 無し' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'usage あり' }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 },
        },
      }),
    ].join('\n');

    const messages = parseHistoryLines(content);
    assert.equal(messages[0].contextUsage, undefined);
    assert.equal(messages[1].contextUsage.contextTokens, 100);
    assert.equal(messages[1].contextUsage.contextWindow, 200_000);
  });

  it('loadSessionHistory returns [] for a missing file', async () => {
    assert.deepEqual(await loadSessionHistory('no-such-session', '-no-such-project'), []);
  });
});

// ---- ここから下はミューテーションテストで見つかった穴を埋めるもの ----

describe('listSubagentTasks (境界)', () => {
  const list = (projectsDir, extra = {}) =>
    listSubagentTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, projectsDir, ...extra });
  const finalAnswer = {
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '完了' }] },
  };

  it('projectDir・claudeSessionId が不正なら読まずに空配列', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'v1', { description: 'x' });
    assert.equal((await list(projectsDir)).length, 1);
    assert.deepEqual(await list(projectsDir, { projectDir: '' }), []);
    assert.deepEqual(await list(projectsDir, { projectDir: 42 }), []);
    assert.deepEqual(await list(projectsDir, { claudeSessionId: '../x' }), []);
    assert.deepEqual(await list(projectsDir, { claudeSessionId: 123 }), []);
    assert.deepEqual(await listSubagentTasks(), []);
  });

  it('agent-*.meta.json 以外のファイルと壊れた meta は無視する', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'ok', { agentType: 'Explore', description: '正しい' });
    await writeFile(join(subagents, 'other.meta.json'), JSON.stringify({ description: 'agent- で始まらない' }));
    await writeFile(join(subagents, 'agent-x.meta.json.bak'), JSON.stringify({ description: '拡張子違い' }));
    await writeFile(join(subagents, 'agent-broken.meta.json'), '{ broken');
    const tasks = await list(projectsDir);
    assert.deepEqual(
      tasks.map((t) => t.agentId),
      ['ok'],
    );
  });

  it('agentType・description が無ければ空文字', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'bare', {});
    const [task] = await list(projectsDir);
    assert.equal(task.agentType, '');
    assert.equal(task.description, '');
    assert.equal(task.status, 'completed');
  });

  it('更新時刻・サイズはトランスクリプトから、無ければ meta の更新時刻とサイズ 0', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 't1', { description: 'トランスクリプトあり' }, agentRecords);
    await writeFile(join(subagents, 'agent-t2.meta.json'), JSON.stringify({ description: 'meta だけ' }));
    const transcriptTime = new Date('2026-08-18T10:00:00.000Z');
    const metaTime = new Date('2026-08-17T10:00:00.000Z');
    await utimes(join(subagents, 'agent-t1.jsonl'), transcriptTime, transcriptTime);
    await utimes(join(subagents, 'agent-t1.meta.json'), metaTime, metaTime);
    await utimes(join(subagents, 'agent-t2.meta.json'), metaTime, metaTime);

    const tasks = await list(projectsDir);
    const byId = Object.fromEntries(tasks.map((t) => [t.agentId, t]));
    assert.equal(byId.t1.updatedAt, transcriptTime.toISOString());
    assert.equal(byId.t1.size, (await stat(join(subagents, 'agent-t1.jsonl'))).size);
    assert.equal(byId.t2.updatedAt, metaTime.toISOString());
    assert.equal(byId.t2.size, 0);
  });

  it('同じ状態の中では更新の新しい順に並べる', async () => {
    const { projectsDir, subagents } = await setupProject();
    const ids = ['old', 'new', 'mid'];
    const times = { old: '2026-08-01T00:00:00Z', new: '2026-08-03T00:00:00Z', mid: '2026-08-02T00:00:00Z' };
    for (const id of ids) {
      await writeAgent(subagents, `r-${id}`, { description: id, toolUseId: `toolu_${id}` }, agentRecords);
      await writeAgent(subagents, `c-${id}`, { description: id }, agentRecords);
      const t = new Date(times[id]);
      await utimes(join(subagents, `agent-r-${id}.jsonl`), t, t);
      await utimes(join(subagents, `agent-c-${id}.jsonl`), t, t);
    }
    const tasks = await list(projectsDir);
    assert.deepEqual(
      tasks.map((t) => t.agentId),
      ['r-new', 'r-mid', 'r-old', 'c-new', 'c-mid', 'c-old'],
    );
  });

  it('親 JSONL が無ければ実行中のまま（トランスクリプトの最後で判定する）', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject();
    await rm(parentJsonl);
    await writeAgent(subagents, 'np', { toolUseId: 'toolu_np' }, agentRecords);
    assert.equal((await list(projectsDir))[0].status, 'running');
  });

  it('親 JSONL の書きかけの行は改行が付くまで取り込まない', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject({
      parentRecords: [{ type: 'assistant', message: { role: 'assistant', content: '作業中' } }],
    });
    await writeAgent(subagents, 'w1', { toolUseId: 'toolu_partial' }, agentRecords);
    await appendFile(parentJsonl, JSON.stringify(toolResult('toolu_partial')));
    assert.equal((await list(projectsDir))[0].status, 'running');
    await appendFile(parentJsonl, '\n');
    assert.equal((await list(projectsDir))[0].status, 'completed');
  });

  it('改行の無い 1 行だけの親 JSONL も、改行が付けば読む', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject();
    await writeFile(parentJsonl, JSON.stringify(toolResult('toolu_single')));
    await writeAgent(subagents, 's1', { toolUseId: 'toolu_single' }, agentRecords);
    assert.equal((await list(projectsDir))[0].status, 'running');
    await appendFile(parentJsonl, '\n');
    assert.equal((await list(projectsDir))[0].status, 'completed');
  });

  it('親 JSONL が縮んだら先頭から読み直し、前の結果を捨てる', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject({
      parentRecords: [toolResult('toolu_gone'), toolResult('toolu_other')],
    });
    await writeAgent(subagents, 'sh', { toolUseId: 'toolu_gone' }, agentRecords);
    assert.equal((await list(projectsDir))[0].status, 'completed');
    await writeFile(parentJsonl, jsonl([toolResult('x')]));
    assert.equal((await list(projectsDir))[0].status, 'running');
  });

  it('tool_use_id のコロンの前後に空白があっても拾う', async () => {
    const { projectsDir, subagents, parentJsonl } = await setupProject();
    await writeFile(parentJsonl, '{"type":"user","tool_use_id" :  "toolu_spaced"}\n');
    await writeAgent(subagents, 'sp', { toolUseId: 'toolu_spaced' }, agentRecords);
    assert.equal((await list(projectsDir))[0].status, 'completed');
  });

  it('end_turn の判定は最後の非空行だけで見る（壊れた行・end_turn 以外・assistant 以外は実行中）', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'blank', { toolUseId: 'toolu_blank' });
    await writeFile(join(subagents, 'agent-blank.jsonl'), jsonl([...agentRecords, finalAnswer]) + '\n\n  \n');
    await writeAgent(subagents, 'broken', { toolUseId: 'toolu_broken' });
    await writeFile(join(subagents, 'agent-broken.jsonl'), jsonl([finalAnswer]) + '{ broken\n');
    await writeAgent(subagents, 'tooluse', { toolUseId: 'toolu_tooluse' }, [
      { ...finalAnswer, message: { ...finalAnswer.message, stop_reason: 'tool_use' } },
    ]);
    await writeAgent(subagents, 'user', { toolUseId: 'toolu_user' }, [
      { type: 'user', message: { role: 'user', stop_reason: 'end_turn', content: 'x' } },
    ]);
    await writeAgent(subagents, 'nomsg', { toolUseId: 'toolu_nomsg' }, [{ type: 'assistant' }]);
    await writeAgent(subagents, 'empty', { toolUseId: 'toolu_empty' }, []);
    await writeFile(join(subagents, 'agent-empty.jsonl'), '');
    await writeFile(join(subagents, 'agent-notranscript.meta.json'), JSON.stringify({ toolUseId: 'toolu_nt' }));

    const tasks = await list(projectsDir);
    const byId = Object.fromEntries(tasks.map((t) => [t.agentId, t.status]));
    assert.deepEqual(byId, {
      blank: 'completed',
      broken: 'running',
      tooluse: 'running',
      user: 'running',
      nomsg: 'running',
      empty: 'running',
      notranscript: 'running',
    });
  });

  it('トランスクリプトが 64KB を超えても末尾の最終回答で完了と判定する', async () => {
    const { projectsDir, subagents } = await setupProject();
    const big = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100 * 1024) }] },
    };
    await writeAgent(subagents, 'big', { toolUseId: 'toolu_big' }, [big, finalAnswer]);
    await writeAgent(subagents, 'bigtail', { toolUseId: 'toolu_bigtail' }, [finalAnswer, big]);
    const tasks = await list(projectsDir);
    const byId = Object.fromEntries(tasks.map((t) => [t.agentId, t.status]));
    assert.deepEqual(byId, { big: 'completed', bigtail: 'running' });
  });

  it('トランスクリプトに最終回答が追記されたら完了に変わる', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'grow', { toolUseId: 'toolu_grow' }, agentRecords);
    assert.equal((await list(projectsDir))[0].status, 'running');
    await appendFile(join(subagents, 'agent-grow.jsonl'), jsonl([finalAnswer]));
    assert.equal((await list(projectsDir))[0].status, 'completed');
  });
});

describe('readSubagentTranscript (境界)', () => {
  it('projectDir・claudeSessionId が不正なら null', async () => {
    const { projectsDir, subagents } = await setupProject();
    await writeAgent(subagents, 'ok', {}, agentRecords);
    const base = { projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, agentId: 'ok', projectsDir };
    assert.equal((await readSubagentTranscript(base)).length, 2);
    assert.equal(await readSubagentTranscript({ ...base, projectDir: '' }), null);
    assert.equal(await readSubagentTranscript({ ...base, claudeSessionId: 'a/b' }), null);
    assert.equal(await readSubagentTranscript({ ...base, agentId: 42 }), null);
    assert.equal(await readSubagentTranscript(), null);
  });
});
