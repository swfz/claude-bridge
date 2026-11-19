import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createIncrementalReader } from '../server/jsonl-incremental.js';

const line = (record) => JSON.stringify(record) + '\n';

const dirs = [];
async function tmpFile(name = 's.jsonl') {
  const dir = await mkdtemp(join(tmpdir(), 'cb-incremental-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

// `"keep"` を含む行だけを拾い、record.n を配列に積む reader。collect の呼び出し回数も数える
function makeReader(options = {}) {
  const calls = { collect: 0, prefilter: 0, create: 0 };
  const reader = createIncrementalReader({
    prefilter: (l) => {
      calls.prefilter++;
      return l.includes('"keep"');
    },
    collect: (record, value) => {
      calls.collect++;
      value.push(record.n);
    },
    createValue: () => {
      calls.create++;
      return [];
    },
    ...options,
  });
  return { reader, calls };
}

describe('createIncrementalReader', () => {
  it('prefilter を通った行だけを collect に渡し、壊れた行は飛ばす', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      line({ kind: 'keep', n: 1 }) +
        line({ kind: 'skip', n: 2 }) +
        '{"kind":"keep", broken\n' +
        line({ kind: 'keep', n: 3 }),
    );
    const { reader, calls } = makeReader();
    assert.deepEqual(await reader.read(file), [1, 3]);
    assert.equal(calls.collect, 2);
    assert.equal(calls.prefilter, 4);
  });

  it('存在しないファイルは null', async () => {
    const { reader } = makeReader();
    assert.equal(await reader.read(join(tmpdir(), 'cb-incremental-missing.jsonl')), null);
  });

  it('stat が変わらなければ読み直さず同じ値を返す', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    const { reader, calls } = makeReader();
    const first = await reader.read(file);
    const second = await reader.read(file);
    assert.equal(second, first);
    assert.deepEqual(second, [1]);
    assert.equal(calls.prefilter, 1);
  });

  it('追記分だけを読み足し、書きかけの行は改行が付くまで取り込まない', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    const { reader, calls } = makeReader();
    assert.deepEqual(await reader.read(file), [1]);

    await appendFile(file, line({ kind: 'keep', n: 2 }) + JSON.stringify({ kind: 'keep', n: 3 }));
    assert.deepEqual(await reader.read(file), [1, 2]);
    // 既に読んだ 1 行目は読み直さない
    assert.equal(calls.prefilter, 2);

    await appendFile(file, '\n');
    assert.deepEqual(await reader.read(file), [1, 2, 3]);
    assert.equal(calls.prefilter, 3);
  });

  it('読み込みの塊（64KB）をまたぐ長い行もつないで 1 行として読む', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      line({ kind: 'keep', n: 1, pad: 'a'.repeat(200 * 1024) }) + line({ kind: 'keep', n: 2, pad: 'b'.repeat(100) }),
    );
    const { reader } = makeReader();
    assert.deepEqual(await reader.read(file), [1, 2]);
  });

  it('マルチバイト文字の後でも次の開始位置がずれない', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1, text: 'あいうえお'.repeat(50) }));
    const { reader } = makeReader();
    assert.deepEqual(await reader.read(file), [1]);
    await appendFile(file, line({ kind: 'keep', n: 2, text: '日本語' }));
    assert.deepEqual(await reader.read(file), [1, 2]);
  });

  it('ファイルが縮んだら新しい集め先で先頭から読み直す', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }) + line({ kind: 'keep', n: 2 }));
    const { reader } = makeReader();
    const before = await reader.read(file);
    assert.deepEqual(before, [1, 2]);

    await writeFile(file, line({ kind: 'keep', n: 9 }));
    const after = await reader.read(file);
    assert.deepEqual(after, [9]);
    assert.deepEqual(before, [1, 2]);
  });

  it('同じサイズのまま mtime だけ変わっても、読み終えた範囲は読み直さない', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    const { reader, calls } = makeReader();
    const fileStat = await stat(file);
    assert.deepEqual(await reader.read(file, fileStat), [1]);
    assert.deepEqual(await reader.read(file, { size: fileStat.size, mtimeMs: fileStat.mtimeMs + 1000 }), [1]);
    assert.equal(calls.prefilter, 1);
  });

  it('渡された fileStat を信じ、前回と同じ stat なら中身が変わっていてもキャッシュを返す', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    const fileStat = await stat(file);
    const { reader } = makeReader();
    assert.deepEqual(await reader.read(file, fileStat), [1]);
    await appendFile(file, line({ kind: 'keep', n: 2 }));
    assert.deepEqual(await reader.read(file, fileStat), [1]);
    // stat を渡さなければ追記を拾う
    assert.deepEqual(await reader.read(file), [1, 2]);
  });

  it('fileStat はあるのに読めないファイルは空の集め先を返し、後で読めたら拾う', async () => {
    const file = await tmpFile();
    const { reader } = makeReader();
    assert.deepEqual(await reader.read(file, { size: 100, mtimeMs: 1 }), []);
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    assert.deepEqual(await reader.read(file), [1]);
  });

  it('同じファイルの並行読み込みは 1 回の走査を共有する', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }) + line({ kind: 'keep', n: 2 }));
    const { reader, calls } = makeReader();
    const [a, b, c] = await Promise.all([reader.read(file), reader.read(file), reader.read(file)]);
    assert.deepEqual(a, [1, 2]);
    assert.equal(b, a);
    assert.equal(c, a);
    assert.equal(calls.collect, 2);
  });

  it('キャッシュが cacheMax 件に達したら捨てて読み直す', async () => {
    const fileA = await tmpFile('a.jsonl');
    const fileB = await tmpFile('b.jsonl');
    await writeFile(fileA, line({ kind: 'keep', n: 1 }));
    await writeFile(fileB, line({ kind: 'keep', n: 2 }));
    const { reader, calls } = makeReader({ cacheMax: 2 });
    await reader.read(fileA);
    await reader.read(fileB);
    // 2 件ではまだ捨てない
    await reader.read(fileA);
    assert.equal(calls.collect, 2);

    const fileC = await tmpFile('c.jsonl');
    await writeFile(fileC, line({ kind: 'keep', n: 3 }));
    await reader.read(fileC);
    // C を足すときに捨てたので A は読み直しになる
    assert.deepEqual(await reader.read(fileA), [1]);
    assert.equal(calls.collect, 4);
  });

  it('clear() で次回は先頭から読み直す', async () => {
    const file = await tmpFile();
    await writeFile(file, line({ kind: 'keep', n: 1 }));
    const { reader, calls } = makeReader();
    await reader.read(file);
    reader.clear();
    assert.deepEqual(await reader.read(file), [1]);
    assert.equal(calls.collect, 2);
    assert.equal(calls.create, 2);
  });
});
