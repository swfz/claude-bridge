import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildCodeLinesHtml, escapeHtml, splitHighlightedLines } from '../client/src/utils/codeLines.js';

// 組み立てた HTML の textContent 相当（タグを除いてエンティティを戻したもの）
function textContentOf(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('codeLines: escapeHtml', () => {
  it('HTML 特殊文字を実体参照にする', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('codeLines: splitHighlightedLines', () => {
  it('null はそのまま null', () => assert.equal(splitHighlightedLines(null), null));

  it('行をまたぐ span は行ごとに閉じて開き直す', () => {
    const lines = splitHighlightedLines('<span class="hljs-comment">/* a\nb */</span> x');
    assert.deepEqual(lines, ['<span class="hljs-comment">/* a</span>', '<span class="hljs-comment">b */</span> x']);
  });

  it('行数はソースの改行数と一致する', () => {
    const lines = splitHighlightedLines('a\n<span class="k">b</span>\n\nc');
    assert.equal(lines.length, 4);
    assert.deepEqual(lines, ['a', '<span class="k">b</span>', '', 'c']);
  });

  it('ネストした span も順序どおり開き直す', () => {
    const lines = splitHighlightedLines('<span class="a"><span class="b">1\n2</span></span>');
    assert.deepEqual(lines, [
      '<span class="a"><span class="b">1</span></span>',
      '<span class="a"><span class="b">2</span></span>',
    ]);
  });
});

describe('codeLines: buildCodeLinesHtml', () => {
  it('1 行 1 要素にして data-line を振る', () => {
    const html = buildCodeLinesHtml('a\nb', null);
    assert.equal(
      html,
      '<span class="drawer-code-line" data-line="1">a</span>\n<span class="drawer-code-line" data-line="2">b</span>',
    );
  });

  it('行の区切りは実際の改行なので textContent はソースと一致する', () => {
    const src = 'const x = "<b>&y</b>";\n\nif (x) {\n  return;\n}\n';
    assert.equal(textContentOf(buildCodeLinesHtml(src, null)), src);
  });

  it('ハイライト HTML を渡しても textContent はソースと一致する', () => {
    const src = '/* a\nb */\nx';
    const hl = '<span class="hljs-comment">/* a\nb */</span>\nx';
    const html = buildCodeLinesHtml(src, hl);
    assert.equal(textContentOf(html), src);
    assert.equal((html.match(/data-line=/g) || []).length, 3);
  });

  it('行数の合わないハイライトは使わず素のテキストにフォールバックする', () => {
    const html = buildCodeLinesHtml('a\nb', '<span>a</span>');
    assert.equal(html.includes('<span class="hljs'), false);
    assert.equal(textContentOf(html), 'a\nb');
  });

  it('空文字でも 1 行分の要素を返す', () => {
    assert.equal(buildCodeLinesHtml('', null), '<span class="drawer-code-line" data-line="1"></span>');
  });

  it('null も空の 1 行として扱う', () => {
    assert.equal(buildCodeLinesHtml(null, null), '<span class="drawer-code-line" data-line="1"></span>');
  });

  it('行数の合うハイライトはそのまま行要素の中に入れる', () => {
    const html = buildCodeLinesHtml('/* a\nb */', '<span class="hljs-comment">/* a\nb */</span>');
    assert.equal(
      html,
      '<span class="drawer-code-line" data-line="1"><span class="hljs-comment">/* a</span></span>\n' +
        '<span class="drawer-code-line" data-line="2"><span class="hljs-comment">b */</span></span>',
    );
  });
});

describe('codeLines: 境界', () => {
  it('escapeHtml は null・undefined を空文字にする', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('閉じタグの空白は無視してタグ名を照合する', () => {
    assert.deepEqual(splitHighlightedLines('<span class="a">x</span >\ny'), ['<span class="a">x</span >', 'y']);
  });

  it('入れ子の外側が先に閉じられても、閉じたタグだけを開き直しから外す', () => {
    assert.deepEqual(splitHighlightedLines('<b><i>x</b>\ny</i>'), ['<b><i>x</b></i>', '<i>y</i>']);
  });

  it('自己終了タグは開き直さない', () => {
    assert.deepEqual(splitHighlightedLines('<span class="a"><br/>x\ny</span>'), [
      '<span class="a"><br/>x</span>',
      '<span class="a">y</span>',
    ]);
  });
});
