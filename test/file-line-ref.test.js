import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  displayRef,
  findFileLineRefs,
  jumpMissReason,
  lineSuffix,
  looksLikePath,
  matchDiffFile,
  parseFileLineRef,
  relativeToRoot,
  resolveDiffPath,
} from '../client/src/utils/fileLineRef.js';
import { remarkFileLineRefs, splitTextNode } from '../client/src/utils/remarkFileLineRefs.js';
import { rehypeMarkBlockCode } from '../client/src/utils/rehypeMarkBlockCode.js';

describe('parseFileLineRef（インラインコードの中身）', () => {
  it('拾う書き方', () => {
    assert.deepEqual(parseFileLineRef('src/app.js:42'), { path: 'src/app.js', line: 42, endLine: null });
    assert.deepEqual(parseFileLineRef('src/app.js:42-50'), { path: 'src/app.js', line: 42, endLine: 50 });
    assert.deepEqual(parseFileLineRef('src/app.js:L42'), { path: 'src/app.js', line: 42, endLine: null });
    assert.deepEqual(parseFileLineRef('src/app.js:L42-L50'), { path: 'src/app.js', line: 42, endLine: 50 });
    assert.deepEqual(parseFileLineRef('src/app.js#L42'), { path: 'src/app.js', line: 42, endLine: null });
    assert.deepEqual(parseFileLineRef('src/app.js#L42-L50'), { path: 'src/app.js', line: 42, endLine: 50 });
    assert.deepEqual(parseFileLineRef('/abs/path/app.js:42'), { path: '/abs/path/app.js', line: 42, endLine: null });
    assert.deepEqual(parseFileLineRef(' app.js:7:12 '), { path: 'app.js', line: 7, endLine: null });
    assert.deepEqual(parseFileLineRef('../a.js:3'), { path: '../a.js', line: 3, endLine: null });
    assert.deepEqual(parseFileLineRef('node_modules/@scope/pkg/i.js:2'), {
      path: 'node_modules/@scope/pkg/i.js',
      line: 2,
      endLine: null,
    });
    // 拡張子が無くても / を含めばパス
    assert.deepEqual(parseFileLineRef('scripts/run:4'), { path: 'scripts/run', line: 4, endLine: null });
    // 終わりが同じ行なら範囲にしない
    assert.deepEqual(parseFileLineRef('a.js:5-5'), { path: 'a.js', line: 5, endLine: null });
  });

  it('誤検出しない', () => {
    for (const text of [
      'src/app.js',
      'http://host:8080',
      'localhost:3000',
      '12:30',
      'a:b',
      'note:42',
      'v1.2:3',
      'C:\\foo\\bar.js:12',
      'C:/foo/bar.js:12',
      'a.js:0',
      'a.js:10-5',
      'a.js:42x',
      '~/x/a.md:3',
      'user@host.com:22',
      '3/4:1',
      '10.0.0.1/24:1',
      null,
    ]) {
      assert.equal(parseFileLineRef(text), null, String(text));
    }
  });

  it('looksLikePath', () => {
    assert.equal(looksLikePath('README.md'), true);
    assert.equal(looksLikePath('dir/x'), true);
    assert.equal(looksLikePath('word'), false);
    assert.equal(looksLikePath('..'), false);
    assert.equal(looksLikePath('dir/'), false);
    assert.equal(looksLikePath(''), false);
    assert.equal(looksLikePath(1), false);
  });
});

