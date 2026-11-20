import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  offsetToLineCol,
  getContext,
  getOccurrenceIndex,
  findOccurrenceOffset,
  findNearestHeading,
  getRootTextOffset,
  buildLocationInfo,
} from '../client/src/utils/previewLocation.js';

// テスト環境は node で DOM が無いので、使う分だけの小さな DOM を用意する。
// contains は自分自身も含む・compareDocumentPosition は文書順（前順）・子孫は CONTAINED_BY|FOLLOWING、
// TreeWalker は root 自身を返さない、という DOM の仕様に合わせてある
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const POS = { PRECEDING: 2, FOLLOWING: 4, CONTAINS: 8, CONTAINED_BY: 16 };

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  compareDocumentPosition(other) {
    if (other === this) return 0;
    if (this.contains(other)) return POS.CONTAINED_BY | POS.FOLLOWING;
    if (other.contains(this)) return POS.CONTAINS | POS.PRECEDING;
    let top = this;
    while (top.parentNode) top = top.parentNode;
    const order = [top, ...descendants(top)];
    return order.indexOf(other) > order.indexOf(this) ? POS.FOLLOWING : POS.PRECEDING;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this.nodeType = TEXT_NODE;
    this.nodeValue = value;
  }
  get textContent() {
    return this.nodeValue;
  }
}

class FakeElement extends FakeNode {
  constructor(tag, children = []) {
    super();
    this.nodeType = ELEMENT_NODE;
    this.tagName = tag.toUpperCase();
    this.childNodes = children.map((c) => (typeof c === 'string' ? new FakeText(c) : c));
    for (const c of this.childNodes) c.parentNode = this;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map((s) => s.trim().toUpperCase());
    if (tags.some((t) => !t)) throw new SyntaxError(`'${selector}' is not a valid selector`);
    return descendants(this).filter((n) => n.nodeType === ELEMENT_NODE && tags.includes(n.tagName));
  }
}

function descendants(node) {
  return node.childNodes.flatMap((c) => [c, ...descendants(c)]);
}

const el = (tag, ...children) => new FakeElement(tag, children);

function installFakeDom() {
  vi.stubGlobal('Node', { TEXT_NODE, ELEMENT_NODE, DOCUMENT_POSITION_FOLLOWING: POS.FOLLOWING });
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
  vi.stubGlobal('document', {
    createTreeWalker(root) {
      const texts = descendants(root).filter((n) => n.nodeType === TEXT_NODE);
      let i = 0;
      return { nextNode: () => texts[i++] || null };
    },
  });
}

describe('offsetToLineCol', () => {
  it('returns 1:1 at the start', () => {
    assert.deepEqual(offsetToLineCol('hello', 0), { line: 1, column: 1 });
  });

  it('returns column for first line', () => {
    assert.deepEqual(offsetToLineCol('hello world', 6), { line: 1, column: 7 });
  });

  it('returns line 2 after one newline', () => {
    assert.deepEqual(offsetToLineCol('a\nbc', 2), { line: 2, column: 1 });
    assert.deepEqual(offsetToLineCol('a\nbc', 3), { line: 2, column: 2 });
  });

  it('handles offset at end of multiline text', () => {
    const text = 'line1\nline2\nuseState';
    // offset 12 = 'u' position; 'line1\n' (6) + 'line2\n' (6) = 12
    assert.deepEqual(offsetToLineCol(text, 12), { line: 3, column: 1 });
  });

  it('clamps offset beyond text length', () => {
    const result = offsetToLineCol('abc', 999);
    assert.equal(result.line, 1);
    assert.equal(result.column, 4);
  });
});

describe('getContext', () => {
  it('returns surrounding text with newlines squashed', () => {
    const text = 'before text\nselected token\nafter text';
    const start = text.indexOf('selected token');
    const end = start + 'selected token'.length;
    const { before, after } = getContext(text, start, end, 30);
    assert.ok(before.includes('before text'));
    assert.ok(after.includes('after text'));
    assert.equal(before.includes('\n'), false);
    assert.equal(after.includes('\n'), false);
  });

  it('clamps span at boundaries', () => {
    const text = 'abc';
    const { before, after } = getContext(text, 0, 3, 30);
    assert.equal(before, '');
    assert.equal(after, '');
  });
});

