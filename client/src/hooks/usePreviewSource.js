import { useEffect, useMemo, useState } from 'react';
import { EXT_TO_LANG, highlightCode } from '../highlight.js';
import { splitFrontmatter } from '../frontmatter.js';
import {
  IMAGE_EXTS,
  HTML_EXTS,
  PDF_EXTS,
  VIDEO_EXTS,
  TEXT_EXTS,
  MARKDOWN_EXTS,
  TABLE_EXTS,
  getExt,
} from '../utils/previewExts.js';
import { delimiterFor, parseDelimited } from '../utils/delimited.js';
import { looksBinary } from '../utils/binaryText.js';
import { buildCodeLinesHtml } from '../utils/codeLines.js';
import { previewUrl } from '../utils/previewUrl.js';

// プレビュー種別が無いファイルをテキストとして読むときの上限。
// ここだけ小さいのは「表示できるか分からないものを丸ごとブラウザに載せる」経路なので、
// 巨大なログやダンプで画面が固まらないようにするため（超えたら本文を読まずに案内を出す）。
const FALLBACK_MAX_BYTES = 5 * 1024 * 1024;

// プレビューの「何をどう描くか」と本文の読み込みをまとめた hook。
// PreviewDrawer（レビュー付き）と PreviewPip（PiP 窓の閲覧専用）で共用する。
export function usePreviewSource({ filePath, markdown, title, tableMode }) {
  const isMarkdownMode = !!markdown;
  const ext = filePath ? getExt(filePath) : '';
  const fileName = filePath ? filePath.split('/').pop() : title || 'プレビュー';
  const isImage = IMAGE_EXTS.includes(ext);
  const isHtml = HTML_EXTS.includes(ext);
  const isPdf = PDF_EXTS.includes(ext);
  const isVideo = VIDEO_EXTS.includes(ext);
  const isText = TEXT_EXTS.includes(ext);
  const isMarkdownFile = MARKDOWN_EXTS.includes(ext);
  const isTable = TABLE_EXTS.includes(ext);
  // 既知の種別がないファイル（拡張子なしを含む）はテキストとして読んでみる。
  // ファイラからはこれらもクリックできるので、「非対応」で何も見えない状態にはしない。
  const isFallbackText = !isMarkdownMode && !!filePath && !(isImage || isHtml || isPdf || isVideo || isText);
  const [fileContent, setFileContent] = useState(null);
  const [loadError, setLoadError] = useState(false);
  // フォールバック経路で本文を出さなかった理由（'binary' | 'too-large'）
  const [fallbackNotice, setFallbackNotice] = useState(null);

  // HTML は iframe で描画するが、コメントの行・前後文脈を出すためにソースも読む。
  // 種別のないファイル（isFallbackText）もテキストとして読むが、こちらだけは
  // サイズ上限とバイナリ判定を通してから本文に載せる。
  useEffect(() => {
    if (isMarkdownMode || !filePath) return undefined;
    if (!(isText || isMarkdownFile || isHtml || isFallbackText)) return undefined;
    setFileContent(null);
    setLoadError(false);
    setFallbackNotice(null);
    let cancelled = false;
    fetch(previewUrl(filePath))
      .then(async (res) => {
        // 上限超えは本文を読まずに案内だけ出す（Content-Length が無ければ読んで判断するしかない）
        const size = Number(res.headers.get('Content-Length'));
        if (isFallbackText && Number.isFinite(size) && size > FALLBACK_MAX_BYTES) {
          if (!cancelled) setFallbackNotice('too-large');
          return;
        }
        const text = await res.text();
        if (cancelled) return;
        if (isFallbackText && looksBinary(text)) {
          setFallbackNotice('binary');
          return;
        }
        setFileContent(text);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, isText, isMarkdownFile, isHtml, isFallbackText, isMarkdownMode]);

  // 行ピック・選択位置の計算がソースの行番号を前提にする「テキストの本文」かどうか。
  // 表モード（CSV/TSV）も同じソースの行を指すので isCodeView に含め、
  // 実際に pre で描くか table で描くかは showCode / showTable で分ける。
  const isCodeView = !isMarkdownMode && ((isText && !isMarkdownFile) || isFallbackText);
  const showTable = isCodeView && isTable && tableMode;
  const showCode = isCodeView && !showTable;

  const lang = ext ? EXT_TO_LANG[ext.slice(1)] : null;
  const highlightedHtml = useMemo(
    () => (showCode && fileContent != null ? highlightCode(fileContent, lang) : null),
    [fileContent, lang, showCode],
  );

  // コード/テキストは 1 行 1 要素にして、行番号ガターと行ピックの位置決めに使う
  const codeLinesHtml = useMemo(
    () => (showCode && fileContent != null ? buildCodeLinesHtml(fileContent, highlightedHtml) : null),
    [showCode, fileContent, highlightedHtml],
  );

  // 表モードで描く行。列数が不揃いなら足りないセルは空で埋めるので、最大列数も出す
  const table = useMemo(
    () => (showTable && fileContent != null ? parseDelimited(fileContent, delimiterFor(ext)) : null),
    [showTable, fileContent, ext],
  );
  const tableColumnCount = useMemo(
    () => (table ? table.rows.reduce((max, row) => Math.max(max, row.cells.length), table.header.length) : 0),
    [table],
  );

  const markdownToRender = isMarkdownMode ? markdown : isMarkdownFile ? fileContent : null;

  // frontmatter をテーブル表示、本文だけを Markdown としてレンダリングする
  const { frontmatter, body: markdownBody } = useMemo(
    () => splitFrontmatter(markdownToRender || ''),
    [markdownToRender],
  );

  return {
    isMarkdownMode,
    ext,
    fileName,
    isImage,
    isHtml,
    isPdf,
    isVideo,
    isText,
    isMarkdownFile,
    isTable,
    isFallbackText,
    fileContent,
    loadError,
    fallbackNotice,
    isCodeView,
    showTable,
    showCode,
    highlightedHtml,
    codeLinesHtml,
    table,
    tableColumnCount,
    markdownToRender,
    frontmatter,
    markdownBody,
  };
}
