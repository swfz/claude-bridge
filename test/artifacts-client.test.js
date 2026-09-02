import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectArtifacts } from '../client/src/utils/artifacts.js';

const artifactMsg = (url, { title, path, timestamp } = {}) => ({
  role: 'artifact',
  content: title || url,
  url,
  title,
  path,
  timestamp,
});

describe('collectArtifacts', () => {
  it('空配列・null・undefined でも落ちない', () => {
    assert.deepEqual(collectArtifacts([]), []);
    assert.deepEqual(collectArtifacts(null), []);
    assert.deepEqual(collectArtifacts(undefined), []);
  });

  it('artifact 以外のメッセージは無視する', () => {
    const messages = [
      { role: 'human', content: 'やって' },
      { role: 'assistant', content: 'やりました' },
      // url が無い artifact は出さない
      { role: 'artifact', content: 'こわれている' },
    ];
    assert.deepEqual(collectArtifacts(messages), []);
  });

  it('同じ URL への再デプロイは 1 件にまとめ、count に回数を持つ', () => {
    const messages = [
      artifactMsg('https://claude.ai/code/artifact/a', {
        title: '初版',
        path: '/tmp/a.html',
        timestamp: '2026-06-19T01:00:00.000Z',
      }),
      artifactMsg('https://claude.ai/code/artifact/a', {
        title: '第 2 版',
        path: '/tmp/a2.html',
        timestamp: '2026-06-19T02:00:00.000Z',
      }),
    ];

    const result = collectArtifacts(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 2);
    // title/path は最後の publish のもの
    assert.equal(result[0].title, '第 2 版');
    assert.equal(result[0].path, '/tmp/a2.html');
    assert.equal(result[0].lastTimestamp, '2026-06-19T02:00:00.000Z');
  });

  it('最新の publish が先頭に来る', () => {
    const messages = [
      artifactMsg('https://claude.ai/code/artifact/old', { title: '古い', timestamp: '2026-06-18T00:00:00.000Z' }),
      artifactMsg('https://claude.ai/code/artifact/new', { title: '新しい', timestamp: '2026-06-20T00:00:00.000Z' }),
      artifactMsg('https://claude.ai/code/artifact/mid', { title: '中間', timestamp: '2026-06-19T00:00:00.000Z' }),
    ];

    assert.deepEqual(
      collectArtifacts(messages).map((a) => a.title),
      ['新しい', '中間', '古い'],
    );
  });

  it('timestamp が無い場合は後に来たものを最新として扱う', () => {
    const messages = [
      artifactMsg('https://claude.ai/code/artifact/a', { title: '先', path: '/tmp/1.html' }),
      artifactMsg('https://claude.ai/code/artifact/a', { title: '後', path: '/tmp/2.html' }),
    ];

    const result = collectArtifacts(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, '後');
    assert.equal(result[0].path, '/tmp/2.html');
  });

  it('title が無ければ content、それも無ければ URL を使う', () => {
    const url = 'https://claude.ai/code/artifact/x';
    assert.equal(collectArtifacts([{ role: 'artifact', url, content: '本文だけ' }])[0].title, '本文だけ');
    assert.equal(collectArtifacts([{ role: 'artifact', url }])[0].title, url);
  });

  it('path が無ければ null', () => {
    const result = collectArtifacts([artifactMsg('https://claude.ai/code/artifact/x', { title: 't' })]);
    assert.equal(result[0].path, null);
  });
});
