import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutePath,
  diffLineKind,
  diffStatusLabel,
  isDiffCommand,
  normalizeDiffScope,
  patchBodyLines,
  shouldCollapseFile,
  splitPath,
  summarizeDiff,
} from '../client/src/utils/diffView.js';

describe('diffView', () => {
  it('isDiffCommand は /diff だけを拾う', () => {
    assert.equal(isDiffCommand('/diff'), true);
    assert.equal(isDiffCommand(' /diff '), true);
    assert.equal(isDiffCommand('/diff foo'), false);
    assert.equal(isDiffCommand('/difff'), false);
    assert.equal(isDiffCommand(null), false);
  });

  it('normalizeDiffScope', () => {
    assert.equal(normalizeDiffScope('session'), 'session');
    assert.equal(normalizeDiffScope('x'), 'all');
    assert.equal(normalizeDiffScope(null), 'all');
  });

  it('diffStatusLabel は既定の modified を出さない', () => {
    assert.equal(diffStatusLabel('modified'), null);
    assert.equal(diffStatusLabel('untracked'), '未追跡');
  });

  it('patchBodyLines はヘッダを落として種類を付ける', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n c\n\\ No newline at end of file\n';
    assert.deepEqual(
      patchBodyLines(patch).map((l) => l.kind),
      ['hunk', 'del', 'add', 'ctx', 'meta'],
    );
    assert.deepEqual(patchBodyLines(''), []);
    assert.deepEqual(patchBodyLines('diff --git a/x b/x\nBinary files differ'), []);
    assert.equal(diffLineKind('+'), 'add');
  });

  it('summarizeDiff は差分なしを件数に入れない', () => {
    assert.deepEqual(
      summarizeDiff([
        { status: 'modified', additions: 2, deletions: 1 },
        { status: 'untracked', additions: 3, deletions: 0 },
        { status: 'committed', additions: 0, deletions: 0 },
      ]),
      { changed: 2, additions: 5, deletions: 1 },
    );
    assert.deepEqual(summarizeDiff(undefined), { changed: 0, additions: 0, deletions: 0 });
  });

  it('shouldCollapseFile', () => {
    assert.equal(shouldCollapseFile({ additions: 200, deletions: 101 }), true);
    assert.equal(shouldCollapseFile({ additions: 10 }), false);
  });

  it('absolutePath / splitPath', () => {
    assert.equal(absolutePath('/repo/', 'a/b.js'), '/repo/a/b.js');
    assert.equal(absolutePath(null, 'a'), null);
    assert.deepEqual(splitPath('a/b/c.js'), { dir: 'a/b/', name: 'c.js' });
    assert.deepEqual(splitPath('c.js'), { dir: '', name: 'c.js' });
  });
});