describe('getOccurrenceIndex', () => {
  it('returns total occurrences and index of matching position', () => {
    const text = 'useState foo useState bar useState';
    const second = text.indexOf('useState', 1);
    const result = getOccurrenceIndex(text, 'useState', second);
    assert.equal(result.total, 3);
    assert.equal(result.index, 2);
  });

  it('returns total only when startOffset does not match any occurrence', () => {
    const text = 'useState foo useState';
    const result = getOccurrenceIndex(text, 'useState', 5);
    assert.equal(result.total, 2);
    assert.equal(result.index, 0);
  });

  it('returns zero for needles not found', () => {
    assert.deepEqual(getOccurrenceIndex('hello', 'useState', 0), { index: 0, total: 0 });
  });

  it('returns zero for empty needle', () => {
    assert.deepEqual(getOccurrenceIndex('hello', '', 0), { index: 0, total: 0 });
  });
});

describe('findOccurrenceOffset', () => {
  it('returns offset of N-th occurrence', () => {
    const text = 'useState foo useState bar useState';
    assert.equal(findOccurrenceOffset(text, 'useState', 1), 0);
    assert.equal(findOccurrenceOffset(text, 'useState', 2), text.indexOf('useState', 1));
    assert.equal(findOccurrenceOffset(text, 'useState', 3), text.lastIndexOf('useState'));
  });

  it('returns -1 when not found or out of range', () => {
    assert.equal(findOccurrenceOffset('abc', 'useState', 1), -1);
    assert.equal(findOccurrenceOffset('useState', 'useState', 2), -1);
    assert.equal(findOccurrenceOffset('useState', 'useState', 0), -1);
  });
});

describe('buildLocationInfo', () => {
  it('for code: builds L<line>:C<col> label with occurrence info', () => {
    const sourceText = 'import a;\nimport b;\nconst x = useState(0);\nconst y = useState(1);';
    const sel = 'useState';
    const start = sourceText.indexOf(sel);
    const end = start + sel.length;
    const info = buildLocationInfo({
      kind: 'code',
      sourceText,
      selectedText: sel,
      sourceStart: start,
      sourceEnd: end,
    });
    assert.match(info.label, /^L3:C\d+, 1\/2箇所目$/);
    assert.ok(info.contextBefore.includes('const x ='));
    assert.ok(info.contextAfter.includes('(0);'));
  });

  it('for code with single occurrence: omits N/M suffix', () => {
    const sourceText = 'const x = useState(0);';
    const start = sourceText.indexOf('useState');
    const info = buildLocationInfo({
      kind: 'code',
      sourceText,
      selectedText: 'useState',
      sourceStart: start,
      sourceEnd: start + 'useState'.length,
    });
    assert.match(info.label, /^L1:C\d+$/);
  });

  it('for markdown: uses heading and occurrence', () => {
    const sourceText = '# Intro\n\nbody useState here\n\n## Hooks\n\nmore useState\n';
    const start = sourceText.lastIndexOf('useState');
    const info = buildLocationInfo({
      kind: 'markdown',
      sourceText,
      selectedText: 'useState',
      sourceStart: start,
      sourceEnd: start + 'useState'.length,
      heading: { level: 2, text: 'Hooks' },
    });
    assert.ok(info.label.includes('Hooks'));
    assert.ok(info.label.includes('2/2箇所目'));
  });

  it('for html: builds L<line>:C<col> from the HTML source', () => {
    const sourceText = '<html>\n  <body>\n    <p>本文です</p>\n    <li>項目B: 別の選択対象</li>\n  </body>\n</html>';
    const sel = '項目B: 別の選択';
    const start = sourceText.indexOf(sel);
    const info = buildLocationInfo({
      kind: 'html',
      sourceText,
      selectedText: sel,
      sourceStart: start,
      sourceEnd: start + sel.length,
    });
    assert.match(info.label, /^L4:C\d+$/);
  });

  it('returns empty label when sourceText is missing', () => {
    const info = buildLocationInfo({
      kind: 'markdown',
      sourceText: null,
      selectedText: 'x',
      sourceStart: -1,
      sourceEnd: -1,
    });
    assert.equal(info.label, '');
    assert.equal(info.contextBefore, '');
  });

  it('sourceText が無ければ前後コンテキストも空のまま', () => {
    const info = buildLocationInfo({ kind: 'markdown', sourceText: undefined, selectedText: 'x', sourceStart: 0 });
    assert.deepEqual(info, { contextBefore: '', contextAfter: '', label: '' });
  });

  it('先頭（offset 0）からの選択でも前後コンテキストと行・列を出す', () => {
    const info = buildLocationInfo({
      kind: 'code',
      sourceText: 'foo bar',
      selectedText: 'foo',
      sourceStart: 0,
      sourceEnd: 3,
    });
    assert.deepEqual(info, { contextBefore: '', contextAfter: 'bar', label: 'L1:C1' });
  });

  it('空の選択（開始 = 終了）でも前後コンテキストを出す', () => {
    const info = buildLocationInfo({
      kind: 'code',
      sourceText: 'ab cd',
      selectedText: '',
      sourceStart: 2,
      sourceEnd: 2,
    });
    assert.equal(info.contextBefore, 'ab');
    assert.equal(info.contextAfter, 'cd');
  });

  it('位置が不明（負）・終了が開始より前なら前後コンテキストも位置ラベルも出さない', () => {
    const negative = buildLocationInfo({
      kind: 'code',
      sourceText: 'foo bar',
      selectedText: 'zzz',
      sourceStart: -1,
      sourceEnd: 3,
    });
    assert.deepEqual(negative, { contextBefore: '', contextAfter: '', label: '' });
    const reversed = buildLocationInfo({
      kind: 'markdown',
      sourceText: 'foo bar baz',
      selectedText: 'zzz',
      sourceStart: 5,
      sourceEnd: 3,
    });
    assert.equal(reversed.contextBefore, '');
    assert.equal(reversed.contextAfter, '');
  });

  it('text でも L<行>:C<列> を出す', () => {
    const info = buildLocationInfo({
      kind: 'text',
      sourceText: 'a\nbc',
      selectedText: 'c',
      sourceStart: 3,
      sourceEnd: 4,
    });
    assert.equal(info.label, 'L2:C2');
  });

  it('対応していない種類は見出しがあっても位置ラベルを出さない', () => {
    const info = buildLocationInfo({
      kind: 'image',
      sourceText: 'x',
      selectedText: 'x',
      sourceStart: 0,
      sourceEnd: 1,
      heading: { level: 1, text: 'H' },
    });
    assert.equal(info.label, '');
  });

  it('markdown で 1 箇所しか無ければ出現順を出さず、見出しと出現順は「, 」で区切る', () => {
    const single = buildLocationInfo({
      kind: 'markdown',
      sourceText: 'foo bar',
      selectedText: 'foo',
      sourceStart: 0,
      sourceEnd: 3,
      heading: { level: 2, text: '概要' },
    });
    assert.equal(single.label, '「概要」セクション');
    const multi = buildLocationInfo({
      kind: 'markdown',
      sourceText: 'foo bar foo',
      selectedText: 'foo',
      sourceStart: 8,
      sourceEnd: 11,
      heading: { level: 2, text: '概要' },
    });
    assert.equal(multi.label, '「概要」セクション, 2/2箇所目');
  });
});