describe('findFileLineRefs（地の文）', () => {
  const pick = (text) => findFileLineRefs(text).map((r) => [r.raw, r.path, r.line, r.endLine]);

  it('文中の path:行 を拾い、句読点は含めない', () => {
    assert.deepEqual(pick('修正は src/app.js:42 と server/index.js:10-12 です。'), [
      ['src/app.js:42', 'src/app.js', 42, null],
      ['server/index.js:10-12', 'server/index.js', 10, 12],
    ]);
    assert.deepEqual(pick('see /abs/a.ts:3.'), [['/abs/a.ts:3', '/abs/a.ts', 3, null]]);
    assert.deepEqual(pick('(README.md#L5)'), [['README.md#L5', 'README.md', 5, null]]);
    const [r] = findFileLineRefs('x src/a.js:1 y');
    assert.equal(r.start, 2);
    assert.equal(r.end, 12);
  });

  it('URL・時刻・語・ドライブ文字・続きのある数字は拾わない', () => {
    assert.deepEqual(pick('http://localhost:8080/a.js:3 を開く'), []);
    assert.deepEqual(pick('https://example.com/src/app.js:42'), []);
    assert.deepEqual(pick('12:30 に開始、ratio a:b、note:42'), []);
    assert.deepEqual(pick('C:\\work\\app.js:12'), []);
    assert.deepEqual(pick('src/app.js:42abc'), []);
    assert.deepEqual(pick('src/app.js:42.5'), []);
    assert.deepEqual(pick('host:8080'), []);
    // ドメイン・host:port・バージョン・メールアドレス風・分数・IP・home
    assert.deepEqual(pick('foo.bar:3000 と api.example.com:8080'), []);
    assert.deepEqual(pick('user@host.com:22 に ssh'), []);
    assert.deepEqual(pick('比率 3/4:1、ネットワーク 10.0.0.1/24:1'), []);
    assert.deepEqual(pick('~/a.js:3 を見る'), []);
    // / を含まないものはプレビューできる拡張子のときだけ（Node.js:18 は拾うが、存在確認で素の文字のまま）
    assert.deepEqual(pick('Node.js:18 以上'), [['Node.js:18', 'Node.js', 18, null]]);
    assert.deepEqual(pick('../a.js:3'), [['../a.js:3', '../a.js', 3, null]]);
    assert.deepEqual(pick(''), []);
    assert.deepEqual(pick(null), []);
  });
});

describe('remarkFileLineRefs', () => {
  const text = (value) => ({ type: 'text', value });

  it('テキストノードを分けてインラインコード（data-bare）にする', () => {
    const parts = splitTextNode(text('見る: src/a.js:4 ね'));
    assert.deepEqual(parts, [
      text('見る: '),
      { type: 'inlineCode', value: 'src/a.js:4', data: { hProperties: { 'data-bare': 'true' } } },
      text(' ね'),
    ]);
    assert.equal(splitTextNode(text('何もない')), null);
    assert.equal(splitTextNode(text('src/a.js:4')).length, 1);
  });

  it('コードブロック・インラインコード・リンクの中は触らない', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [text('a src/x.js:1'), { type: 'emphasis', children: [text('b/c.md:2')] }] },
        { type: 'code', value: 'src/y.js:3' },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: 'src/z.js:4' }] },
        { type: 'link', url: 'u', children: [text('src/w.js:5')] },
      ],
    };
    remarkFileLineRefs()(tree);
    const [p1, code, p2, link] = tree.children;
    assert.equal(p1.children.length, 3);
    assert.equal(p1.children[1].value, 'src/x.js:1');
    assert.equal(p1.children[2].children[0].type, 'inlineCode');
    assert.equal(code.value, 'src/y.js:3');
    assert.equal(p2.children[0].data, undefined);
    assert.equal(link.children[0].type, 'text');
  });
});

