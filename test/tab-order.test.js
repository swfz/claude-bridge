import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  applyTabOrder,
  moveTab,
  tabKeyOf,
  loadTabOrder,
  saveTabOrder,
  TAB_ORDER_KEY,
} from '../client/src/utils/tabOrder.js';

// localStorage の代わり。fail なら読み書きで例外を投げる（private window 等）
function withStorage(fn, { fail = false } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => {
      if (fail) throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (fail) throw new Error('quota');
      store.set(k, String(v));
    },
  };
  try {
    return fn(store);
  } finally {
    delete globalThis.localStorage;
  }
}

const s = (id, claudeSessionId) => ({ id, claudeSessionId });

describe('tabKeyOf', () => {
  it('prefers claudeSessionId', () => {
    assert.equal(tabKeyOf(s('a', 'c1')), 'c1');
    assert.equal(tabKeyOf(s('a')), 'a');
    assert.equal(tabKeyOf(null), null);
  });
});

describe('applyTabOrder', () => {
  it('returns as-is without order', () => {
    const list = [s('a'), s('b')];
    assert.equal(applyTabOrder(list, []), list);
  });

  it('sorts known tabs and appends unknown ones in server order', () => {
    const list = [s('a'), s('b', 'cb'), s('c'), s('d')];
    const ids = applyTabOrder(list, ['c', 'cb']).map((x) => x.id);
    assert.deepEqual(ids, ['c', 'b', 'a', 'd']);
  });

  it('matches by bridge id even after claudeSessionId is resolved', () => {
    const list = [s('a'), s('b', 'cb')];
    assert.deepEqual(
      applyTabOrder(list, ['b', 'a']).map((x) => x.id),
      ['b', 'a'],
    );
  });
});

describe('moveTab', () => {
  const list = [s('a'), s('b', 'cb'), s('c')];

  it('moves before target', () => {
    assert.deepEqual(moveTab(list, 'c', 'a'), ['c', 'a', 'cb']);
  });

  it('moves after target', () => {
    assert.deepEqual(moveTab(list, 'a', 'c', true), ['cb', 'c', 'a']);
    assert.deepEqual(moveTab(list, 'a', 'b', true), ['cb', 'a', 'c']);
  });

  it('keeps order when dropping on itself or unknown ids', () => {
    assert.deepEqual(moveTab(list, 'a', 'a'), ['a', 'cb', 'c']);
    assert.deepEqual(moveTab(list, 'x', 'a'), ['a', 'cb', 'c']);
    assert.deepEqual(moveTab(list, 'a', 'x'), ['a', 'cb', 'c']);
  });

  it('タブ一覧が無ければ空', () => {
    assert.deepEqual(moveTab(null, 'a', 'b'), []);
  });
});

describe('applyTabOrder の欠けた入力', () => {
  it('並びが null ならそのまま、タブ一覧が null なら空', () => {
    const list = [s('a'), s('b')];
    assert.equal(applyTabOrder(list, null), list);
    assert.deepEqual(applyTabOrder(null, ['a']), []);
  });
});

describe('タブの並びの保存', () => {
  it('保存した並びを読み戻せる', () => {
    withStorage((store) => {
      assert.equal(TAB_ORDER_KEY, 'sidebarTabOrder');
      saveTabOrder(['c1', 'b']);
      assert.equal(store.get(TAB_ORDER_KEY), '["c1","b"]');
      assert.deepEqual(loadTabOrder(), ['c1', 'b']);
    });
  });

  it('null を保存すると空の並びになる', () => {
    withStorage((store) => {
      saveTabOrder(null);
      assert.equal(store.get(TAB_ORDER_KEY), '[]');
    });
  });

  it('未保存なら空、文字列以外の要素は捨てる', () => {
    withStorage((store) => {
      assert.deepEqual(loadTabOrder(), []);
      store.set(TAB_ORDER_KEY, JSON.stringify(['a', 2, null, 'b']));
      assert.deepEqual(loadTabOrder(), ['a', 'b']);
    });
  });

  it('配列でない値・壊れた JSON・読み出し失敗は空', () => {
    withStorage((store) => {
      store.set(TAB_ORDER_KEY, '{"a":1}');
      assert.deepEqual(loadTabOrder(), []);
      store.set(TAB_ORDER_KEY, '[broken');
      assert.deepEqual(loadTabOrder(), []);
    });
    withStorage(() => assert.deepEqual(loadTabOrder(), []), { fail: true });
  });

  it('保存に失敗しても例外を投げない', () => {
    withStorage(() => assert.doesNotThrow(() => saveTabOrder(['a'])), { fail: true });
  });
});
