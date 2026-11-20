import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  activeChoiceOf,
  backgroundLabel,
  clearObservedPending,
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
  it('自動コンパクトの要約はターンの区切りにしない', () => {
    const msgs = [
      { role: 'human', timestamp: iso(T0) },
      { role: 'assistant', timestamp: iso(T0 + 1000), toolUses: [{ id: 'a', name: 'Bash' }] },
      { role: 'human', timestamp: iso(T0 + 2000), sender: { kind: 'compact' } },
    ];
    assert.equal(turnStartOf(msgs), T0);
    assert.equal(runningToolOf(msgs)?.id, 'a');
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
  it('送信後に応答が届いても busy を観測するまでは出し続ける（消えて出直す点滅を防ぐ）', () => {
    const replied = [...msgs, { role: 'assistant', timestamp: iso(T0 + 500), toolUses: [{ id: 't1', name: 'Bash' }] }];
    const state = workingStateOf({ status: 'idle', messages: replied, pendingSince: T0, now: T0 + 1000 });
    assert.equal(state?.mode, 'turn');
    assert.equal(state?.tool?.name, 'Bash');
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
  it('shell の間に送信したら猶予の間は先回りの turn を優先し、切れたら background に戻る', () => {
    assert.equal(workingStateOf({ status: 'shell', messages: msgs, pendingSince: T0, now: T0 + 1000 })?.mode, 'turn');
    assert.equal(
      workingStateOf({ status: 'shell', messages: msgs, pendingSince: T0, now: T0 + PENDING_GRACE_MS })?.mode,
      'background',
    );
  });
});

describe('clearObservedPending', () => {
  it('busy・待ちになったセッションの先回りだけ消す', () => {
    const prev = { a: 1, b: 2, c: 3, d: 4 };
    const sessions = [
      { id: 'a', status: 'busy' },
      { id: 'b', status: 'idle' },
      { id: 'c', status: 'waiting' },
      { id: 'd', status: 'idle', waitingFor: 'permission prompt' },
    ];
    assert.deepEqual(clearObservedPending(prev, sessions), { b: 2 });
    assert.deepEqual(prev, { a: 1, b: 2, c: 3, d: 4 });
  });
  it('消すものが無ければ同じ参照を返す', () => {
    const prev = { a: 1 };
    assert.equal(
      clearObservedPending(prev, [
        { id: 'a', status: 'idle' },
        { id: 'x', status: 'busy' },
      ]),
      prev,
    );
    assert.equal(clearObservedPending(prev, null), prev);
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

describe('activeChoiceOf', () => {
  it('待ちが解けた後の {prompt: null, waitingFor: null} はカード無し（インジケータを隠さない）', () => {
    assert.equal(activeChoiceOf({ prompt: null, waitingFor: null }), null);
    assert.equal(activeChoiceOf(undefined), null);
  });
  it('選択肢があるか、待っているのに読めなかったときはカードを出す', () => {
    const withPrompt = { prompt: { question: 'q', options: [] }, waitingFor: 'input needed' };
    assert.equal(activeChoiceOf(withPrompt), withPrompt);
    const unread = { prompt: null, waitingFor: 'permission prompt' };
    assert.equal(activeChoiceOf(unread), unread);
  });
});

describe('working: 欠けた入力と境界', () => {
  it('先頭のメッセージのツールも実行中として拾う', () => {
    const t = { id: 't1', name: 'Bash' };
    assert.equal(runningToolOf([{ role: 'assistant', toolUses: [t] }]), t);
  });

  it('欠けたメッセージ・結果・ツールが混ざっていても実行中のツールを拾う', () => {
    const t = { id: 't2', name: 'Read' };
    const messages = [
      { role: 'human', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', toolUses: [t, null] },
      null,
      { role: 'toolresult', results: [null, { id: 'x' }] },
    ];
    assert.equal(runningToolOf(messages), t);
  });

  it('assistant 以外のメッセージのツールは見ない', () => {
    assert.equal(runningToolOf([{ role: 'system', toolUses: [{ id: 't' }] }]), null);
  });

  it('turnStartOf: 一覧でなければ null、時刻の無い指示も null、欠けた要素は飛ばす', () => {
    assert.equal(turnStartOf(null), null);
    assert.equal(turnStartOf([{ role: 'human' }]), null);
    assert.equal(
      turnStartOf([{ role: 'human', timestamp: '2026-01-01T00:00:00Z' }, null]),
      Date.parse('2026-01-01T00:00:00Z'),
    );
  });

  it('status が waiting なら送信直後でも出さない', () => {
    const now = 100_000;
    assert.equal(workingStateOf({ status: 'waiting', messages: [], pendingSince: now - 100, now }), null);
  });

  it('busy で指示の時刻が無ければ、送信時刻ではなく経過時間なしにする', () => {
    const now = 100_000;
    assert.equal(workingStateOf({ status: 'busy', messages: [], pendingSince: now - 100, now }).since, null);
    assert.equal(workingStateOf({ status: 'busy', messages: [], now }).since, null);
  });

  it('送信直後で指示の時刻がまだ無ければ、送信時刻から数える', () => {
    const now = 100_000;
    assert.equal(workingStateOf({ status: 'idle', messages: [], pendingSince: now - 100, now }).since, now - 100);
  });

  it('formatElapsed の繰り上がりの境界', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(60_000), '1m 0s');
    assert.equal(formatElapsed(3_600_000), '1h 0m');
  });
});
