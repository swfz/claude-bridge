import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignTabToGroup,
  autoGroupKeyOf,
  autoGroupLabel,
  buildTabGroups,
  createGroup,
  deleteGroup,
  flattenTabGroups,
  groupKeyOf,
  renameGroup,
  toggleGroupCollapsed,
  visibleTabsOf,
} from '../client/src/utils/tabGroups.js';

const s = (id, cwd, claudeSessionId) => ({ id, cwd, claudeSessionId });
const empty = { groups: [], assign: {}, collapsed: [] };

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
