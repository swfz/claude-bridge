import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isSensitive,
  toggleSensitive,
  splitSensitive,
  countHiddenSensitive,
  loadSensitive,
  saveSensitive,
  loadShareMode,
  saveShareMode,
  SENSITIVE_KEY,
  SHARE_MODE_KEY,
} from '../client/src/utils/sensitiveSessions.js';

// localStorage の代わり。throwOnGet なら読み出しで例外を投げる（private window 等）
function withStorage(fn, { throwOnGet = false } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => {
      if (throwOnGet) throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    return fn(store);
  } finally {
    delete globalThis.localStorage;
  }
}

describe('isSensitive', () => {
  it('detects a sensitive session', () => {
    assert.equal(isSensitive(['a', 'b'], 'b'), true);
    assert.equal(isSensitive(['a'], 'b'), false);
  });

  it('handles missing input', () => {
    assert.equal(isSensitive(null, 'a'), false);
    assert.equal(isSensitive(['a'], null), false);
    assert.equal(isSensitive(['a'], ''), false);
  });
});

describe('toggleSensitive', () => {
  it('adds a new flag at the front', () => {
    assert.deepEqual(toggleSensitive(['a'], 'b'), ['b', 'a']);
  });

  it('removes an existing flag', () => {
    assert.deepEqual(toggleSensitive(['a', 'b'], 'a'), ['b']);
  });

  it('returns the list unchanged for a missing id', () => {
    assert.deepEqual(toggleSensitive(['a'], null), ['a']);
    assert.deepEqual(toggleSensitive(null, null), []);
  });
});

describe('splitSensitive', () => {
  const items = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }];

  it('splits into visible and hidden keeping the relative order', () => {
    const { visible, hidden } = splitSensitive(items, ['d', 'b']);
    assert.deepEqual(
      visible.map((i) => i.sessionId),
      ['a', 'c'],
    );
    assert.deepEqual(
      hidden.map((i) => i.sessionId),
      ['b', 'd'],
    );
  });

  it('keeps everything visible when nothing is sensitive', () => {
    const { visible, hidden } = splitSensitive(items, []);
    assert.deepEqual(
      visible.map((i) => i.sessionId),
      ['a', 'b', 'c', 'd'],
    );
    assert.deepEqual(hidden, []);
  });

  it('uses a custom keyOf (open tabs are keyed by claudeSessionId)', () => {
    const tabs = [
      { id: 't1', claudeSessionId: 'a' },
      { id: 't2', claudeSessionId: 'b' },
    ];
    const { visible, hidden } = splitSensitive(tabs, ['b'], (t) => t.claudeSessionId);
    assert.deepEqual(
      visible.map((t) => t.id),
      ['t1'],
    );
    assert.deepEqual(
      hidden.map((t) => t.id),
      ['t2'],
    );
  });

  it('keeps items without a key visible', () => {
    const tabs = [{ id: 't1' }, { id: 't2', claudeSessionId: null }];
    const { visible, hidden } = splitSensitive(tabs, ['a'], (t) => t.claudeSessionId);
    assert.deepEqual(
      visible.map((t) => t.id),
      ['t1', 't2'],
    );
    assert.deepEqual(hidden, []);
  });

  it('handles missing input', () => {
    assert.deepEqual(splitSensitive(null, ['a']), { visible: [], hidden: [] });
  });
});

describe('countHiddenSensitive', () => {
  it('欠けた要素（null）が混ざっていても数えられる', () => {
    const count = countHiddenSensitive(['a', 'b'], {
      tabs: [null, { claudeSessionId: 'a' }],
      running: [null, { sessionId: 'b' }],
      recent: [null, { sessionId: 'a' }],
    });
    assert.equal(count, 2);
  });
});

describe('センシティブ指定の保存', () => {
  it('保存した一覧を読み戻せる', () => {
    withStorage((store) => {
      saveSensitive(['a', 'b']);
      assert.equal(store.get(SENSITIVE_KEY), '["a","b"]');
      assert.deepEqual(loadSensitive(), ['a', 'b']);
    });
  });

  it('保存キーは homeSensitiveSessions', () => {
    assert.equal(SENSITIVE_KEY, 'homeSensitiveSessions');
  });

  it('null を保存すると空の一覧になる', () => {
    withStorage((store) => {
      saveSensitive(null);
      assert.equal(store.get(SENSITIVE_KEY), '[]');
    });
  });

  it('未保存なら空の一覧', () => {
    withStorage(() => {
      assert.deepEqual(loadSensitive(), []);
    });
  });

  it('文字列以外の要素は捨てる', () => {
    withStorage((store) => {
      store.set(SENSITIVE_KEY, JSON.stringify(['a', 1, null, 'b']));
      assert.deepEqual(loadSensitive(), ['a', 'b']);
    });
  });

  it('配列でない値・壊れた JSON・読み出し失敗は空の一覧', () => {
    withStorage((store) => {
      store.set(SENSITIVE_KEY, '{"a":1}');
      assert.deepEqual(loadSensitive(), []);
      store.set(SENSITIVE_KEY, '[broken');
      assert.deepEqual(loadSensitive(), []);
    });
    withStorage(() => assert.deepEqual(loadSensitive(), []), { throwOnGet: true });
  });
});

describe('共有モードの保存', () => {
  it('ON / OFF を保存して読み戻せる', () => {
    withStorage((store) => {
      assert.equal(SHARE_MODE_KEY, 'bridgeShareMode');
      saveShareMode(true);
      assert.equal(store.get(SHARE_MODE_KEY), '1');
      assert.equal(loadShareMode(), true);
      saveShareMode(false);
      assert.equal(store.get(SHARE_MODE_KEY), '0');
      assert.equal(loadShareMode(), false);
    });
  });

  it('未保存・読み出し失敗は OFF', () => {
    withStorage(() => assert.equal(loadShareMode(), false));
    withStorage(() => assert.equal(loadShareMode(), false), { throwOnGet: true });
  });
});
