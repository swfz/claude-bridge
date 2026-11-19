import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  assignTabToGroup,
  autoGroupKeyOf,
  autoGroupLabel,
  buildTabGroups,
  createGroup,
  deleteGroup,
  flattenTabGroups,
  GROUP_PALETTE_NAMES,
  GROUP_PALETTE_SIZE,
  groupColorIndexMap,
  groupColorMap,
  groupKeyOf,
  loadTabGroups,
  renameGroup,
  representativeDirOf,
  saveTabGroups,
  setGroupColor,
  shouldShowDir,
  toggleGroupCollapsed,
  visibleTabsOf,
} from '../client/src/utils/tabGroups.js';

const s = (id, cwd, claudeSessionId) => ({ id, cwd, claudeSessionId });
const empty = { groups: [], assign: {}, collapsed: [] };

describe('shouldShowDir', () => {
  const autoGroup = { key: 'p:gh/app', manual: false };
  it('hides the dir when the tab belongs to the group directory (worktrees included)', () => {
    assert.equal(shouldShowDir(s('a', '/home/u/gh/app'), autoGroup), false);
    assert.equal(shouldShowDir(s('b', '/home/u/gh/app/.claude/worktrees/wt'), autoGroup), false);
  });
  it('shows the dir for a tab moved in from another directory', () => {
    assert.equal(shouldShowDir(s('c', '/home/u/gh/other'), autoGroup), true);
  });
  it('always shows the dir in manual groups', () => {
    assert.equal(shouldShowDir(s('a', '/home/u/gh/app'), { key: 'g:x', manual: true }), true);
  });
  it('returns false without a group', () => {
    assert.equal(shouldShowDir(s('a', '/home/u/gh/app'), null), false);
  });
});

describe('representativeDirOf', () => {
  it('returns the repository root with home folded to ~', () => {
    const group = {
      key: 'p:gh/app',
      manual: false,
      sessions: [s('x', '/home/u/gh/other'), s('a', '/home/u/gh/app/.claude/worktrees/wt1')],
    };
    assert.equal(representativeDirOf(group), '~/gh/app');
  });
  it('keeps paths outside home as is', () => {
    assert.equal(representativeDirOf({ key: 'p:srv/app', sessions: [s('a', '/srv/app/')] }), '/srv/app');
  });
  it('returns null for manual groups or groups without a matching cwd', () => {
    assert.equal(representativeDirOf({ key: 'g:x', manual: true, sessions: [s('a', '/x/app')] }), null);
    assert.equal(representativeDirOf({ key: 'p:', sessions: [s('a')] }), null);
    assert.equal(representativeDirOf(null), null);
  });
});

describe('autoGroupKeyOf', () => {
  it('groups worktrees with their repository', () => {
    assert.equal(autoGroupKeyOf(s('a', '/home/u/gh/app')), 'p:gh/app');
    assert.equal(autoGroupKeyOf(s('b', '/home/u/gh/app/.claude/worktrees/wt1')), 'p:gh/app');
  });
  it('falls back to p: without cwd', () => {
    assert.equal(autoGroupKeyOf(s('a')), 'p:');
    assert.equal(autoGroupLabel('p:'), 'その他');
    assert.equal(autoGroupLabel('p:gh/app'), 'app');
  });
});

