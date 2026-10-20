import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import rehypeSourceLineDefault, { rehypeSourceLine } from '../client/src/utils/rehypeSourceLine.js';

const pos = (line) => ({ start: { line, column: 1 }, end: { line, column: 10 } });

function run(tree) {
  rehypeSourceLine()(tree);
  return tree;
}

describe('rehypeSourceLine', () => {
  it('default export も同じプラグイン', () => {
    assert.equal(rehypeSourceLineDefault, rehypeSourceLine);
  });

  it('position を持つ要素に開始行を data-source-line として付ける', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'element', tagName: 'h1', properties: { id: 'title' }, position: pos(1), children: [] },
        { type: 'element', tagName: 'p', position: pos(3), children: [] },
      ],
    });
    assert.deepEqual(tree.children[0].properties, { id: 'title', 'data-source-line': 1 });
    assert.deepEqual(tree.children[1].properties, { 'data-source-line': 3 });
  });

  it('ネストした要素にも付ける', () => {
    const tree = run({
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'ul',
          position: pos(5),
          children: [{ type: 'element', tagName: 'li', position: pos(6), children: [] }],
        },
      ],
    });
    assert.equal(tree.children[0].properties['data-source-line'], 5);
    assert.equal(tree.children[0].children[0].properties['data-source-line'], 6);
  });

  it('position の無い要素・要素以外のノードには付けない', () => {
    const tree = run({
      type: 'root',
      position: pos(1),
      children: [
        { type: 'element', tagName: 'div', properties: {}, children: [] },
        { type: 'text', value: 'hello', position: pos(2) },
        { type: 'element', tagName: 'span', position: { start: {} }, children: [] },
      ],
    });
    assert.equal(tree.properties, undefined);
    assert.deepEqual(tree.children[0].properties, {});
    assert.equal(tree.children[1].properties, undefined);
    assert.equal(tree.children[2].properties, undefined);
  });
});
