import { describe, it } from 'vitest';
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
  DIFF_SCOPES,
  DIFF_SCOPE_STORAGE_KEY,
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

describe('diffView: 表示文言と境界', () => {
  it('範囲の選択肢と保存キー', () => {
    assert.deepEqual(DIFF_SCOPES, [
      { value: 'all', label: '全体' },
      { value: 'session', label: 'このセッション' },
      { value: 'commit', label: 'コミット' },
      { value: 'turn', label: 'ターン' },
    ]);
    assert.equal(DIFF_SCOPE_STORAGE_KEY, 'diffDrawerScope');
  });

  it('diffStatusLabel は modified 以外の状態に文言を付ける', () => {
    assert.equal(diffStatusLabel('added'), '新規');
    assert.equal(diffStatusLabel('deleted'), '削除');
    assert.equal(diffStatusLabel('renamed'), '名前変更');
    assert.equal(diffStatusLabel('committed'), '差分なし（コミット済み）');
    assert.equal(diffStatusLabel('missing'), '差分なし（ファイルなし）');
  });

  it('patchBodyLines は patch が無ければ空', () => {
    assert.deepEqual(patchBodyLines(null), []);
    assert.deepEqual(patchBodyLines(undefined), []);
  });

  it('patchBodyLines は末尾の改行 1 つを行にしない', () => {
    assert.deepEqual(patchBodyLines('@@ -1 +1 @@\n-a\n+b\n'), [
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: '-a' },
      { kind: 'add', text: '+b' },
    ]);
  });

  it('hunk 見出しの後ろに関数名が付いていても hunk として扱う', () => {
    const patch = 'diff --git a/x b/x\n@@ -1,2 +1,2 @@ function foo() {\n-a\n+b\n';
    assert.deepEqual(
      patchBodyLines(patch).map((l) => l.kind),
      ['hunk', 'del', 'add'],
    );
    assert.equal(diffLineKind('@@ -3 +3 @@ bar'), 'hunk');
  });

  it('summarizeDiff はファイルの無い差分なしも件数に入れない', () => {
    assert.deepEqual(summarizeDiff([{ status: 'missing' }, { status: 'modified', additions: 1 }]), {
      changed: 1,
      additions: 1,
      deletions: 0,
    });
  });

  it('shouldCollapseFile は 300 行ちょうどなら畳まない', () => {
    assert.equal(shouldCollapseFile({ additions: 200, deletions: 100 }), false);
  });

  it('absolutePath はルート末尾の連続したスラッシュを 1 つにまとめる', () => {
    assert.equal(absolutePath('/repo//', 'a.js'), '/repo/a.js');
  });

  it('splitPath はルート直下のファイルのディレクトリを / にする', () => {
    assert.deepEqual(splitPath('/a.js'), { dir: '/', name: 'a.js' });
  });
});
