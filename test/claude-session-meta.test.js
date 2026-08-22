import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findClaudePid } from '../server/claude-session-meta.js';

describe('findClaudePid', () => {
  // tmux pane_pid (シェル) の子孫を辿って claude プロセスPID を探す。
  // childrenOf: ppid -> [pid...] / metaByPid: claude セッションを持つ pid の集合
  it('finds claude pid as a direct child of the shell', () => {
    const childrenOf = new Map([[100, [200]]]);
    const metaByPid = new Map([[200, { name: '規模感' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), 200);
  });

  it('finds claude pid deeper in the process tree', () => {
    const childrenOf = new Map([
      [100, [150]],
      [150, [300]],
    ]);
    const metaByPid = new Map([[300, { name: 'EOL' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), 300);
  });

  it('returns null when no descendant is a claude session', () => {
    const childrenOf = new Map([[100, [200, 201]]]);
    const metaByPid = new Map([[999, { name: '別ペイン' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), null);
  });

  it('returns null for a leaf shell with no children', () => {
    assert.equal(findClaudePid(100, new Map(), new Map([[1, {}]])), null);
  });

  it('does not match the shell pid itself', () => {
    // シェルPID 自体が meta を持っていても、子孫だけを対象にする
    const metaByPid = new Map([[100, { name: 'shell' }]]);
    assert.equal(findClaudePid(100, new Map(), metaByPid), null);
  });

  it('terminates on cyclic process relationships', () => {
    // 循環があっても無限ループしない
    const childrenOf = new Map([
      [100, [200]],
      [200, [100]],
    ]);
    assert.equal(findClaudePid(100, childrenOf, new Map()), null);
  });
});