describe('buildTabGroups', () => {
  it('groups by project in first-appearance order, keeping tab order inside', () => {
    const tabs = [s('a', '/x/one'), s('b', '/x/two'), s('c', '/x/one')];
    const groups = buildTabGroups(tabs, empty);
    assert.deepEqual(
      groups.map((g) => [g.key, g.sessions.map((t) => t.id)]),
      [
        ['p:x/one', ['a', 'c']],
        ['p:x/two', ['b']],
      ],
    );
    assert.deepEqual(
      flattenTabGroups(groups).map((t) => t.id),
      ['a', 'c', 'b'],
    );
  });

  it('puts manual groups first, even when empty', () => {
    let st = createGroup(empty, ' 調査 ', 'g1');
    st = createGroup(st, 'empty', 'g2');
    st = assignTabToGroup(st, s('b', '/x/two', 'cb'), 'g:g1');
    const groups = buildTabGroups([s('a', '/x/one'), s('b', '/x/two', 'cb')], st);
    assert.deepEqual(
      groups.map((g) => [g.key, g.label, g.manual, g.sessions.map((t) => t.id)]),
      [
        ['g:g1', '調査', true, ['b']],
        ['g:g2', 'empty', true, []],
        ['p:x/one', 'one', false, ['a']],
      ],
    );
  });

  it('marks collapsed groups', () => {
    const st = toggleGroupCollapsed(empty, 'p:x/one');
    assert.equal(buildTabGroups([s('a', '/x/one')], st)[0].collapsed, true);
    assert.deepEqual(toggleGroupCollapsed(st, 'p:x/one').collapsed, []);
  });
});

describe('assignTabToGroup', () => {
  it('can move a tab into another project group and back', () => {
    const tab = s('a', '/x/one', 'c1');
    let st = assignTabToGroup(empty, tab, 'p:x/two');
    assert.deepEqual(st.assign, { c1: 'p:x/two' });
    assert.equal(groupKeyOf(tab, st), 'p:x/two');
    st = assignTabToGroup(st, tab, 'p:x/one');
    assert.deepEqual(st.assign, {});
  });

  it('matches by bridge id when the assignment was made before claudeSessionId resolved', () => {
    const st = assignTabToGroup(createGroup(empty, 'g', 'g1'), s('a', '/x/one'), 'g:g1');
    assert.equal(groupKeyOf(s('a', '/x/one', 'c1'), st), 'g:g1');
  });

  it('ignores assignments to deleted groups', () => {
    let st = createGroup(empty, 'g', 'g1');
    st = assignTabToGroup(st, s('a', '/x/one'), 'g:g1');
    st = deleteGroup(st, 'g1');
    assert.deepEqual(st.assign, {});
    assert.equal(groupKeyOf(s('a', '/x/one'), { ...st, assign: { a: 'g:g1' } }), 'p:x/one');
  });
});

describe('createGroup / renameGroup', () => {
  it('rejects blank names', () => {
    assert.equal(createGroup(empty, '  '), empty);
    const st = createGroup(empty, 'a', 'g1');
    assert.equal(renameGroup(st, 'g1', ''), st);
    assert.equal(renameGroup(st, 'g1', 'b').groups[0].name, 'b');
  });
});

describe('visibleTabsOf', () => {
  it('keeps only the active tab in a collapsed group', () => {
    const group = { collapsed: true, sessions: [s('a'), s('b')] };
    assert.deepEqual(
      visibleTabsOf(group, 'b').map((t) => t.id),
      ['b'],
    );
    assert.deepEqual(visibleTabsOf(group, null), []);
    assert.equal(visibleTabsOf({ ...group, collapsed: false }, null).length, 2);
  });
});

