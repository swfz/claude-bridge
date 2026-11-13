import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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
    assert.deepEqual(workingStateOf({ status: 'busy', messages: msgs, now: T0 + 5000 }), { tool: null, since: T0 });
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

describe('formatElapsed', () => {
  it('秒・分・時間', () => {
    assert.equal(formatElapsed(12_300), '12s');
    assert.equal(formatElapsed(125_000), '2m 5s');
    assert.equal(formatElapsed(3_725_000), '1h 2m');
    assert.equal(formatElapsed(-1), '');
  });
});