describe('差分のパスとの突き合わせ', () => {
  it('relativeToRoot / resolveDiffPath', () => {
    assert.equal(relativeToRoot('src/a.js'), 'src/a.js');
    assert.equal(relativeToRoot('./src/a.js'), 'src/a.js');
    assert.equal(relativeToRoot('/repo/src/a.js', { root: '/repo/' }), 'src/a.js');
    // cwd がリポジトリの中のサブディレクトリ
    assert.equal(relativeToRoot('/repo/pkg/a.js', { root: '/repo', cwd: '/repo/pkg' }), 'pkg/a.js');
    // cwd がシンボリックリンク等で root と表記が違う: サーバーの cwdPrefix を前置する
    assert.deepEqual(
      resolveDiffPath('/tmp/x/sub/a.js', { root: '/private/tmp/x', cwd: '/tmp/x/sub', cwdPrefix: 'sub/' }),
      {
        rel: 'sub/a.js',
        exact: true,
      },
    );
    assert.deepEqual(resolveDiffPath('/link/wt/a.js', { root: '/real/wt', cwd: '/link/wt', cwdPrefix: '' }), {
      rel: 'a.js',
      exact: true,
    });
    // cwdPrefix が無いと cwd からの相対としか分からない
    assert.deepEqual(resolveDiffPath('/tmp/x/sub/a.js', { root: '/private/tmp/x', cwd: '/tmp/x/sub' }), {
      rel: 'a.js',
      exact: false,
    });
    assert.equal(relativeToRoot('/elsewhere/a.js', { root: '/repo', cwd: '/repo' }), null);
    assert.equal(relativeToRoot('/x/a.js'), null);
    assert.equal(relativeToRoot(''), null);
  });

  it('matchDiffFile は完全一致、無ければ末尾一致が 1 つだけのとき', () => {
    const files = [{ path: 'src/a.js' }, { path: 'pkg/one/b.js' }, { path: 'pkg/two/b.js' }];
    assert.equal(matchDiffFile(files, '/repo/src/a.js', { root: '/repo' }), files[0]);
    assert.equal(matchDiffFile(files, 'a.js'), files[0]);
    assert.equal(matchDiffFile(files, 'b.js'), null);
    assert.equal(matchDiffFile(files, 'one/b.js'), files[1]);
    assert.equal(matchDiffFile(files, '/other/a.js', { root: '/repo' }), null);
    assert.equal(matchDiffFile(null, 'a.js'), null);
  });

  it('cwd 起点でしか相対にできないときは、リポジトリ直下の同名ファイルに当てない', () => {
    const files = [{ path: 'a.js' }, { path: 'sub/a.js' }];
    const where = { root: '/private/tmp/x', cwd: '/tmp/x/sub' };
    // cwdPrefix 無し: 完全一致（直下の a.js）は使わず、末尾一致の sub/a.js
    assert.equal(matchDiffFile(files, '/tmp/x/sub/a.js', where), files[1]);
    assert.equal(matchDiffFile([{ path: 'a.js' }], '/tmp/x/sub/a.js', where), null);
    // cwdPrefix 有り
    assert.equal(matchDiffFile(files, '/tmp/x/sub/a.js', { ...where, cwdPrefix: 'sub/' }), files[1]);
  });

  it('表記', () => {
    assert.equal(lineSuffix({ line: 4 }), ':4');
    assert.equal(lineSuffix({ line: 4, endLine: 6 }), ':4-6');
    assert.equal(displayRef('/repo/src/a.js', { line: 4 }), 'a.js:4');
    assert.equal(displayRef('/repo/src/a.js', { line: 4, endLine: 5 }, 'src/a.js'), 'src/a.js:4-5');
    assert.equal(displayRef(null, { line: 1 }), ':1');
  });
});

describe('rehypeMarkBlockCode', () => {
  it('pre の中の code にだけ data-block を付ける', () => {
    const code = { type: 'element', tagName: 'code', properties: { className: ['x'] }, children: [] };
    const inline = { type: 'element', tagName: 'code', children: [] };
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'pre', children: [code, { type: 'text', value: '' }] },
        { type: 'element', tagName: 'p', children: [inline] },
      ],
    };
    rehypeMarkBlockCode()(tree);
    assert.deepEqual(tree.children[0].children[0].properties, { className: ['x'], 'data-block': 'true' });
    assert.equal(inline.properties, undefined);
  });
});

describe('jumpMissReason', () => {
  const rows = [{ kind: 'ctx' }];
  it('ファイルが差分にあるとき: 行を出していない理由', () => {
    assert.equal(jumpMissReason({ file: { tooLarge: true }, rows: [] }).text, '差分が大きく行を出していない');
    assert.equal(jumpMissReason({ file: { binary: true }, rows: [] }).text, 'バイナリで行が無い');
    assert.equal(jumpMissReason({ file: { sensitive: true }, rows: [] }).text, '中身を出していない');
    assert.equal(jumpMissReason({ file: { symlink: true }, rows: [] }).text, '中身を出していない');
    assert.deepEqual(jumpMissReason({ file: { status: 'committed' }, rows: [] }), {
      text: '差分に無い行',
      title: 'このファイルに行の差分はありません',
    });
    assert.equal(jumpMissReason({ file: {}, rows }).title, 'この行は変更されていません');
  });

  it('ファイルが無いとき: このセッションなら「全体で探す」、特定できなければその旨', () => {
    assert.equal(jumpMissReason({ file: null, scope: 'session', rel: 'a.js' }).searchAll, true);
    assert.equal(jumpMissReason({ file: null, scope: 'all', rel: 'a.js' }).searchAll, undefined);
    assert.match(jumpMissReason({ file: null, scope: 'all', rel: null }).title, /リポジトリの外/);
    assert.equal(jumpMissReason({ file: null, scope: 'session', rel: null }).searchAll, undefined);
  });
});