describe('group colors', () => {
  const g = (key) => ({ key, sessions: [] });

  it('setGroupColor pins a palette index and null resets to auto', () => {
    let st = setGroupColor(empty, 'p:x/one', 3);
    assert.deepEqual(st.colors, { 'p:x/one': 3 });
    st = setGroupColor(st, 'p:x/one', null);
    assert.deepEqual(st.colors, {});
    assert.deepEqual(setGroupColor(empty, 'p:x/one', 8).colors, {});
    assert.deepEqual(setGroupColor(empty, 'p:x/one', 1.5).colors, {});
  });

  it('pinned groups keep their color and the rest rotate over unused colors', () => {
    const groups = [g('a'), g('b'), g('c')];
    const map = groupColorIndexMap(groups, { b: 0 });
    assert.equal(map.get('b'), 0);
    assert.equal(map.get('a'), 1);
    assert.equal(map.get('c'), 2);
  });

  it('pinned colors stay put when the group order changes', () => {
    const colors = { c: 5 };
    assert.equal(groupColorIndexMap([g('a'), g('b'), g('c')], colors).get('c'), 5);
    assert.equal(groupColorIndexMap([g('c'), g('a')], colors).get('c'), 5);
  });

  it('allows duplicates: two groups may pin the same color', () => {
    const map = groupColorIndexMap([g('a'), g('b')], { a: 2, b: 2 });
    assert.equal(map.get('a'), 2);
    assert.equal(map.get('b'), 2);
  });

  it('falls back to rotating over all colors when every color is pinned', () => {
    const pinned = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, i]));
    const groups = [...Object.keys(pinned).map(g), g('free')];
    assert.equal(groupColorIndexMap(groups, pinned).get('free'), 0);
  });

  it('ignores pins for groups that are not shown when picking free colors', () => {
    const map = groupColorIndexMap([g('a')], { hidden: 0 });
    assert.equal(map.get('a'), 0);
  });

  it('groupColorMap returns CSS variables', () => {
    assert.equal(groupColorMap([g('a')], { a: 4 }).get('a'), 'var(--cal-4)');
  });

  it('deleteGroup drops the color of the deleted manual group', () => {
    let st = createGroup(empty, 'g', 'g1');
    st = setGroupColor(st, 'g:g1', 2);
    st = setGroupColor(st, 'p:x/one', 3);
    assert.deepEqual(deleteGroup(st, 'g1').colors, { 'p:x/one': 3 });
  });

  it('loadTabGroups keeps only valid palette indexes', () => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    };
    try {
      store.set('sidebarTabGroups', JSON.stringify({ colors: { a: 1, b: 9, c: 'x', d: -1 } }));
      assert.deepEqual(loadTabGroups().colors, { a: 1 });
      store.set('sidebarTabGroups', JSON.stringify({ groups: [] }));
      assert.deepEqual(loadTabGroups().colors, {});
    } finally {
      delete globalThis.localStorage;
    }
  });
});

// localStorage の代わり。テストの終わりで消す
function useFakeStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  return store;
}
const EMPTY = { groups: [], assign: {}, collapsed: [], colors: {} };

describe('palette names', () => {
  it('names each palette color in the --cal-N order', () => {
    assert.equal(GROUP_PALETTE_NAMES.length, GROUP_PALETTE_SIZE);
    assert.deepEqual(GROUP_PALETTE_NAMES, ['紫', '青', '青緑', '砂', '藤', 'オリーブ', '鼠青', '煉瓦']);
  });
});

describe('autoGroupKeyOf edge cases', () => {
  it('returns p: for a missing session', () => {
    assert.equal(autoGroupKeyOf(undefined), 'p:');
  });
  it('omits the parent for a top-level directory', () => {
    assert.equal(autoGroupKeyOf(s('a', '/app')), 'p:app');
  });
});

describe('groupKeyOf edge cases', () => {
  it('falls back to the project group without state or assignments', () => {
    assert.equal(groupKeyOf(s('a', '/x/one'), undefined), 'p:x/one');
    assert.equal(groupKeyOf(s('a', '/x/one'), { groups: [] }), 'p:x/one');
  });
  it('ignores an assignment to a manual group when no manual groups exist', () => {
    assert.equal(groupKeyOf(s('a', '/x/one'), { assign: { a: 'g:undefined' } }), 'p:x/one');
  });
  it('does not pick up the assignment of a tab whose id is the string "undefined"', () => {
    const st = { groups: [], assign: { undefined: 'p:x/two' } };
    assert.equal(groupKeyOf(s('b', '/x/one'), st), 'p:x/one');
  });
});

