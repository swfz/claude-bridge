import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectSessionFiles, filesToMarkdown, isModified, relativeToCwd } from '../client/src/utils/sessionFiles.js';

const asst = (uuid, toolUses, timestamp) => ({
  role: 'assistant',
  uuid,
  content: '',
  toolUses,
  ...(timestamp ? { timestamp } : {}),
});

describe('collectSessionFiles', () => {
  it('非配列は空配列', () => {
    assert.deepEqual(collectSessionFiles(null), []);
    assert.deepEqual(collectSessionFiles(undefined), []);
    assert.deepEqual(collectSessionFiles('x'), []);
  });

  it('各ツールの拾い方', () => {
    const files = collectSessionFiles([
      asst('u1', [
        { name: 'Read', input: { file_path: '/p/read.js' } },
        { name: 'Edit', input: { file_path: '/p/edit.js' } },
        { name: 'MultiEdit', input: { file_path: '/p/multi.js' } },
        { name: 'Write', input: { file_path: '/p/write.js' } },
        { name: 'NotebookEdit', input: { notebook_path: '/p/nb.ipynb' } },
        { name: 'Artifact', input: { file_path: '/p/page.html' } },
        { name: 'Artifact', input: { action: 'publish', file_path: '/p/page2.html' } },
      ]),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.ops]));
    assert.deepEqual(byPath['/p/read.js'], { read: 1, edit: 0, write: 0, artifact: 0 });
    assert.equal(byPath['/p/edit.js'].edit, 1);
    assert.equal(byPath['/p/multi.js'].edit, 1);
    assert.equal(byPath['/p/write.js'].write, 1);
    assert.equal(byPath['/p/nb.ipynb'].edit, 1);
    assert.equal(byPath['/p/page.html'].artifact, 1);
    assert.equal(byPath['/p/page2.html'].artifact, 1);
  });

  it('Artifact の asset 系・publish 以外・file_path 無しは無視', () => {
    const files = collectSessionFiles([
      asst('u1', [
        { name: 'Artifact', input: { action: 'list' } },
        { name: 'Artifact', input: { action: 'read', url: 'https://claude.ai/x' } },
        { name: 'Artifact', input: { action: 'publish' } },
        { name: 'Artifact', input: { asset: true, file_path: '/p/img.png', url: 'u' } },
      ]),
    ]);
    assert.deepEqual(files, []);
  });

  it('同じパスは 1 件にまとめ、op ごとの回数と uuid を持つ', () => {
    const files = collectSessionFiles([
      asst('u1', [{ name: 'Read', input: { file_path: '/p/a.js' } }]),
      asst('u2', [
        { name: 'Edit', input: { file_path: '/p/a.js' } },
        { name: 'Edit', input: { file_path: '/p/a.js' } },
      ]),
    ]);
    assert.equal(files.length, 1);
    assert.deepEqual(files[0].ops, { read: 1, edit: 2, write: 0, artifact: 0 });
    assert.equal(files[0].count, 3);
    assert.equal(files[0].firstUuid, 'u1');
    assert.equal(files[0].lastUuid, 'u2');
  });

  it('並びは最後の出現が新しい順（timestamp 優先、無ければ出現順）', () => {
    const noTs = collectSessionFiles([
      asst('u1', [{ name: 'Read', input: { file_path: '/p/a' } }]),
      asst('u2', [{ name: 'Read', input: { file_path: '/p/b' } }]),
      asst('u3', [{ name: 'Read', input: { file_path: '/p/a' } }]),
    ]);
    assert.deepEqual(
      noTs.map((f) => f.path),
      ['/p/a', '/p/b'],
    );

    const withTs = collectSessionFiles([
      asst('u1', [{ name: 'Read', input: { file_path: '/p/a' } }], '2026-01-02T00:00:00Z'),
      asst('u2', [{ name: 'Read', input: { file_path: '/p/b' } }], '2026-01-03T00:00:00Z'),
    ]);
    assert.deepEqual(
      withTs.map((f) => f.path),
      ['/p/b', '/p/a'],
    );
    assert.equal(withTs[0].lastTimestamp, '2026-01-03T00:00:00Z');
  });

  it('不正入力（相対パス・input 無し・非文字列・assistant 以外）は無視', () => {
    const files = collectSessionFiles([
      null,
      { role: 'human', content: '', toolUses: [{ name: 'Read', input: { file_path: '/p/h' } }] },
      { role: 'assistant', content: 'x' },
      { role: 'assistant', toolUses: 'nope' },
      asst('u1', [
        null,
        { name: 'Read' },
        { name: 'Read', input: null },
        { name: 'Read', input: { file_path: 'rel/path.js' } },
        { name: 'Read', input: { file_path: 42 } },
        { name: 'NotebookEdit', input: { file_path: '/p/wrongkey' } },
        { name: 'Bash', input: { file_path: '/p/bash' } },
      ]),
    ]);
    assert.deepEqual(files, []);
  });
});

describe('relativeToCwd', () => {
  it('cwd 配下は相対、それ以外はそのまま', () => {
    assert.equal(relativeToCwd('/work/proj/src/a.js', '/work/proj'), 'src/a.js');
    assert.equal(relativeToCwd('/work/proj/src/a.js', '/work/proj/'), 'src/a.js');
    assert.equal(relativeToCwd('/work/other/a.js', '/work/proj'), '/work/other/a.js');
    assert.equal(relativeToCwd('/work/project2/a.js', '/work/proj'), '/work/project2/a.js');
  });

  it('cwd 無しはそのまま', () => {
    assert.equal(relativeToCwd('/a/b', undefined), '/a/b');
    assert.equal(relativeToCwd('/a/b', ''), '/a/b');
  });
});

describe('isModified / filesToMarkdown', () => {
  it('変更の判定', () => {
    assert.equal(isModified({ ops: { read: 3, edit: 0, write: 0, artifact: 0 } }), false);
    assert.equal(isModified({ ops: { read: 0, edit: 0, write: 0, artifact: 1 } }), true);
  });

  it('1 行 1 ファイルの箇条書き', () => {
    const files = [{ path: '/w/p/a.js' }, { path: '/etc/x' }];
    assert.equal(filesToMarkdown(files, '/w/p'), '- a.js\n- /etc/x');
    assert.equal(filesToMarkdown(null, '/w/p'), '');
  });
});
