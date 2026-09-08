import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TABLE_ROWS, delimiterFor, parseDelimited } from '../client/src/utils/delimited.js';

describe('delimited: delimiterFor', () => {
  it('.tsv はタブ、それ以外はカンマ', () => {
    assert.equal(delimiterFor('.tsv'), '\t');
    assert.equal(delimiterFor('.csv'), ',');
    assert.equal(delimiterFor(''), ',');
  });
});

describe('delimited: parseDelimited', () => {
  it('1 行目をヘッダにし、2 行目以降を行として返す', () => {
    const { header, rows, truncated } = parseDelimited('a,b,c\n1,2,3\n4,5,6\n');
    assert.deepEqual(header, ['a', 'b', 'c']);
    assert.deepEqual(
      rows.map((r) => r.cells),
      [
        ['1', '2', '3'],
        ['4', '5', '6'],
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.line),
      [2, 3],
    );
    assert.equal(truncated, false);
  });

  it('引用フィールド内の区切り文字とエスケープされた引用符を保つ', () => {
    const { rows } = parseDelimited('a,b\n"x,y","say ""hi""."\n');
    assert.deepEqual(rows[0].cells, ['x,y', 'say "hi".']);
  });

  it('引用フィールド内の改行は 1 レコードのまま、次のレコードの開始行はずれる', () => {
    const { header, rows } = parseDelimited('a,b\n"1\n2",x\ny,z\n');
    assert.deepEqual(header, ['a', 'b']);
    assert.deepEqual(rows[0].cells, ['1\n2', 'x']);
    assert.equal(rows[0].line, 2);
    assert.deepEqual(rows[1].cells, ['y', 'z']);
    // 2 行を占めるレコードの次なので 4 行目から
    assert.equal(rows[1].line, 4);
  });

  it('CRLF 改行でも同じ結果になる（\\r を持ち込まない）', () => {
    const { header, rows } = parseDelimited('a,b\r\n1,2\r\n3,4\r\n');
    assert.deepEqual(header, ['a', 'b']);
    assert.deepEqual(
      rows.map((r) => r.cells),
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.line),
      [2, 3],
    );
  });

  it('空セル・列数の不揃いをそのまま返す', () => {
    const { header, rows } = parseDelimited('a,b,c\n1,,3\n4\n5,6,7,8\n');
    assert.deepEqual(header, ['a', 'b', 'c']);
    assert.deepEqual(rows[0].cells, ['1', '', '3']);
    assert.deepEqual(rows[1].cells, ['4']);
    assert.deepEqual(rows[2].cells, ['5', '6', '7', '8']);
  });

  it('末尾の空行は無視する（最後の改行だけ・複数の空行とも）', () => {
    assert.equal(parseDelimited('a,b\n1,2\n').rows.length, 1);
    assert.equal(parseDelimited('a,b\n1,2\n\n\n').rows.length, 1);
    assert.equal(parseDelimited('a,b\n1,2').rows.length, 1);
  });

  it('空文字列ではヘッダも行も空', () => {
    const { header, rows, truncated } = parseDelimited('');
    assert.deepEqual(header, []);
    assert.deepEqual(rows, []);
    assert.equal(truncated, false);
  });

  it('上限を超えたら truncated で打ち切る', () => {
    const lines = ['a,b'];
    for (let i = 1; i <= MAX_TABLE_ROWS + 5; i++) lines.push(`${i},x`);
    const { rows, truncated } = parseDelimited(lines.join('\n') + '\n');
    assert.equal(truncated, true);
    assert.equal(rows.length, MAX_TABLE_ROWS);
    assert.deepEqual(rows[rows.length - 1].cells, [String(MAX_TABLE_ROWS), 'x']);
  });

  it('ちょうど上限のときは truncated にしない（末尾の空行でも増えない）', () => {
    const lines = ['a,b'];
    for (let i = 1; i <= MAX_TABLE_ROWS; i++) lines.push(`${i},x`);
    const { rows, truncated } = parseDelimited(lines.join('\n') + '\n\n');
    assert.equal(truncated, false);
    assert.equal(rows.length, MAX_TABLE_ROWS);
  });

  it('TSV はタブで区切り、カンマはセルの中身として扱う', () => {
    const { header, rows } = parseDelimited('a\tb\n1,1\t2\n', '\t');
    assert.deepEqual(header, ['a', 'b']);
    assert.deepEqual(rows[0].cells, ['1,1', '2']);
  });

  it('TSV でも引用フィールドを解釈する', () => {
    const { rows } = parseDelimited('a\tb\n"x\ty"\tz\n', '\t');
    assert.deepEqual(rows[0].cells, ['x\ty', 'z']);
  });
});
