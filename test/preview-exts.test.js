import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_EXTS,
  HTML_EXTS,
  PDF_EXTS,
  VIDEO_EXTS,
  TEXT_EXTS,
  MARKDOWN_EXTS,
  TABLE_EXTS,
  PREVIEWABLE_EXTS,
  getExt,
  isPreviewable,
} from '../client/src/utils/previewExts.js';

describe('拡張子の分類', () => {
  it('代表的な拡張子が期待どおりの配列に入る', () => {
    assert.ok(IMAGE_EXTS.includes('.png'));
    assert.ok(IMAGE_EXTS.includes('.svg'));
    assert.ok(HTML_EXTS.includes('.html'));
    assert.ok(PDF_EXTS.includes('.pdf'));
    assert.ok(VIDEO_EXTS.includes('.mp4'));
    assert.ok(VIDEO_EXTS.includes('.mov'));
    assert.ok(TEXT_EXTS.includes('.js'));
    assert.ok(TEXT_EXTS.includes('.json'));
    assert.deepEqual(MARKDOWN_EXTS, ['.md']);
    assert.deepEqual(TABLE_EXTS, ['.csv', '.tsv']);
  });

  it('画像・HTML・PDF・動画・テキストは互いに重複しない', () => {
    const groups = { IMAGE_EXTS, HTML_EXTS, PDF_EXTS, VIDEO_EXTS, TEXT_EXTS };
    const seen = new Map();
    for (const [name, exts] of Object.entries(groups)) {
      assert.equal(new Set(exts).size, exts.length, `${name} 内の重複`);
      for (const ext of exts) {
        assert.ok(!seen.has(ext), `${ext} が ${seen.get(ext)} と ${name} の両方にある`);
        seen.set(ext, name);
      }
    }
  });

  it('Markdown と表はテキストの部分集合(テキストとしても読める)', () => {
    for (const ext of [...MARKDOWN_EXTS, ...TABLE_EXTS]) {
      assert.ok(TEXT_EXTS.includes(ext), ext);
    }
  });

  it('拡張子は全て小文字・ドット始まり', () => {
    for (const ext of PREVIEWABLE_EXTS) {
      assert.match(ext, /^\.[a-z0-9]+$/);
    }
  });

  it('PREVIEWABLE_EXTS は画像・HTML・PDF・動画・テキストの和', () => {
    assert.deepEqual(PREVIEWABLE_EXTS, [...IMAGE_EXTS, ...HTML_EXTS, ...PDF_EXTS, ...VIDEO_EXTS, ...TEXT_EXTS]);
  });
});

describe('getExt', () => {
  it('末尾の拡張子を小文字で返す', () => {
    assert.equal(getExt('/a/b/photo.PNG'), '.png');
    assert.equal(getExt('archive.tar.gz'), '.gz');
  });

  it('拡張子が無ければ空文字', () => {
    assert.equal(getExt('/a/b/Makefile'), '');
    assert.equal(getExt('dir.d/'), '');
    assert.equal(getExt(''), '');
    assert.equal(getExt(undefined), '');
    assert.equal(getExt(null), '');
  });
});

describe('isPreviewable', () => {
  it('対応形式は true', () => {
    for (const path of ['a.png', 'b.HTML', 'c.pdf', 'd.webm', 'e.md', 'f.csv', 'g.sqlx']) {
      assert.equal(isPreviewable(path), true, path);
    }
  });

  it('非対応・拡張子なしは false', () => {
    for (const path of ['a.zip', 'b.exe', 'Makefile', '', undefined]) {
      assert.equal(isPreviewable(path), false, String(path));
    }
  });
});