describe('offsetToLineCol / getContext の境界', () => {
  it('負の offset は 1:1 として扱う', () => {
    assert.deepEqual(offsetToLineCol('abc', -1), { line: 1, column: 1 });
  });

  it('前後コンテキストの端の空白を落とし、連続する空白を 1 つに潰す', () => {
    const text = 'hello   big world  next';
    const start = text.indexOf('world');
    assert.deepEqual(getContext(text, start, start + 5), { before: 'hello big', after: 'next' });
  });
});

describe('findOccurrenceOffset の境界', () => {
  it('空の needle は見つからない扱い', () => {
    assert.equal(findOccurrenceOffset('abc', '', 1), -1);
  });

  it('見つからなければ -1（出現数より大きい順番も -1）', () => {
    assert.equal(findOccurrenceOffset('abc', 'x', 1), -1);
    assert.equal(findOccurrenceOffset('x', 'x', 3), -1);
  });
});

describe('getRootTextOffset（DOM）', () => {
  beforeEach(installFakeDom);
  afterEach(() => vi.unstubAllGlobals());

  const build = () => {
    const ab = new FakeText('ab');
    const cd = new FakeText('cd');
    const ef = new FakeText('ef');
    const root = el('div', el('p', ab), cd, el('span', ef));
    return { root, ab, cd, ef };
  };

  it('root 配下のテキストノードまでの累積文字数を返す', () => {
    const { root, ab, cd, ef } = build();
    assert.equal(getRootTextOffset(root, ab, 1), 1);
    assert.equal(getRootTextOffset(root, cd, 1), 3);
    assert.equal(getRootTextOffset(root, ef, 1), 5);
  });

  it('root・node が無い、または root の外の node なら -1', () => {
    const { root, ab } = build();
    assert.equal(getRootTextOffset(null, ab, 0), -1);
    assert.equal(getRootTextOffset(root, null, 0), -1);
    assert.equal(getRootTextOffset(root, new FakeText('outside'), 0), -1);
  });

  describe('node が要素（トリプルクリックなどで Range の端が要素になる）', () => {
    // root = <div><p>ab</p>cd<span>ef</span></div>
    it('要素の子の途中なら、要素の先頭までの文字数に offsetInNode 個の子の文字数を足す', () => {
      const { root } = build();
      assert.equal(getRootTextOffset(root, root, 1), 2);
      assert.equal(getRootTextOffset(root, root, 2), 4);
    });

    it('offsetInNode が 0 なら要素の先頭（root 自身なら 0）', () => {
      const { root } = build();
      const span = root.childNodes[2];
      assert.equal(getRootTextOffset(root, root, 0), 0);
      assert.equal(getRootTextOffset(root, span, 0), 4);
    });

    it('offsetInNode が子の数と同じなら要素の末尾', () => {
      const { root } = build();
      const p = root.childNodes[0];
      assert.equal(getRootTextOffset(root, p, 1), 2);
      assert.equal(getRootTextOffset(root, root, 3), 6);
    });

    it('offsetInNode が子の数を超えても要素の末尾として扱う', () => {
      const { root } = build();
      const p = root.childNodes[0];
      assert.equal(getRootTextOffset(root, p, 5), 2);
      assert.equal(getRootTextOffset(root, root, 99), 6);
    });

    it('空の要素は後ろに来る最初のテキストの位置、後ろにも無ければ root 全体の文字数', () => {
      const middle = el('br');
      const last = el('hr');
      const root = el('div', 'ab', middle, 'cd', last);
      assert.equal(getRootTextOffset(root, middle, 0), 2);
      assert.equal(getRootTextOffset(root, middle, 1), 2);
      assert.equal(getRootTextOffset(root, last, 0), 4);
    });

    it('ネストした要素でも子孫のテキストを数える', () => {
      // <div>x<section><p>ab</p><p><em>cd</em>ef</p></section>gh</div>
      const inner = el('p', el('em', 'cd'), 'ef');
      const section = el('section', el('p', 'ab'), inner);
      const root = el('div', 'x', section, 'gh');
      assert.equal(getRootTextOffset(root, section, 0), 1);
      assert.equal(getRootTextOffset(root, section, 1), 3);
      assert.equal(getRootTextOffset(root, section, 2), 7);
      assert.equal(getRootTextOffset(root, inner, 1), 5);
      assert.equal(getRootTextOffset(root, inner.childNodes[0], 0), 3);
    });

    it('要素の子がテキストノードでも、その子の先頭を指す', () => {
      const root = el('div', 'ab', 'cd');
      assert.equal(getRootTextOffset(root, root, 1), 2);
    });
  });

  it('root 自身がテキストノードなら（走査対象が無いので）-1', () => {
    const t = new FakeText('abc');
    assert.equal(getRootTextOffset(t, t, 1), -1);
  });
});