describe('buildTabGroups edge cases', () => {
  it('works without state and without tabs', () => {
    assert.deepEqual(
      buildTabGroups([s('a', '/x/one')], null).map((g) => [g.key, g.manual, g.collapsed]),
      [['p:x/one', false, false]],
    );
    assert.deepEqual(buildTabGroups(undefined, empty), []);
  });
  it('creates no manual groups when state has no groups', () => {
    assert.deepEqual(
      buildTabGroups([s('a', '/x/one')], { assign: {} }).map((g) => g.key),
      ['p:x/one'],
    );
  });
});

describe('assignTabToGroup edge cases', () => {
  it('leaves the state untouched for a tab without any id', () => {
    const st = createGroup(empty, 'g', 'g1');
    assert.equal(assignTabToGroup(st, { cwd: '/x/one' }, 'g:g1'), st);
  });
  it('keeps the assignments of other tabs', () => {
    const st = { ...empty, assign: { other: 'p:x/two' } };
    assert.deepEqual(assignTabToGroup(st, s('a', '/x/one', 'c1'), 'p:x/three').assign, {
      other: 'p:x/two',
      c1: 'p:x/three',
    });
    assert.deepEqual(assignTabToGroup(st, s('a', '/x/one', 'c1'), 'p:x/one').assign, { other: 'p:x/two' });
  });
  it('works on a state without assign', () => {
    assert.deepEqual(assignTabToGroup({}, s('a', '/x/one'), 'p:x/two').assign, { a: 'p:x/two' });
  });
  it('does not drop the assignment of a tab whose id is the string "undefined"', () => {
    const st = { ...empty, assign: { undefined: 'p:x/two' } };
    assert.deepEqual(assignTabToGroup(st, s('b', '/x/one'), 'p:x/three').assign, {
      undefined: 'p:x/two',
      b: 'p:x/three',
    });
  });
});

describe('createGroup / renameGroup edge cases', () => {
  it('generates distinct alphanumeric ids when none is given', () => {
    const a = createGroup(empty, 'a').groups[0].id;
    const b = createGroup(empty, 'b').groups[0].id;
    assert.match(a, /^[0-9a-z]+$/);
    assert.notEqual(a, b);
  });
  it('rejects a missing name', () => {
    assert.equal(createGroup(empty, undefined), empty);
    assert.equal(createGroup(empty, null), empty);
  });
  it('works on a state without groups', () => {
    assert.deepEqual(createGroup({}, 'a', 'g1').groups, [{ id: 'g1', name: 'a' }]);
    assert.deepEqual(renameGroup({}, 'g1', 'b').groups, []);
  });
  it('trims the new name and renames only the matching group', () => {
    let st = createGroup(empty, 'a', 'g1');
    st = createGroup(st, 'b', 'g2');
    assert.deepEqual(renameGroup(st, 'g1', '  c  ').groups, [
      { id: 'g1', name: 'c' },
      { id: 'g2', name: 'b' },
    ]);
  });
});

describe('deleteGroup', () => {
  it('removes only the deleted group and what refers to it', () => {
    const st = {
      groups: [
        { id: 'g1', name: 'a' },
        { id: 'g2', name: 'b' },
      ],
      assign: { t1: 'g:g1', t2: 'g:g2', t3: 'p:x/one' },
      collapsed: ['g:g1', 'p:x/one'],
      colors: { 'g:g1': 1, 'g:g2': 2 },
    };
    assert.deepEqual(deleteGroup(st, 'g1'), {
      groups: [{ id: 'g2', name: 'b' }],
      assign: { t2: 'g:g2', t3: 'p:x/one' },
      collapsed: ['p:x/one'],
      colors: { 'g:g2': 2 },
    });
  });
  it('works on an empty state object', () => {
    assert.deepEqual(deleteGroup({}, 'g1'), EMPTY);
  });
});

