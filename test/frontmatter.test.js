import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter } from '../client/src/frontmatter.js';

describe('splitFrontmatter', () => {
  it('frontmatter と本文に分ける', () => {
    const md = '---\ntitle: Hello\ndate: 2026-10-21\n---\n# Body\n';
    assert.deepEqual(splitFrontmatter(md), {
      frontmatter: { title: 'Hello', date: '2026-10-21' },
      body: '# Body\n',
    });
  });

  it('frontmatter が無ければ本文そのまま', () => {
    assert.deepEqual(splitFrontmatter('# Title\n\ntext'), { frontmatter: null, body: '# Title\n\ntext' });
  });

  it('閉じの --- が無ければ frontmatter として扱わない', () => {
    const md = '---\ntitle: Hello\n# Body\n';
    assert.deepEqual(splitFrontmatter(md), { frontmatter: null, body: md });
  });

  it('先頭以外の --- は frontmatter として扱わない', () => {
    const md = 'intro\n---\ntitle: x\n---\n';
    assert.deepEqual(splitFrontmatter(md), { frontmatter: null, body: md });
  });

  it('CRLF と先頭の BOM を許容する', () => {
    assert.deepEqual(splitFrontmatter('﻿---\r\ntitle: Hello\r\n---\r\nbody'), {
      frontmatter: { title: 'Hello' },
      body: 'body',
    });
  });

  it('閉じの --- の直後で文書が終わってもよい', () => {
    assert.deepEqual(splitFrontmatter('---\ntitle: Hello\n---'), { frontmatter: { title: 'Hello' }, body: '' });
  });

  it('値の前後のクォートを外し、値に含まれる : はそのまま残す', () => {
    const md = '---\na: "quoted"\nb: \'single\'\nurl: https://example.com\ntags: [a, b]\n---\n';
    assert.deepEqual(splitFrontmatter(md).frontmatter, {
      a: 'quoted',
      b: 'single',
      url: 'https://example.com',
      tags: '[a, b]',
    });
  });

  it('空行・コメント行・: の無い行・キーが空の行は無視する', () => {
    const md = '---\n\n# comment\nno colon\n: novalue\nkey: v\n---\nbody';
    assert.deepEqual(splitFrontmatter(md), { frontmatter: { key: 'v' }, body: 'body' });
  });

  it('有効なキーが無ければ frontmatter は null だが本文からは取り除く', () => {
    assert.deepEqual(splitFrontmatter('---\n# only comment\n---\nbody'), { frontmatter: null, body: 'body' });
  });

  it('文字列以外は frontmatter なし', () => {
    assert.deepEqual(splitFrontmatter(undefined), { frontmatter: null, body: '' });
    assert.deepEqual(splitFrontmatter(null), { frontmatter: null, body: '' });
    assert.deepEqual(splitFrontmatter(42), { frontmatter: null, body: 42 });
  });
});