describe('findNearestHeading（DOM）', () => {
  beforeEach(installFakeDom);
  afterEach(() => vi.unstubAllGlobals());

  it('node より前にある直近の見出しの階層と（前後の空白を落とした）文字列を返す', () => {
    const target = new FakeText('b');
    const root = el('div', el('h1', 'Title'), el('p', 'a'), el('h2', '  Sub  '), el('p', target), el('h2', 'Later'));
    assert.deepEqual(findNearestHeading(target, root), { level: 2, text: 'Sub' });
  });

  it('見出しの中の node はその見出しを返し、見出しそのものも自分を返す', () => {
    const inner = new FakeText('Head');
    const h3 = el('h3', 'Other');
    const root = el('div', el('h1', inner), el('p', 'x'), h3);
    assert.deepEqual(findNearestHeading(inner, root), { level: 1, text: 'Head' });
    assert.deepEqual(findNearestHeading(h3, root), { level: 3, text: 'Other' });
  });

  it('前に見出しが無ければ null', () => {
    const target = new FakeText('x');
    const root = el('div', el('p', target), el('h1', 'T'));
    assert.equal(findNearestHeading(target, root), null);
  });

  it('root・node が無い、または root の外の node なら null', () => {
    const target = new FakeText('x');
    const root = el('div', el('h1', 'T'), el('p', target));
    assert.equal(findNearestHeading(null, root), null);
    assert.equal(findNearestHeading(target, null), null);
    assert.equal(findNearestHeading(new FakeText('y'), root), null);
  });
});
