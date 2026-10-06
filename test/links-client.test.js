import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectLinks, extractUrls, extractUrlsFromToolInput, linksToMarkdown } from '../client/src/utils/links.js';

describe('extractUrls', () => {
  it('空文字・null・文字列以外は空配列', () => {
    assert.deepEqual(extractUrls(''), []);
    assert.deepEqual(extractUrls(null), []);
    assert.deepEqual(extractUrls(undefined), []);
    assert.deepEqual(extractUrls(42), []);
  });

  it('Markdown リンクは label 付きで拾う', () => {
    assert.deepEqual(extractUrls('詳細は [公式ドキュメント](https://example.com/docs) を参照'), [
      { url: 'https://example.com/docs', label: '公式ドキュメント' },
    ]);
  });

  it('Markdown リンクのタイトル付き形式も拾う', () => {
    assert.deepEqual(extractUrls('[a](https://example.com/a "タイトル")'), [
      { url: 'https://example.com/a', label: 'a' },
    ]);
  });

  it('山括弧の形式と裸の URL は label null', () => {
    assert.deepEqual(extractUrls('<https://a.example.com/x> と http://b.example.com/y'), [
      { url: 'https://a.example.com/x', label: null },
      { url: 'http://b.example.com/y', label: null },
    ]);
  });

  it('末尾の句読点・閉じ括弧を剥がす', () => {
    const text =
      'https://a.example.com/1. https://a.example.com/2, (https://a.example.com/3) https://a.example.com/4。 https://a.example.com/5、 https://a.example.com/6!?';
    assert.deepEqual(
      extractUrls(text).map((h) => h.url),
      [1, 2, 3, 4, 5, 6].map((n) => `https://a.example.com/${n}`),
    );
  });

  it('全角の閉じ括弧で URL を切る', () => {
    assert.deepEqual(
      extractUrls('（https://example.com/a）「https://example.com/b」『https://example.com/c』').map((h) => h.url),
      ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    );
  });

  it('括弧付き URL は釣り合う閉じ括弧を残す', () => {
    assert.deepEqual(
      extractUrls('see https://en.wikipedia.org/wiki/Foo_(bar).').map((h) => h.url),
      ['https://en.wikipedia.org/wiki/Foo_(bar)'],
    );
    assert.deepEqual(
      extractUrls('(https://en.wikipedia.org/wiki/Foo_(bar))').map((h) => h.url),
      ['https://en.wikipedia.org/wiki/Foo_(bar)'],
    );
    // Markdown リンクの中の括弧付き URL
    assert.deepEqual(extractUrls('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))'), [
      { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', label: 'Foo' },
    ]);
  });

  it('同じ URL が複数回あれば出現順にすべて返す', () => {
    const text =
      'https://example.com/a と [A](https://example.com/a) と https://example.com/b と https://example.com/a';
    assert.deepEqual(extractUrls(text), [
      { url: 'https://example.com/a', label: null },
      { url: 'https://example.com/a', label: 'A' },
      { url: 'https://example.com/b', label: null },
      { url: 'https://example.com/a', label: null },
    ]);
  });

  it('http(s) 以外のスキームは拾わない', () => {
    assert.deepEqual(extractUrls('file:///tmp/a.html ftp://example.com/x mailto:a@example.com'), []);
  });
});

describe('extractUrlsFromToolInput', () => {
  it('ネストした input の文字列から拾う', () => {
    const input = {
      url: 'https://example.com/fetch',
      prompt: '要点',
      nested: { list: ['curl https://api.example.com/v1/items?limit=10', 3, null] },
    };
    assert.deepEqual(extractUrlsFromToolInput(input), [
      { url: 'https://example.com/fetch', label: null },
      { url: 'https://api.example.com/v1/items?limit=10', label: null },
    ]);
  });

  it('深すぎるネストは打ち切る', () => {
    const input = { a: { b: { c: { d: { e: 'https://deep.example.com/' } } } } };
    assert.deepEqual(extractUrlsFromToolInput(input), []);
  });

  it('Markdown リンクでも label は付けない', () => {
    assert.deepEqual(extractUrlsFromToolInput({ body: '[x](https://example.com/x)' }), [
      { url: 'https://example.com/x', label: null },
    ]);
  });

  it('null・数値でも落ちない', () => {
    assert.deepEqual(extractUrlsFromToolInput(null), []);
    assert.deepEqual(extractUrlsFromToolInput(undefined), []);
    assert.deepEqual(extractUrlsFromToolInput(1), []);
  });
});

describe('collectLinks', () => {
  it('空配列・null・undefined で落ちない', () => {
    assert.deepEqual(collectLinks([]), []);
    assert.deepEqual(collectLinks(null), []);
    assert.deepEqual(collectLinks(undefined), []);
    assert.deepEqual(collectLinks([null, { role: 'human' }, { role: 'assistant', toolUses: [null] }]), []);
  });

  it('URL ごとにまとめ、sources・count・uuid を持つ', () => {
    const messages = [
      { role: 'human', content: 'https://example.com/a を見て', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z' },
      {
        role: 'assistant',
        content: '[A の説明](https://example.com/a) です',
        toolUses: [{ id: 't1', name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } }],
        uuid: 'u2',
        timestamp: '2026-01-01T00:01:00Z',
      },
      {
        role: 'artifact',
        content: 'レポート',
        url: 'https://claude.ai/code/artifact/x',
        title: 'レポート',
        uuid: 'u3',
        timestamp: '2026-01-01T00:02:00Z',
      },
    ];

    const result = collectLinks(messages);
    assert.equal(result.length, 2);

    const artifact = result[0];
    assert.deepEqual(artifact, {
      url: 'https://claude.ai/code/artifact/x',
      label: 'レポート',
      host: 'claude.ai',
      count: 1,
      sources: ['artifact'],
      firstUuid: 'u3',
      lastUuid: 'u3',
      lastTimestamp: '2026-01-01T00:02:00Z',
    });

    const a = result[1];
    assert.equal(a.url, 'https://example.com/a');
    // 最初に見つかった非空 label
    assert.equal(a.label, 'A の説明');
    assert.equal(a.host, 'example.com');
    assert.equal(a.count, 3);
    assert.deepEqual(a.sources, ['human', 'assistant', 'tool:WebFetch']);
    assert.equal(a.firstUuid, 'u1');
    assert.equal(a.lastUuid, 'u2');
    assert.equal(a.lastTimestamp, '2026-01-01T00:01:00Z');
  });

  it('label は最初に見つかった非空のものを採り、後から来ても上書きしない', () => {
    const messages = [
      { role: 'human', content: 'https://example.com/a', uuid: 'u1' },
      { role: 'assistant', content: '[最初](https://example.com/a)', uuid: 'u2' },
      { role: 'assistant', content: '[二番目](https://example.com/a)', uuid: 'u3' },
    ];
    assert.equal(collectLinks(messages)[0].label, '最初');
  });

  it('最後の出現が新しい順。timestamp が無ければメッセージの出現順で比べる', () => {
    const withTs = [
      { role: 'human', content: 'https://example.com/old', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'human', content: 'https://example.com/new', uuid: 'u2', timestamp: '2026-01-03T00:00:00Z' },
      { role: 'human', content: 'https://example.com/mid', uuid: 'u3', timestamp: '2026-01-02T00:00:00Z' },
    ];
    assert.deepEqual(
      collectLinks(withTs).map((l) => l.url),
      ['https://example.com/new', 'https://example.com/mid', 'https://example.com/old'],
    );

    const withoutTs = [
      { role: 'human', content: 'https://example.com/a https://example.com/b' },
      { role: 'assistant', content: 'https://example.com/a をもう一度' },
    ];
    assert.deepEqual(
      collectLinks(withoutTs).map((l) => l.url),
      ['https://example.com/a', 'https://example.com/b'],
    );
  });

  it('対象外の role や http 以外のスキームは拾わない', () => {
    const messages = [
      { role: 'system', content: 'https://example.com/system' },
      { role: 'human', content: 'file:///tmp/a.html' },
      { role: 'artifact', url: 'file:///tmp/a.html', title: 'x' },
    ];
    assert.deepEqual(collectLinks(messages), []);
  });

  it('human のツール入力は見ない（toolUses は assistant だけ）', () => {
    const messages = [
      { role: 'human', content: '', toolUses: [{ name: 'X', input: { url: 'https://example.com/' } }] },
    ];
    assert.deepEqual(collectLinks(messages), []);
  });
});

describe('linksToMarkdown', () => {
  it('label があれば label、無ければ URL を表示文字列にする', () => {
    const links = [
      { url: 'https://example.com/a', label: 'A' },
      { url: 'https://example.com/b', label: null },
    ];
    assert.equal(
      linksToMarkdown(links),
      '- [A](https://example.com/a)\n- [https://example.com/b](https://example.com/b)',
    );
  });

  it('空配列・null は空文字', () => {
    assert.equal(linksToMarkdown([]), '');
    assert.equal(linksToMarkdown(null), '');
  });
});
