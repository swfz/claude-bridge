import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryLines } from '../server/claude-sessions.js';
import { taskDetailText, taskKindOf, taskMetaText, taskStatusLabel } from '../client/src/utils/taskNotifications.js';

const NOTE =
  '<task-notification>\n<task-id>bg4</task-id>\n<status>failed</status>\n<summary>Background command "x" failed with exit code 144</summary>\n</task-notification>';

describe('parseHistoryLines のタスク通知', () => {
  it('enqueue と後の user レコードで二重にならず、role: task の 1 件になる', () => {
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', content: NOTE, timestamp: 't1' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: 't2' },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: 't3',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: NOTE },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const messages = parseHistoryLines(lines);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'task');
    assert.equal(messages[0].tasks[0].status, 'failed');
  });

  it('タスク通知以外の enqueue は従来どおり human', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '途中で送った指示',
      timestamp: 't',
    });
    assert.deepEqual(
      parseHistoryLines(line).map((m) => [m.role, m.content]),
      [['human', '途中で送った指示']],
    );
  });
});

describe('parseHistoryLines の処理待ちに積まれたサブエージェントの報告', () => {
  const BODY =
    '[Subagent hand-back] The text below is the final report of a subagent.\nThe report follows:\n  レビュー結果です。\n    - 問題なし';
  const ENQ = `<agent-message from="a1">\n${BODY}\n</agent-message>`;
  const launch = [
    {
      type: 'assistant',
      uuid: 'as1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'code-reviewer' } }],
      },
    },
    {
      type: 'user',
      uuid: 'r1',
      toolUseResult: { agentId: 'a1', status: 'async_launched' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'launched' }] },
    },
  ];
  const peer = {
    type: 'user',
    uuid: 'p1',
    timestamp: 't3',
    origin: { kind: 'peer', from: 'a1', name: 'code-reviewer', handback: true, body: BODY },
    message: { role: 'user', content: `Another Claude session sent a message:\n${ENQ}` },
  };
  const humans = (records) =>
    parseHistoryLines(records.map((r) => JSON.stringify(r)).join('\n')).filter((m) => m.role === 'human');

  it('enqueue は Subagent の報告（本文だけ・種別名付き）になり、後の user レコードは捨てる', () => {
    const got = humans([
      ...launch,
      { type: 'queue-operation', operation: 'enqueue', content: ENQ, timestamp: 't1' },
      { type: 'queue-operation', operation: 'remove', content: ENQ, timestamp: 't2' },
      { type: 'queue-operation', operation: 'enqueue', content: ENQ, timestamp: 't2' },
      peer,
    ]);
    assert.equal(got.length, 1);
    assert.equal(got[0].content, 'レビュー結果です。\n  - 問題なし');
    assert.deepEqual(got[0].sender, { kind: 'subagent', name: 'code-reviewer' });
    assert.equal(got[0].injected, true);
  });

  it('enqueue にしか残らない報告も出す', () => {
    const got = humans([{ type: 'queue-operation', operation: 'enqueue', content: ENQ, timestamp: 't1' }]);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].sender, { kind: 'subagent' });
  });

  it('enqueue の無い報告は従来どおり user レコードから出す', () => {
    const got = humans([peer]);
    assert.equal(got.length, 1);
    assert.equal(got[0].uuid, 'p1');
    assert.equal(got[0].sender.kind, 'subagent');
  });

  it('同じエージェントでも本文が違う報告はそれぞれ出す', () => {
    const other = { ...peer, uuid: 'p2', origin: { ...peer.origin, body: `${BODY}\n  追記` } };
    const got = humans([{ type: 'queue-operation', operation: 'enqueue', content: ENQ }, peer, other]);
    assert.deepEqual(
      got.map((m) => m.uuid),
      [undefined, 'p2'],
    );
  });
});

describe('タスク通知の表示用の整形', () => {
  it('summary の定型文で種類を見分ける', () => {
    assert.equal(taskKindOf({ summary: 'Agent "x" finished' }), 'agent');
    assert.equal(taskKindOf({ summary: 'Background command "x" was stopped' }), 'shell');
    assert.equal(taskKindOf({ summary: "Background shell command didn't finish" }), 'shell');
    assert.equal(taskKindOf({ summary: 'Monitor event: "CI"' }), 'monitor');
    assert.equal(taskKindOf({ status: 'event', summary: '' }), 'monitor');
    assert.equal(taskKindOf({ summary: '?' }), 'other');
  });

  it('完了は印を出さず、失敗・停止だけ出す', () => {
    assert.equal(taskStatusLabel('completed'), '');
    assert.equal(taskStatusLabel('failed'), '失敗');
    assert.equal(taskStatusLabel('killed'), '停止');
    assert.equal(taskStatusLabel('stopped'), '停止');
  });

  it('所要時間・ツール数・トークンをまとめる（無いものは出さない）', () => {
    assert.equal(taskMetaText({ durationMs: 108907, toolUses: 12, tokens: 84060 }), '2 分 · ツール 12 · 84.1k tokens');
    assert.equal(taskMetaText({ durationMs: null, toolUses: null, tokens: null }), '');
  });

  it('詳細は Monitor のイベントか意味のある result だけ', () => {
    assert.equal(taskDetailText({ event: 'line1' }), 'line1');
    assert.equal(taskDetailText({ result: "This agent's report was delivered to you as a message" }), '');
    assert.equal(taskDetailText({ result: 'exit 1: boom' }), 'exit 1: boom');
    assert.equal(taskDetailText({}), '');
  });
});
