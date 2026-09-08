// CSV / TSV を表として描くためのパーサ（純粋関数）。
//
// 区切り文字は拡張子で決める（.tsv はタブ・それ以外はカンマ）。
// 引用は RFC 4180 相当: `"` で囲まれたフィールドの中では区切り文字・改行をそのまま持ち、
// `""` は 1 個の `"` にほどく。改行は CRLF / LF の両方を 1 行として数える。
//
// 各レコードは「元テキスト上の開始行番号」（1 始まり）を持つ。引用の中に改行を含む
// レコードは複数行を占めるので、行ピック（数字キーで行を選ぶ）が指すのは開始行になる。

// ヘッダを除いて表に出す行数の上限。超えた分は truncated で切り落とす
export const MAX_TABLE_ROWS = 2000;

// 拡張子（先頭ドット付き・小文字）から区切り文字を決める
export function delimiterFor(ext) {
  return ext === '.tsv' ? '\t' : ',';
}

// レコードが「空行」（1 個の空フィールドだけ）かどうか
function isBlankRecord(record) {
  return record.cells.length === 1 && record.cells[0] === '';
}

// text を区切り文字で分解して { header, rows, truncated } を返す。
// 上限を超える入力でも一度は全部走査する（プレビューでは本文をすでに全文持っているため、
// 途中で打ち切ると「末尾の空行だけが上限を超えた」ケースを truncated と誤判定してしまう）。
export function parseDelimited(text, delimiter = ',') {
  const src = String(text ?? '');
  const records = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let line = 1; // 走査中の物理行
  let recordLine = 1; // 今組み立てているレコードの開始行

  const endField = () => {
    cells.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' && src[i + 1] === '\n') {
      endRecord();
      i++;
      line++;
      recordLine = line;
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  // 末尾に改行が無いときの書きかけレコードを取り込む
  if (field !== '' || cells.length > 0 || inQuotes) endRecord();

  // 末尾の空行は表に出さない（最後の改行の後ろにできる空レコードを含む）
  while (records.length > 0 && isBlankRecord(records[records.length - 1])) records.pop();

  const header = records.length > 0 ? records[0].cells : [];
  const body = records.slice(1);
  const truncated = body.length > MAX_TABLE_ROWS;
  return { header, rows: truncated ? body.slice(0, MAX_TABLE_ROWS) : body, truncated };
}
