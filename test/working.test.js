import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundLabel,
  runningToolOf,
  turnStartOf,
  workingStateOf,
  formatElapsed,
  PENDING_GRACE_MS,
} from '../client/src/utils/working.js';

const T0 = Date.parse('2026-11-13T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

describe('runningToolOf', () => {
  it('tool_result の返っていない最後のツールを返す', () => {
    const msgs = [
      { role: 'human', content: 'x' },
      {
        role: 'assistant',
        toolUses: [
          { id: 'a', name: 'Read' },
          { id: 'b', name: 'Bash' },
        ],
      },
      { role: 'toolresult', results: [{ id: 'a' }] },
    ];
    assert.equal(runningToolOf(msgs)?.id, 'b');
  });
  it('全部返っていれば null', () => {
    const msgs = [
      { role: 'assistant', toolUses: [{ id: 'a', name: 'Read' }] },
      { role: 'toolresult', results: [{ id: 'a' }] },
    ];
    assert.equal(runningToolOf(msgs), null);
  });
  it('並列に呼んだツールは先に終わった方を見て実行中を見失わない', () => {
    const msgs = [
      { role: 'human', content: 'x' },
      { role: 'assistant', toolUses: [{ id: 'a', name: 'Agent' }] },
      { role: 'assistant', toolUses: [{ id: 'b', name: 'Bash' }] },
      { role: 'toolresult', results: [{ id: 'b' }] },
    ];
    assert.equal(runningToolOf(msgs)?.id, 'a');
  });
  it('human より前は見ない', () => {
    const msgs = [
      { role: 'assistant', toolUses: [{ id: 'a', name: 'Read' }] },
      { role: 'human', content: 'x' },
    ];
    assert.equal(runningToolOf(msgs), null);
    assert.equal(runningToolOf(undefined), null);
  });
});

describe('turnStartOf', () => {
  it('最後の human の時刻', () => {
    const msgs = [
      { role: 'human', timestamp: iso(T0) },
      { role: 'assistant', timestamp: iso(T0 + 1000) },
      { role: 'human', timestamp: iso(T0 + 2000) },
    ];
    assert.equal(turnStartOf(msgs), T0 + 2000);
    assert.equal(turnStartOf([]), null);
  });
});

describe('workingStateOf', () => {
  const msgs = [{ role: 'human', timestamp: iso(T0) }];
  it('busy なら出す', () => {
    assert.deepEqual(workingStateOf({ status: 'busy', messages: msgs, now: T0 + 5000 }), {
      mode: 'turn',
      animated: true,
      tool: null,
      since: T0,
      background: null,
    });
  });
  it('idle で送信もしていなければ出さない', () => {
    assert.equal(workingStateOf({ status: 'idle', messages: msgs, now: T0 }), null);
  });
  it('待ちの間は出さない', () => {
    assert.equal(workingStateOf({ status: 'busy', waitingFor: 'permission prompt', messages: msgs }), null);
    assert.equal(workingStateOf({ status: 'waiting', messages: msgs }), null);
  });
  it('送信直後は busy になる前でも猶予の間だけ出す', () => {
    assert.ok(workingStateOf({ status: 'idle', messages: msgs, pendingSince: T0, now: T0 + 1000 }));
    assert.equal(
      workingStateOf({ status: 'idle', messages: msgs, pendingSince: T0, now: T0 + PENDING_GRACE_MS }),
      null,
    );
  });
  it('送信後に応答が来ていれば猶予中でも出さない', () => {
    const replied = [...msgs, { role: 'assistant', timestamp: iso(T0 + 500) }];
    assert.equal(workingStateOf({ status: 'idle', messages: replied, pendingSince: T0, now: T0 + 1000 }), null);
  });
  it('実行中ツールを返す', () => {
    const m = [...msgs, { role: 'assistant', toolUses: [{ id: 'x', name: 'Bash' }] }];
    assert.equal(workingStateOf({ status: 'busy', messages: m, now: T0 })?.tool?.name, 'Bash');
  });
});

describe('workingStateOf（裏で実行中）', () => {
  const msgs = [{ role: 'human', timestamp: iso(T0) }];
  it('status が shell なら background で件数を返す', () => {
    assert.deepEqual(
      workingStateOf({ status: 'shell', messages: msgs, background: { agents: 2, shells: 1 }, now: T0 }),
      { mode: 'background', animated: true, tool: null, since: null, background: { agents: 2, shells: 1 } },
    );
  });
  it('シェルだけなら記号を動かさない', () => {
    const state = workingStateOf({ status: 'shell', messages: msgs, background: { agents: 0, shells: 1 } });
    assert.equal(state?.mode, 'background');
    assert.equal(state?.animated, false);
  });
  it('件数が分からなくても shell なら出す', () => {
    assert.deepEqual(workingStateOf({ status: 'shell', messages: msgs })?.background, { agents: 0, shells: 0 });
  });
  it('shell の間に送信したら先回りの turn を優先し、応答が来たら background に戻る', () => {
    assert.equal(workingStateOf({ status: 'shell', messages: msgs, pendingSince: T0, now: T0 + 1000 })?.mode, 'turn');
    const replied = [...msgs, { role: 'assistant', timestamp: iso(T0 + 500) }];
    assert.equal(
      workingStateOf({ status: 'shell', messages: replied, pendingSince: T0, now: T0 + 1000 })?.mode,
      'background',
    );
  });
});

describe('backgroundLabel', () => {
  it('内訳を並べる', () => {
    assert.equal(backgroundLabel({ agents: 2, shells: 1 }), 'サブエージェント 2 · シェル 1');
    assert.equal(backgroundLabel({ agents: 0, shells: 3 }), 'シェル 3');
    assert.equal(backgroundLabel({ agents: 0, shells: 0 }), '');
    assert.equal(backgroundLabel(null), '');
  });
});

describe('formatElapsed', () => {
  it('秒・分・時間', () => {
    assert.equal(formatElapsed(12_300), '12s');
    assert.equal(formatElapsed(125_000), '2m 5s');
    assert.equal(formatElapsed(3_725_000), '1h 2m');
    assert.equal(formatElapsed(-1), '');
  });
});
