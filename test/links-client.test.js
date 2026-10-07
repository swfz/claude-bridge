import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLinks,
  contextOf,
  extractUrls,
  extractUrlsFromToolInput,
  linksToMarkdown,
} from '../client/src/utils/links.js';

// index / end を除いた {url, label} だけを比べる
const urlsAndLabels = (hits) => hits.map(({ url, label }) => ({ url, label }));

describe('extractUrls', () => {
  it('空文字・null・文字列以外は空配列', () => {
    assert.deepEqual(extractUrls(''), []);
    assert.deepEqual(extractUrls(null), []);
    assert.deepEqual(extractUrls(undefined), []);
    assert.deepEqual(extractUrls(42), []);
  });

  it('Markdown リンクは label 付きで拾う', () => {
    // index / end は Markdown 記法全体の範囲
    assert.deepEqual(extractUrls('詳細は [公式ドキュメント](https://example.com/docs) を参照'), [
      { url: 'https://example.com/docs', label: '公式ドキュメント', index: 4, end: 40 },
    ]);
  });

  it('Markdown リンクのタイトル付き形式も拾う', () => {
    assert.deepEqual(urlsAndLabels(extractUrls('[a](https://example.com/a "タイトル")')), [
      { url: 'https://example.com/a', label: 'a' },
    ]);
  });

  it('山括弧の形式と裸の URL は label null', () => {
    // 山括弧は記法全体、裸の URL は剥がした後の URL の範囲
    assert.deepEqual(extractUrls('<https://a.example.com/x> と http://b.example.com/y.'), [
      { url: 'https://a.example.com/x', label: null, index: 0, end: 25 },
      { url: 'http://b.example.com/y', label: null, index: 28, end: 50 },
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
    assert.deepEqual(urlsAndLabels(extractUrls('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))')), [
      { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', label: 'Foo' },
    ]);
  });

  it('同じ URL が複数回あれば出現順にすべて返す', () => {
    const text =
      'https://example.com/a と [A](https://example.com/a) と https://example.com/b と https://example.com/a';
    assert.deepEqual(urlsAndLabels(extractUrls(text)), [
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
    // 文脈は URL を含む文字列ごとに取る（url だけの文字列は null）
    assert.deepEqual(extractUrlsFromToolInput(input), [
      { url: 'https://example.com/fetch', label: null, context: null },
      { url: 'https://api.example.com/v1/items?limit=10', label: null, context: 'curl 〔リンク〕' },
    ]);
  });

  it('深すぎるネストは打ち切る', () => {
    const input = { a: { b: { c: { d: { e: 'https://deep.example.com/' } } } } };
    assert.deepEqual(extractUrlsFromToolInput(input), []);
  });

  it('Markdown リンクでも label は付けない', () => {
    assert.deepEqual(extractUrlsFromToolInput({ body: '[x](https://example.com/x)' }), [
      { url: 'https://example.com/x', label: null, context: null },
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
      origin: 'claude',
      label: 'レポート',
      title: null,
      code: null,
      // Artifact の title は label に出すので文脈にはしない
      context: null,
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

describe('contextOf', () => {
  const ctx = (text, url) => {
    const hit = extractUrls(text).find((h) => h.url === url);
    return contextOf(text, hit.index, hit.end);
  };

  it('URL が出てきた行から URL を除いた前後を 1 行にする', () => {
    const text = '前の行\n障害の原因は  https://example.com/issue/1 に詳しい\n次の行';
    assert.equal(ctx(text, 'https://example.com/issue/1'), '障害の原因は 〔リンク〕 に詳しい');
  });

  it('自分の Markdown リンクは記法ごと目印に置き換える', () => {
    assert.equal(
      ctx('詳細は [公式](https://example.com/docs) を参照', 'https://example.com/docs'),
      '詳細は 〔リンク〕 を参照',
    );
  });

  it('同じ行の他の URL は落とし、Markdown リンクはラベルだけ残す', () => {
    const text = '参考: [PR](https://github.com/x/y/pull/1) と https://example.com/a と <https://example.com/b> を比較';
    assert.equal(ctx(text, 'https://example.com/a'), '参考: PR と 〔リンク〕 と を比較');
    assert.equal(ctx(text, 'https://github.com/x/y/pull/1'), '参考: 〔リンク〕 と と を比較');
  });

  it('URL だけの箇条書きが続くときは、URL だけの行を飛ばして説明の行まで遡る', () => {
    const text = '参考:\n- https://a.example/x\n- [B](https://b.example/y)\n- https://c.example/z';
    assert.equal(ctx(text, 'https://a.example/x'), '参考:');
    assert.equal(ctx(text, 'https://b.example/y'), '参考:');
    // ラベル付きの Markdown リンクの行はラベルが残るので、そこで止まる
    assert.equal(ctx(text, 'https://c.example/z'), '- B');
    const bare = '参考:\n- https://a.example/x\n- https://b.example/y';
    assert.equal(ctx(bare, 'https://a.example/x'), '参考:');
    assert.equal(ctx(bare, 'https://b.example/y'), '参考:');
    // 直前の行に説明があれば、他のリンクはラベルに縮めて使う
    const labeled = '[設計メモ](https://d.example/m) の続き:\nhttps://e.example/n';
    assert.equal(ctx(labeled, 'https://e.example/n'), '設計メモ の続き:');
  });

  it('同じ行に 2 つのリンクがあれば、それぞれ自分の位置を目印にし、相手はラベルで残す', () => {
    const text =
      '参考: [claude-bridge の PR](https://github.com/swfz/claude-bridge/pull/1) と https://example.com/docs/health。';
    assert.equal(ctx(text, 'https://github.com/swfz/claude-bridge/pull/1'), '参考: 〔リンク〕 と 。');
    assert.equal(ctx(text, 'https://example.com/docs/health'), '参考: claude-bridge の PR と 〔リンク〕。');
  });

  it('目印の隣の空白は原文にあったときだけ残す', () => {
    assert.equal(ctx('（https://example.com/a）を参照', 'https://example.com/a'), '（〔リンク〕）を参照');
  });

  it('前後が長ければ URL を中心に切って … を付ける', () => {
    const text = `${'前'.repeat(100)} https://example.com/x ${'後'.repeat(100)}`;
    assert.equal(ctx(text, 'https://example.com/x'), `…${'前'.repeat(60)} 〔リンク〕 ${'後'.repeat(60)}…`);
  });

  it('行が URL だけなら直前の非空行を使う', () => {
    const text = '参考にした資料:\n\n- https://example.com/ref';
    assert.equal(ctx(text, 'https://example.com/ref'), '参考にした資料:');
    const long = `${'あ'.repeat(130)}\nhttps://example.com/ref`;
    assert.equal(ctx(long, 'https://example.com/ref'), `${'あ'.repeat(120)}…`);
  });

  it('直前の行も無ければ null', () => {
    assert.equal(ctx('https://example.com/only', 'https://example.com/only'), null);
    assert.equal(contextOf('', 0, 0), null);
  });
});

describe('collectLinks の文脈とタイトル', () => {
  const fetchUse = (url, prompt) => ({ id: 't', name: 'WebFetch', input: { url, prompt } });

  it('WebFetch の url には prompt を、Bash は URL を含む行を文脈にする', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        toolUses: [
          fetchUse('https://example.com/a', 'このページの\n要点を抜き出して'),
          { id: 'b', name: 'Bash', input: { command: 'cd /tmp\ncurl -s https://api.example.com/v1 | jq .items' } },
        ],
        uuid: 'a1',
      },
    ];
    const byUrl = Object.fromEntries(collectLinks(messages).map((l) => [l.url, l]));
    assert.equal(byUrl['https://example.com/a'].context, 'このページの 要点を抜き出して');
    assert.equal(byUrl['https://api.example.com/v1'].context, 'curl -s 〔リンク〕 | jq .items');
  });

  it('文脈は human > assistant > tool の順、同順位なら最初の出現を採る', () => {
    const messages = [
      { role: 'assistant', content: '応答の文脈 https://example.com/a', uuid: 'a1' },
      { role: 'assistant', toolUses: [fetchUse('https://example.com/a', 'prompt の文脈')], uuid: 'a2' },
      { role: 'human', content: '最初の指示 https://example.com/a', uuid: 'h1' },
      { role: 'human', content: '二度目の指示 https://example.com/a', uuid: 'h2' },
    ];
    assert.equal(collectLinks(messages)[0].context, '最初の指示 〔リンク〕');
  });

  it('webfetch メッセージは既存項目に title / code を付け、count は増やさない', () => {
    const messages = [
      { role: 'assistant', toolUses: [fetchUse('https://example.com/a', '要約して')], uuid: 'a1' },
      { role: 'webfetch', url: 'https://example.com/a', title: '取得したページ', code: 200, uuid: 'w1' },
    ];
    const [link] = collectLinks(messages);
    assert.equal(link.title, '取得したページ');
    assert.equal(link.code, 200);
    assert.equal(link.count, 1);
    assert.deepEqual(link.sources, ['tool:WebFetch']);
    // webfetch のレコードはチャットに描かないのでジャンプ先は tool_use 側のまま
    assert.equal(link.lastUuid, 'a1');
  });

  it('title が null の webfetch は既存の title を消さず、code だけ更新する', () => {
    const messages = [
      { role: 'assistant', toolUses: [fetchUse('https://example.com/a', 'x')], uuid: 'a1' },
      { role: 'webfetch', url: 'https://example.com/a', title: '一度目', code: 200 },
      { role: 'webfetch', url: 'https://example.com/a', title: null, code: 301 },
    ];
    const [link] = collectLinks(messages);
    assert.equal(link.title, '一度目');
    assert.equal(link.code, 301);
  });

  it('対応する項目が無ければ tool:WebFetch として作る', () => {
    const messages = [
      { role: 'webfetch', url: 'https://example.com/b', title: 'B', code: 200, uuid: 'w1', timestamp: 't1' },
      { role: 'webfetch', url: 'file:///tmp/x', title: 'x', code: 200 },
    ];
    assert.deepEqual(collectLinks(messages), [
      {
        url: 'https://example.com/b',
        origin: 'claude',
        label: null,
        title: 'B',
        code: 200,
        context: null,
        host: 'example.com',
        count: 1,
        sources: ['tool:WebFetch'],
        firstUuid: null,
        lastUuid: null,
        lastTimestamp: 't1',
      },
    ]);
  });
});

describe('collectLinks の origin', () => {
  it('注入レコード（injected な human）が先に出した URL は origin が claude、source は system', () => {
    const messages = [
      { role: 'human', injected: true, content: '<task-notification>結果: https://example.com/a</task-notification>' },
      { role: 'human', content: 'https://example.com/a で進めて' },
    ];
    const [link] = collectLinks(messages);
    assert.equal(link.origin, 'claude');
    assert.deepEqual(link.sources, ['system', 'human']);
    // 文脈は人の指示が優先される
    assert.equal(link.context, '〔リンク〕 で進めて');
  });

  it('最初の出現が human なら user（後で Claude が触れても変わらない）', () => {
    const messages = [
      { role: 'human', content: 'https://example.com/a を読んで', uuid: 'h1' },
      { role: 'assistant', toolUses: [{ name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } }] },
    ];
    assert.equal(collectLinks(messages)[0].origin, 'user');
  });

  it('Claude が先に出して後で human が引用したら claude', () => {
    const messages = [
      { role: 'assistant', content: '候補は https://example.com/a です', uuid: 'a1' },
      { role: 'human', content: 'https://example.com/a で進めて', uuid: 'h1' },
    ];
    const [link] = collectLinks(messages);
    assert.equal(link.origin, 'claude');
    // 文脈は human が優先される（origin とは独立）
    assert.equal(link.context, '〔リンク〕 で進めて');
  });

  it('ツール入力・Artifact・webfetch だけの項目は claude', () => {
    const messages = [
      { role: 'assistant', toolUses: [{ name: 'Bash', input: { command: 'curl https://example.com/t' } }] },
      { role: 'artifact', url: 'https://claude.ai/code/artifact/x', title: 'r' },
      { role: 'webfetch', url: 'https://example.com/w', title: 'W', code: 200 },
    ];
    assert.deepEqual(
      collectLinks(messages).map((l) => l.origin),
      ['claude', 'claude', 'claude'],
    );
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

  it('label が無ければ title を使い、文脈があれば — で添える', () => {
    const links = [
      { url: 'https://example.com/a', label: null, title: '取得したページ', context: '要約して' },
      { url: 'https://example.com/b', label: 'B', title: '無視される', context: null },
    ];
    assert.equal(
      linksToMarkdown(links),
      '- [取得したページ](https://example.com/a) — 要約して\n- [B](https://example.com/b)',
    );
  });

  it('空配列・null は空文字', () => {
    assert.equal(linksToMarkdown([]), '');
    assert.equal(linksToMarkdown(null), '');
  });
});