describe('setGroupColor / toggleGroupCollapsed edge cases', () => {
  it('keeps the colors of other groups', () => {
    const st = setGroupColor({ colors: { a: 1 } }, 'b', 2);
    assert.deepEqual(st.colors, { a: 1, b: 2 });
    assert.deepEqual(setGroupColor(st, 'b', null).colors, { a: 1 });
  });
  it('collapses on a state without collapsed and expands only the toggled group', () => {
    assert.deepEqual(toggleGroupCollapsed({}, 'k').collapsed, ['k']);
    assert.deepEqual(toggleGroupCollapsed({ collapsed: ['a', 'k'] }, 'k').collapsed, ['a']);
  });
});

describe('loadTabGroups / saveTabGroups', () => {
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('returns an empty state when nothing is saved, the JSON is broken, or storage is unavailable', () => {
    const store = useFakeStorage();
    assert.deepEqual(loadTabGroups(), EMPTY);
    store.set('sidebarTabGroups', '{broken');
    assert.deepEqual(loadTabGroups(), EMPTY);
    delete globalThis.localStorage;
    assert.deepEqual(loadTabGroups(), EMPTY);
  });

  it('keeps only valid groups, assignments and collapsed keys', () => {
    const store = useFakeStorage();
    store.set(
      'sidebarTabGroups',
      JSON.stringify({
        groups: [{ id: 'g1', name: 'a' }, null, { id: 1, name: 'x' }, { id: 'g2' }, { id: 'g3', name: 3 }],
        assign: { t1: 'g:g1', t2: 1 },
        collapsed: ['g:g1', 2],
      }),
    );
    assert.deepEqual(loadTabGroups(), {
      groups: [{ id: 'g1', name: 'a' }],
      assign: { t1: 'g:g1' },
      collapsed: ['g:g1'],
      colors: {},
    });
  });

  it('drops fields of the wrong type', () => {
    const store = useFakeStorage();
    store.set('sidebarTabGroups', JSON.stringify({ groups: 'x', assign: 'abc', collapsed: 'x', colors: 'abc' }));
    assert.deepEqual(loadTabGroups(), EMPTY);
  });

  it('round-trips a saved state', () => {
    useFakeStorage();
    const st = {
      groups: [{ id: 'g1', name: 'a' }],
      assign: { t1: 'g:g1' },
      collapsed: ['p:x/one'],
      colors: { 'g:g1': 3 },
    };
    saveTabGroups(st);
    assert.deepEqual(loadTabGroups(), st);
  });

  it('saves an empty state for null', () => {
    const store = useFakeStorage();
    saveTabGroups(null);
    assert.deepEqual(JSON.parse(store.get('sidebarTabGroups')), EMPTY);
  });

  it('does not throw when storage is unavailable', () => {
    assert.doesNotThrow(() => saveTabGroups(EMPTY));
  });
});

describe('representativeDirOf edge cases', () => {
  it('returns null for a group without sessions', () => {
    assert.equal(representativeDirOf({ key: 'p:x/app', manual: false }), null);
  });
  it('finds the repository root at the start of the path', () => {
    assert.equal(representativeDirOf({ key: 'p:app', sessions: [s('a', '/app/.claude/worktrees/wt')] }), '/app');
  });
  it('ignores repeated trailing slashes even when the worktree has the repository name', () => {
    assert.equal(
      representativeDirOf({ key: 'p:x/app', sessions: [s('a', '/x/app/.claude/worktrees/app//')] }),
      '/x/app',
    );
  });
  it('folds /home/<user> only when it is at the start of the path', () => {
    assert.equal(representativeDirOf({ key: 'p:gh/app', sessions: [s('a', '/home/alice/gh/app')] }), '~/gh/app');
    assert.equal(representativeDirOf({ key: 'p:u/app', sessions: [s('a', '/srv/home/u/app')] }), '/srv/home/u/app');
  });
});

describe('groupColorIndexMap edge cases', () => {
  it('rotates colors when no pins are given', () => {
    assert.deepEqual(
      [...groupColorIndexMap([{ key: 'a' }, { key: 'b' }], null)],
      [
        ['a', 0],
        ['b', 1],
      ],
    );
  });
});
