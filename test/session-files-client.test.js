import { describe, it } from 'vitest';
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

describe('collectSessionFiles（境界）', () => {
  const readOf = (path) => ({ name: 'Read', input: { file_path: path } });
  const paths = (files) => files.map((f) => f.path);

  it('publish 以外の action の Artifact と asset は数えない', () => {
    const files = collectSessionFiles([
      asst('u1', [
        { name: 'Artifact', input: { action: 'read', file_path: '/p/read.html' } },
        { name: 'Artifact', input: { action: 'publish', asset: true, file_path: '/p/asset.png' } },
      ]),
    ]);
    assert.deepEqual(files, []);
  });

  it('timestamp の無いメッセージだけなら lastTimestamp は空文字', () => {
    const [file] = collectSessionFiles([asst('u1', [readOf('/p/a.js')])]);
    assert.equal(file.lastTimestamp, '');
  });

  it('最初の出現に uuid が無ければ、後の出現の uuid を firstUuid にする', () => {
    const [file] = collectSessionFiles([asst(undefined, [readOf('/p/a.js')]), asst('u2', [readOf('/p/a.js')])]);
    assert.equal(file.firstUuid, 'u2');
    assert.equal(file.lastUuid, 'u2');
  });

  it('lastTimestamp は最後の出現の時刻、時刻が無い出現では直前の時刻を残す', () => {
    const [file] = collectSessionFiles([asst('u1', [readOf('/p/a.js')], 't1'), asst('u2', [readOf('/p/a.js')], 't2')]);
    assert.equal(file.lastTimestamp, 't2');
    const [kept] = collectSessionFiles([asst('u1', [readOf('/p/a.js')], 't1'), asst('u2', [readOf('/p/a.js')])]);
    assert.equal(kept.lastTimestamp, 't1');
  });

  it('時刻が両方あれば出現順ではなく時刻の新しい順', () => {
    const files = collectSessionFiles([
      asst('u1', [readOf('/p/late.js')], '2026-01-02T00:00:00Z'),
      asst('u2', [readOf('/p/early.js')], '2026-01-01T00:00:00Z'),
    ]);
    assert.deepEqual(paths(files), ['/p/late.js', '/p/early.js']);
  });

  it('時刻が同じなら後に出たものが先', () => {
    const files = collectSessionFiles([
      asst('u1', [readOf('/p/a.js')], '2026-01-01T00:00:00Z'),
      asst('u2', [readOf('/p/b.js')], '2026-01-01T00:00:00Z'),
    ]);
    assert.deepEqual(paths(files), ['/p/b.js', '/p/a.js']);
  });

  it('片方に時刻が無ければ出現順（後が先）で比べる', () => {
    const files = collectSessionFiles([
      asst('u1', [readOf('/p/a.js')], '2026-01-09T00:00:00Z'),
      asst('u2', [readOf('/p/b.js')]),
    ]);
    assert.deepEqual(paths(files), ['/p/b.js', '/p/a.js']);
  });

  it('時刻が無ければ 3 件以上でも出現の新しい順', () => {
    const files = collectSessionFiles([
      asst('u1', [readOf('/p/a.js')]),
      asst('u2', [readOf('/p/b.js')]),
      asst('u3', [readOf('/p/c.js')]),
      asst('u4', [readOf('/p/a.js')]),
    ]);
    assert.deepEqual(paths(files), ['/p/a.js', '/p/c.js', '/p/b.js']);
  });
});

describe('relativeToCwd（境界）', () => {
  it('path が文字列でなければ空文字', () => {
    assert.equal(relativeToCwd(undefined, '/p'), '');
    assert.equal(relativeToCwd(null, '/p'), '');
  });

  it('cwd が文字列でなければそのまま', () => {
    assert.equal(relativeToCwd('/a/b', 123), '/a/b');
  });

  it('cwd 末尾の連続するスラッシュも落とす', () => {
    assert.equal(relativeToCwd('/a/b', '/a//'), 'b');
  });

  it('cwd がルート（/）なら相対にしない', () => {
    assert.equal(relativeToCwd('/a/b', '/'), '/a/b');
  });
});

describe('isModified（op ごと）', () => {
  const ops = (o) => ({ ops: { read: 0, edit: 0, write: 0, artifact: 0, ...o } });
  it('edit・write・artifact のどれか 1 つだけでも変更', () => {
    assert.equal(isModified(ops({ edit: 1 })), true);
    assert.equal(isModified(ops({ write: 1 })), true);
    assert.equal(isModified(ops({ artifact: 1 })), true);
  });
});
