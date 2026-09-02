import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, truncate } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSessionArtifacts, clearSessionArtifactsCache } from '../server/session-artifacts.js';

const line = (record) => JSON.stringify(record) + '\n';

const publishRecord = (url, { title, path, timestamp, toolUseId = 'toolu_1' } = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: 'Published' }] },
  toolUseResult: { url, path, title },
  timestamp,
});

// 「頭 40 行・末尾 128KB」の外に publish を置くための埋め草
const fillerLine = (i) =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `埋め草 ${i} `.repeat(60) }] },
    timestamp: '2026-06-19T00:00:00.000Z',
  });

const fillerBlock = (count, offset = 0) => {
  let text = '';
  for (let i = 0; i < count; i++) text += fillerLine(i + offset);
  return text;
};

async function tmpFile(name = 'session.jsonl') {
  const dir = await mkdtemp(join(tmpdir(), 'cb-artifacts-'));
  return join(dir, name);
}

describe('readSessionArtifacts', () => {
  beforeEach(() => clearSessionArtifactsCache());

  it('先頭 40 行より後ろ・末尾 128KB より前にある publish も拾う', async () => {
    const file = await tmpFile();
    const url = 'https://claude.ai/code/artifact/mid';
    await writeFile(
      file,
      fillerBlock(80) +
        line(
          publishRecord(url, { title: '真ん中のページ', path: '/tmp/mid.html', timestamp: '2026-06-19T01:00:00.000Z' }),
        ) +
        // 末尾 128KB を publish で埋めないだけの埋め草（1 行 1KB 弱 × 400 行）
        fillerBlock(400, 1000),
    );

    const artifacts = await readSessionArtifacts(file);
    assert.deepEqual(artifacts, [
      { url, title: '真ん中のページ', path: '/tmp/mid.html', timestamp: '2026-06-19T01:00:00.000Z' },
    ]);
  });

  it('存在しないファイルは空配列', async () => {
    assert.deepEqual(await readSessionArtifacts(join(tmpdir(), 'cb-nope-artifacts.jsonl')), []);
  });

  it('publish が無いセッションは空配列', async () => {
    const file = await tmpFile();
    await writeFile(file, fillerBlock(10));
    assert.deepEqual(await readSessionArtifacts(file), []);
  });

  it('失敗（is_error）・toolUseResult が文字列・url を持たない read/list は拾わない', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      // publish 失敗（tool_result が is_error）
      line({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ng', is_error: true }] },
        toolUseResult: { url: 'https://claude.ai/code/artifact/failed' },
      }) +
        // 失敗時は toolUseResult が文字列
        line({
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: 't2', type: 'tool_result', content: 'ng' }] },
          toolUseResult: 'Error: publish failed https://claude.ai/code/artifact/str',
        }) +
        // read / list は url を持たない
        line({
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: 't3', type: 'tool_result', content: 'ok' }] },
          toolUseResult: { content: 'claude.ai の何か' },
        }),
    );

    assert.deepEqual(await readSessionArtifacts(file), []);
  });

  it('同じ URL への再デプロイは出現順にそのまま並ぶ（重複排除はしない）', async () => {
    const file = await tmpFile();
    const url = 'https://claude.ai/code/artifact/dup';
    await writeFile(
      file,
      line(publishRecord(url, { title: '初版', timestamp: '2026-06-19T01:00:00.000Z' })) +
        line(publishRecord(url, { title: '第 2 版', timestamp: '2026-06-19T02:00:00.000Z' })),
    );

    const artifacts = await readSessionArtifacts(file);
    assert.deepEqual(
      artifacts.map((a) => a.title),
      ['初版', '第 2 版'],
    );
  });

  it('追記を検知して読み足す（書きかけの行は改行が付いてから拾う）', async () => {
    const file = await tmpFile();
    await writeFile(file, line(publishRecord('https://claude.ai/code/artifact/a', { title: '1 枚目' })));
    assert.equal((await readSessionArtifacts(file)).length, 1);

    // 追記（完全な行）
    await appendFile(file, line(publishRecord('https://claude.ai/code/artifact/b', { title: '2 枚目' })));
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['1 枚目', '2 枚目'],
    );

    // 書きかけ（改行なし）は無視される
    const partial = line(publishRecord('https://claude.ai/code/artifact/c', { title: '3 枚目' })).slice(0, -1);
    await appendFile(file, partial);
    assert.equal((await readSessionArtifacts(file)).length, 2);

    // 改行が付いたら拾う
    await appendFile(file, '\n');
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['1 枚目', '2 枚目', '3 枚目'],
    );
  });

  it('マルチバイト文字を含む行の後でもオフセットがずれない', async () => {
    const file = await tmpFile();
    await writeFile(file, fillerBlock(3) + line(publishRecord('https://claude.ai/code/artifact/a', { title: 'あ' })));
    assert.equal((await readSessionArtifacts(file)).length, 1);

    await appendFile(
      file,
      fillerBlock(3, 100) + line(publishRecord('https://claude.ai/code/artifact/b', { title: 'い' })),
    );
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['あ', 'い'],
    );
  });

  it('ファイルが縮んだら先頭から読み直す', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      line(publishRecord('https://claude.ai/code/artifact/a', { title: '古い 1' })) +
        line(publishRecord('https://claude.ai/code/artifact/b', { title: '古い 2' })),
    );
    assert.equal((await readSessionArtifacts(file)).length, 2);

    // 作り直し（サイズが縮む）→ 前回のオフセット・結果は捨てる
    await writeFile(file, line(publishRecord('https://claude.ai/code/artifact/z', { title: '新しい' })));
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['新しい'],
    );
  });

  it('切り詰めだけで mtime が変わらない場合も先頭から読み直す', async () => {
    const file = await tmpFile();
    const content =
      line(publishRecord('https://claude.ai/code/artifact/a', { title: '1' })) +
      line(publishRecord('https://claude.ai/code/artifact/b', { title: '2' }));
    await writeFile(file, content);
    assert.equal((await readSessionArtifacts(file)).length, 2);

    await truncate(file, Buffer.byteLength(line(publishRecord('https://claude.ai/code/artifact/a', { title: '1' }))));
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['1'],
    );
  });

  it('title が無ければ path の basename、それも無ければ URL を使う', async () => {
    const file = await tmpFile();
    const url = 'https://claude.ai/code/artifact/noname';
    await writeFile(
      file,
      line(publishRecord(url, { path: '/tmp/report.html' })) +
        line(publishRecord('https://claude.ai/code/artifact/bare')),
    );

    const artifacts = await readSessionArtifacts(file);
    assert.equal(artifacts[0].title, 'report.html');
    assert.equal(artifacts[1].title, 'https://claude.ai/code/artifact/bare');
  });

  it('壊れた行があっても後続を読む', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      '{ "toolUseResult": broken claude.ai\n' +
        line(publishRecord('https://claude.ai/code/artifact/a', { title: 'ちゃんとした行' })),
    );
    assert.deepEqual(
      (await readSessionArtifacts(file)).map((a) => a.title),
      ['ちゃんとした行'],
    );
  });

  it('渡された fileStat を使って stat を省ける', async () => {
    const file = await tmpFile();
    await writeFile(file, line(publishRecord('https://claude.ai/code/artifact/a', { title: 'stat 渡し' })));
    const { stat } = await import('fs/promises');
    const fileStat = await stat(file);
    assert.equal((await readSessionArtifacts(file, fileStat)).length, 1);
  });
});

describe('readSessionArtifacts (並行呼び出し)', () => {
  it('同じファイルを同時に読んでも publish が二重に積まれない', async () => {
    clearSessionArtifactsCache();
    const dir = await mkdtemp(join(tmpdir(), 'session-artifacts-'));
    const filePath = join(dir, 's.jsonl');
    await writeFile(filePath, line(publishRecord('https://claude.ai/code/artifact/p', { title: '同時' })));
    const [a, b] = await Promise.all([readSessionArtifacts(filePath), readSessionArtifacts(filePath)]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal((await readSessionArtifacts(filePath)).length, 1);
  });
});
