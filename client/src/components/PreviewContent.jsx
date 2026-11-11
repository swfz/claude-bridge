import CodeBlock from './CodeBlock.jsx';
import { MAX_TABLE_ROWS } from '../utils/delimited.js';

// PreviewDrawer と PreviewPip で共用する本文の部品。

// YAML frontmatter を GitHub 風の key/value テーブルとして表示する
export function FrontmatterTable({ data }) {
  return (
    <table className="frontmatter-table">
      <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key}>
            <th>{key}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Markdown 内のコードブロックを CodeBlock でハイライト表示する（インラインはそのまま）。
// pre をハンドルすることで、言語指定なしのコードブロック（className なし）も
// CodeBlock を通り、枠線・背景が統一される。
export const markdownComponents = {
  pre({ children }) {
    const codeEl = Array.isArray(children) ? children[0] : children;
    const className = codeEl?.props?.className;
    const codeChildren = codeEl?.props?.children;
    return <CodeBlock className={className}>{codeChildren}</CodeBlock>;
  },
};

// テキスト系（コード・表・種別なしのフォールバック）の本文。読み込み状態で描き分ける。
// source は usePreviewSource() の戻り値。
export function PreviewTextBody({ source }) {
  const { loadError, fallbackNotice, fileContent, showTable, table, tableColumnCount, highlightedHtml, codeLinesHtml } =
    source;
  if (loadError) return <pre className="drawer-text">読み込みに失敗しました</pre>;
  if (fallbackNotice) {
    return (
      <div className="drawer-unsupported">
        <p>
          {fallbackNotice === 'binary'
            ? 'バイナリファイルのためテキスト表示できません（別タブで開く）'
            : '5MB を超えるためテキスト表示しません（別タブで開く）'}
        </p>
      </div>
    );
  }
  if (fileContent == null) return <pre className="drawer-text">読み込み中...</pre>;
  if (showTable && table) {
    const columns = Array.from({ length: tableColumnCount }, (_, i) => i);
    return (
      <div className="drawer-table-wrap">
        <table className="drawer-table">
          <thead>
            <tr data-line="1">
              <th className="drawer-table-ln">1</th>
              {columns.map((i) => (
                <th key={i}>{table.header[i] ?? ''}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.line} data-line={row.line}>
                <td className="drawer-table-ln">{row.line}</td>
                {columns.map((i) => (
                  <td key={i}>{row.cells[i] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.truncated && (
          <div className="drawer-table-note">先頭 {MAX_TABLE_ROWS} 行のみ表示（全体はテキスト表示で）</div>
        )}
      </div>
    );
  }
  // 行番号は .drawer-code-line::before で描く（textContent に入れないので
  // 選択範囲から行・列を出す計算はソースと一致したまま）
  return (
    <pre className={`drawer-text ${highlightedHtml ? 'hljs' : ''}`}>
      <code dangerouslySetInnerHTML={{ __html: codeLinesHtml || '' }} />
    </pre>
  );
}
