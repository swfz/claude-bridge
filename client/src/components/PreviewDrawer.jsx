import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import { EXT_TO_LANG, highlightCode } from '../highlight.js';
import { splitFrontmatter } from '../frontmatter.js';
import { IMAGE_EXTS, HTML_EXTS, PDF_EXTS, TEXT_EXTS, MARKDOWN_EXTS, getExt } from '../utils/previewExts.js';
import CodeBlock from './CodeBlock.jsx';
import {
  buildLocationInfo,
  findNearestHeading,
  findOccurrenceOffset,
  getOccurrenceIndex,
  getRootTextOffset,
  offsetToLineCol,
} from '../utils/previewLocation.js';
import { resolveInjectedScheme } from '../utils/previewColorScheme.js';
import './PreviewDrawer.css';

// YAML frontmatter を GitHub 風の key/value テーブルとして表示する
function FrontmatterTable({ data }) {
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
const markdownComponents = {
  pre({ children }) {
    const codeEl = Array.isArray(children) ? children[0] : children;
    const className = codeEl?.props?.className;
    const codeChildren = codeEl?.props?.children;
    return <CodeBlock className={className}>{codeChildren}</CodeBlock>;
  },
};

// root 内テキストの、targetNode/targetOffset までの文字数を TreeWalker で求める（非再帰＝安全）。
function textOffsetIn(root, targetNode, targetOffset) {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n === targetNode) return total + targetOffset;
    total += n.textContent.length;
  }
  return -1;
}

// レンダリング後の各ブロック要素に、元 Markdown ソースの開始行を data-source-line として付ける。
// これで「レンダリング表示のままどの行由来か」を特定でき、コメントの行マーカーを置ける。
function rehypeSourceLine() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.position?.start?.line) {
        node.properties = node.properties || {};
        node.properties['data-source-line'] = node.position.start.line;
      }
      (node.children || []).forEach(visit);
    };
    visit(tree);
  };
}

function previewUrl(localPath) {
  return `/preview?path=${encodeURIComponent(localPath)}`;
}

let commentIdSeq = 0;

// 書きかけのレビュー項目。ドロワーは閉じるとアンマウントされる（App の previewData が null になる）ので、
// InputBar の drafts と同じくモジュールレベルに置いて同じファイルを開き直したときに復元する。
// キーは filePath（Markdown プレビューは title）。リロードで消えるのは書きかけとして許容する。
const reviewDrafts = new Map();

function reviewDraftKey(filePath, title) {
  if (filePath) return filePath;
  return title ? `md:${title}` : null;
}

export default function PreviewDrawer({
  filePath,
  markdown,
  title,
  reviewMode: _reviewMode,
  onClose,
  onReviewSubmit,
  onSaveComment,
  onDeleteComment,
  fileComments,
  responses,
}) {
  const isMarkdownMode = !!markdown;
  const ext = filePath ? getExt(filePath) : '';
  const fileName = filePath ? filePath.split('/').pop() : title || 'プレビュー';
  const isImage = IMAGE_EXTS.includes(ext);
  const isHtml = HTML_EXTS.includes(ext);
  const isPdf = PDF_EXTS.includes(ext);
  const isText = TEXT_EXTS.includes(ext);
  const isMarkdownFile = MARKDOWN_EXTS.includes(ext);
  const [fileContent, setFileContent] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const draftKey = reviewDraftKey(filePath, title);
  const [reviewItems, setReviewItems] = useState(() => (draftKey && reviewDrafts.get(draftKey)) || []);
  // 項目が変わるたびに下書きへ写す（空になったら消す）
  useEffect(() => {
    if (!draftKey) return;
    if (reviewItems.length === 0) reviewDrafts.delete(draftKey);
    else reviewDrafts.set(draftKey, reviewItems);
  }, [draftKey, reviewItems]);
  // このプレビューを開いている間に「残した」コメント（送信せず保存済み・参照用）
  const [savedComments, setSavedComments] = useState([]);
  const [selectionPopup, setSelectionPopup] = useState(null);
  const [editingId, setEditingId] = useState(null);
  // 本文左ガターに出すコメント行マーカー [{ line, top, comments:[{id,comment,quote}] }]
  const [lineMarkers, setLineMarkers] = useState([]);
  // クリックで開いている行マーカーのポップオーバー
  const [activeMarker, setActiveMarker] = useState(null);
  const bodyRef = useRef(null);
  const iframeRef = useRef(null);
  // iframe 内のリスナから最新のソースを参照するための箱
  const fileContentRef = useRef(null);

  // プレビュー本文だけをライトテーマで表示するか。選択は localStorage で記憶する
  const [lightMode, setLightMode] = useState(() => localStorage.getItem('previewLight') === '1');
  const toggleLightMode = useCallback(() => {
    setLightMode((v) => {
      localStorage.setItem('previewLight', v ? '0' : '1');
      return !v;
    });
  }, []);

  // ユーザーがドラッグで指定した幅(px)。null の間はクラスベースの既定幅を使う
  const [width, setWidth] = useState(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    // 未操作時は実際の描画幅を起点にする
    const drawerEl = e.currentTarget.parentElement;
    startWidth.current = widthRef.current ?? drawerEl?.getBoundingClientRect().width ?? 800;

    const onMove = (ev) => {
      if (!dragging.current) return;
      // 左端のハンドルを左へ動かすと幅が増える
      const delta = startX.current - ev.clientX;
      const max = window.innerWidth - 100;
      setWidth(Math.max(400, Math.min(startWidth.current + delta, max)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // HTML は iframe で描画するが、コメントの行・前後文脈を出すためにソースも読む
  useEffect(() => {
    if (!isMarkdownMode && filePath && (isText || isMarkdownFile || isHtml)) {
      setFileContent(null);
      setLoadError(false);
      fetch(previewUrl(filePath))
        .then((r) => r.text())
        .then((text) => setFileContent(text))
        .catch(() => setLoadError(true));
    }
  }, [filePath, isText, isMarkdownFile, isHtml, isMarkdownMode]);

  useEffect(() => {
    fileContentRef.current = fileContent;
  }, [fileContent]);

  const lang = ext ? EXT_TO_LANG[ext.slice(1)] : null;
  const highlightedHtml = useMemo(
    () => (isText && !isMarkdownFile && fileContent != null ? highlightCode(fileContent, lang) : null),
    [fileContent, lang, isText, isMarkdownFile],
  );

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (selectionPopup) {
          setSelectionPopup(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, selectionPopup]);

  // 選択範囲から source（fileContent or markdown）上の位置情報を構築する。
  // コードファイルは DOM textContent と source が一致するので直接オフセット計算。
  // Markdown プレビューは rendered DOM 上の出現順から source 内の同じ出現を探す。
  const computeLocation = useCallback(
    (range, selectedText) => {
      const body = bodyRef.current;
      if (!body) return null;

      const codeEl = body.querySelector('pre.hljs > code');
      const plainPre = body.querySelector('pre.drawer-text');
      const mdEl = body.querySelector('.drawer-markdown');

      let domRoot;
      let sourceText;
      let kind;

      if (codeEl && codeEl.contains(range.startContainer)) {
        domRoot = codeEl;
        sourceText = fileContent;
        kind = 'code';
      } else if (plainPre && plainPre.contains(range.startContainer)) {
        domRoot = plainPre;
        sourceText = fileContent;
        kind = 'text';
      } else if (mdEl && mdEl.contains(range.startContainer)) {
        domRoot = mdEl;
        sourceText = isMarkdownMode ? markdown : fileContent;
        kind = 'markdown';
      } else {
        return null;
      }

      const domStart = getRootTextOffset(domRoot, range.startContainer, range.startOffset);
      if (domStart < 0) return null;

      let sourceStart = -1;
      let sourceEnd = -1;
      if (kind === 'code' || kind === 'text') {
        // hljs ハイライトの span/テキストノードは textContent としては source と一致する
        sourceStart = domStart;
        sourceEnd = domStart + selectedText.length;
      } else if (kind === 'markdown' && sourceText) {
        // rendered DOM 上の出現順を取得し、source 内で同じ出現順の位置を探す
        const renderedText = domRoot.textContent;
        const occ = getOccurrenceIndex(renderedText, selectedText, domStart);
        if (occ.index > 0) {
          sourceStart = findOccurrenceOffset(sourceText, selectedText, occ.index);
          if (sourceStart >= 0) sourceEnd = sourceStart + selectedText.length;
        }
      }

      const heading = kind === 'markdown' ? findNearestHeading(range.startContainer, domRoot) : null;
      return buildLocationInfo({ kind, sourceText, selectedText, sourceStart, sourceEnd, heading });
    },
    [fileContent, isMarkdownMode, markdown],
  );

  // テキスト選択を検出
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || text.length < 2) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const bodyRect = bodyRef.current?.getBoundingClientRect();
    if (!bodyRect) return;

    // computeLocation は selection 種別によっては例外を投げ得るので保護する
    let location;
    try {
      location = computeLocation(range, text);
    } catch {
      location = null;
    }

    // 表示時に付けている data-source-line（＝ソース行番号）を保存時に結びつける。
    // 選択箇所の最も近い [data-source-line] 祖先＝テーブルなら tr、見出しなら各 h、段落なら p。
    // これで「最初の出現」ではなく実際にコメントした行/行（テーブル行含む）に一意紐付けできる。
    let line = null;
    let startEl = range.startContainer;
    if (startEl && startEl.nodeType === Node.TEXT_NODE) startEl = startEl.parentElement;
    const block = startEl?.closest?.('[data-source-line]');
    if (block) {
      const v = parseInt(block.getAttribute('data-source-line'), 10);
      if (v > 0) line = v;
    } else {
      // コード/テキストプレビュー: pre 内のテキストオフセットから行を算出
      const pre = bodyRef.current.querySelector('pre.drawer-text');
      if (pre && pre.contains(range.startContainer) && fileContent) {
        const off = textOffsetIn(pre, range.startContainer, range.startOffset);
        if (off >= 0) line = fileContent.slice(0, off).split('\n').length;
      }
    }

    setSelectionPopup({
      text,
      location: { ...(location || {}), line },
      top: rect.bottom - bodyRect.top + bodyRef.current.scrollTop,
      left: rect.left - bodyRect.left,
    });
  }, [computeLocation, fileContent]);

  // HTML プレビューは iframe 内に描画されるため、親の mouseup では選択を拾えない。
  // /preview は同一オリジンなので contentDocument に直接リスナを張り、
  // iframe 内の座標を drawer 本文の座標に変換してポップアップを出す。
  useEffect(() => {
    if (!isHtml) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onUp = () => {
      const sel = iframe.contentWindow?.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 2) {
        setSelectionPopup(null);
        return;
      }
      const bodyEl = bodyRef.current;
      const bodyRect = bodyEl?.getBoundingClientRect();
      if (!bodyRect) return;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const frameRect = iframe.getBoundingClientRect();

      // 描画テキスト上の出現順を HTML ソース上の同じ出現順に対応づけて行・列を出す
      // （タグを含むソースと表示テキストは一致しないため、Markdown と同じやり方）
      const source = fileContentRef.current;
      const docBody = iframe.contentDocument?.body;
      let location = {};
      let line = null;
      if (source && docBody) {
        const domStart = getRootTextOffset(docBody, range.startContainer, range.startOffset);
        const occ = getOccurrenceIndex(docBody.textContent, text, domStart);
        const sourceStart = occ.index > 0 ? findOccurrenceOffset(source, text, occ.index) : source.indexOf(text);
        if (sourceStart >= 0) {
          location = buildLocationInfo({
            kind: 'html',
            sourceText: source,
            selectedText: text,
            sourceStart,
            sourceEnd: sourceStart + text.length,
          });
          line = offsetToLineCol(source, sourceStart).line;
        }
      }

      setSelectionPopup({
        text,
        location: { ...location, line },
        top: frameRect.top - bodyRect.top + rect.bottom + bodyEl.scrollTop,
        left: frameRect.left - bodyRect.left + rect.left,
      });
    };

    let attached = null;
    const attach = () => {
      const doc = iframe.contentDocument;
      if (!doc || doc === attached) return;
      attached?.removeEventListener('mouseup', onUp);
      doc.addEventListener('mouseup', onUp);
      attached = doc;
    };
    // 読み込み済みなら即、まだなら load 後に張る
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      attached?.removeEventListener('mouseup', onUp);
    };
  }, [isHtml, filePath]);

  // HTML プレビューのダークモード対策。color-scheme を宣言していないページに、
  // 実際の背景の明暗（透過ならプレビューの明暗）に合った color-scheme を root へ注入する。
  // 「ダーク背景だけ指定して文字色なし（黒文字が沈む）」「明るい文字だけ指定して背景透過
  // （白地で消える）」の両方で、UA 既定の文字色・キャンバス色が背景に追従するようになる。
  // iframe 要素側の color-scheme（CSS）は中の prefers-color-scheme として伝わるため、
  // テーマ対応ページはトグルで明暗が切り替わる。その反映を待ってから測るので少し遅延させる。
  useEffect(() => {
    if (!isHtml) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const apply = () => {
      const doc = iframe.contentDocument;
      const root = doc?.documentElement;
      if (!root || !doc.body) return;
      const win = doc.defaultView;
      const scheme = resolveInjectedScheme({
        declared: win.getComputedStyle(root).colorScheme,
        ownInjected: root.dataset.bridgeColorScheme || null,
        bodyBg: win.getComputedStyle(doc.body).backgroundColor,
        htmlBg: win.getComputedStyle(root).backgroundColor,
        previewScheme: lightMode || document.body.classList.contains('light-mode') ? 'light' : 'dark',
      });
      if (!scheme) return;
      root.style.colorScheme = scheme;
      root.dataset.bridgeColorScheme = scheme;
    };

    let timer = null;
    const applyLater = () => {
      clearTimeout(timer);
      timer = setTimeout(apply, 50);
    };
    applyLater();
    iframe.addEventListener('load', applyLater);
    return () => {
      clearTimeout(timer);
      iframe.removeEventListener('load', applyLater);
    };
  }, [isHtml, filePath, lightMode]);

  const addComment = useCallback((selectedText, location, kind = 'review') => {
    const id = ++commentIdSeq;
    setReviewItems((prev) => [...prev, { id, selectedText, location, comment: '', resolved: false, kind }]);
    setEditingId(id);
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 「コメントに残す」: 送信せずセッションのコメントに保存（ファイルアンカー付き）。
  // 保存後も、このプレビューを開いている間は右ペインに表示し続ける。
  const saveComment = useCallback(
    (id) => {
      const item = reviewItems.find((i) => i.id === id);
      if (item && item.comment.trim()) {
        const text = item.comment.trim();
        if (onSaveComment) {
          onSaveComment(text, {
            selectedText: item.selectedText,
            label: item.location?.label || null,
            line: item.location?.line ?? null,
          });
        }
        setSavedComments((s) => [...s, { id, selectedText: item.selectedText, comment: text }]);
      }
      setReviewItems((prev) => prev.filter((i) => i.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [reviewItems, editingId, onSaveComment],
  );

  const updateComment = useCallback((id, comment) => {
    setReviewItems((prev) => prev.map((item) => (item.id === id ? { ...item, comment } : item)));
  }, []);

  const removeItem = useCallback(
    (id) => {
      setReviewItems((prev) => prev.filter((item) => item.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [editingId],
  );

  const toggleResolved = useCallback((id) => {
    setReviewItems((prev) => prev.map((item) => (item.id === id ? { ...item, resolved: !item.resolved } : item)));
  }, []);

  const [submitStatus, setSubmitStatus] = useState(null);

  const handleSubmitAll = useCallback(() => {
    const items = reviewItems.filter((i) => i.kind !== 'save' && i.comment.trim() && !i.resolved);
    if (items.length === 0 || !onReviewSubmit) return;

    const target = filePath || 'preview';
    const formatted = items.map((item, i) => {
      const head = `「${item.selectedText.slice(0, 80)}」`;
      const label = item.location?.label ? ` (${item.location.label})` : '';
      // 前後コンテキストで「同名トークンのどれを指すか」を Claude が一意に特定できるようにする
      const ctx =
        item.location && (item.location.contextBefore || item.location.contextAfter)
          ? ` 前後[${item.location.contextBefore}❮${item.selectedText.slice(0, 40)}❯${item.location.contextAfter}]`
          : '';
      return `${i + 1}. ${head}${label}${ctx} について:\n   ${item.comment}`;
    });
    onReviewSubmit(target, formatted);
    setSubmitStatus(`${items.length}件送信しました`);
    setTimeout(() => setSubmitStatus(null), 3000);
    // 送信済みを解決済みに
    setReviewItems((prev) =>
      prev.map((item) => (item.comment.trim() && !item.resolved ? { ...item, resolved: true } : item)),
    );
  }, [reviewItems, filePath, onReviewSubmit]);

  const markdownToRender = isMarkdownMode ? markdown : isMarkdownFile ? fileContent : null;

  // frontmatter をテーブル表示、本文だけを Markdown としてレンダリングする
  const { frontmatter, body: markdownBody } = useMemo(
    () => splitFrontmatter(markdownToRender || ''),
    [markdownToRender],
  );

  const unresolvedCount = reviewItems.filter((i) => i.kind !== 'save' && !i.resolved && i.comment.trim()).length;

  // 「残したコメント」の表示元: ファイルプレビューは保存済み（filePath 一致）を正にし、
  // 件数もここに出す。markdown プレビュー等 filePath が無い場合は開いている間の savedComments。
  // 毎レンダーで新配列を作ると行マーカー effect が無限ループするため安定化する
  const displaySaved = useMemo(
    () =>
      filePath
        ? (fileComments || []).map((c) => ({
            id: c.id,
            selectedText: c.anchor?.quote || '',
            comment: c.text,
            line: c.anchor?.line ?? null,
            persisted: true,
          }))
        : savedComments,
    [filePath, fileComments, savedComments],
  );

  // コメントの「行」を本文側に印（💬 ガター）として出す。
  // 行特定: コメントの引用文字列をソース上で探し、その開始行を求める。
  // 位置: markdown は data-source-line を持つブロックの位置、コード/テキストは行高から算出。
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      setLineMarkers([]);
      return;
    }
    const isCode = !markdownToRender && isText && !isMarkdownFile;
    const source = markdownToRender ? markdownBody : isCode ? fileContent : null;
    if (!source || displaySaved.length === 0) {
      setLineMarkers([]);
      return;
    }

    const id = setTimeout(() => {
      const bodyRect = body.getBoundingClientRect();
      const topOf = (el) => el.getBoundingClientRect().top - bodyRect.top + body.scrollTop;

      // 行番号 → { top(px), el } を返す関数を用意（el は markdown のとき該当ブロック）
      // テーブル行・リスト項目・見出し(h1〜h6)も一意に当てたい。line と完全一致する要素のうち、
      // 「末端ブロック」(tr/li/p/見出し等) を優先し、コンテナ(ul/ol/table/div) は避ける。
      // 同一行に末端ブロックが複数（ネスト）あれば DOM 順で最も深い（後の）ものを選ぶ。
      const LEAF_BLOCKS = new Set(['TR', 'LI', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE']);
      const ANY_BLOCK = new Set([...LEAF_BLOCKS, 'TABLE', 'UL', 'OL', 'DL', 'DIV']);
      let resolve;
      if (isCode) {
        const pre = body.querySelector('pre.drawer-text');
        if (!pre) return;
        const cs = getComputedStyle(pre);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
        const padTop = parseFloat(cs.paddingTop) || 0;
        const preTop = topOf(pre);
        resolve = (line) => ({ top: preTop + padTop + (line - 1) * lh, el: null });
      } else {
        const els = [...body.querySelectorAll('[data-source-line]')]
          .map((el) => ({ el, line: parseInt(el.getAttribute('data-source-line'), 10) }))
          .filter((x) => x.line > 0)
          .sort((a, b) => a.line - b.line);
        resolve = (line) => {
          const exact = els.filter((x) => x.line === line);
          if (exact.length) {
            const leaves = exact.filter((x) => LEAF_BLOCKS.has(x.el.tagName));
            // 末端ブロックがあれば最も深い（DOM 順で後ろ）ものを、無ければ任意のブロックを
            const el = (
              leaves.length ? leaves[leaves.length - 1] : exact.find((x) => ANY_BLOCK.has(x.el.tagName)) || exact[0]
            ).el;
            return { top: topOf(el), el };
          }
          // 完全一致が無ければ、その行を含む直近ブロック（line 以下で最大）
          let chosen = els[0];
          for (const x of els) {
            if (x.line <= line) chosen = x;
            else break;
          }
          return { top: chosen ? topOf(chosen.el) : 0, el: chosen?.el || null };
        };
      }

      // コメントを行ごとにまとめる。保存済みの anchor.line を最優先で使い、
      // 無い旧データのみ引用文字列の出現位置から行を推定する。
      const byLine = new Map();
      for (const c of displaySaved) {
        let line = c.line;
        if (!(line > 0)) {
          const q = (c.selectedText || '').trim();
          const idx = q ? source.indexOf(q) : -1;
          line = idx >= 0 ? source.slice(0, idx).split('\n').length : 1;
        }
        if (!byLine.has(line)) byLine.set(line, []);
        byLine.get(line).push(c);
      }

      // 以前のブロックハイライトを消してから付け直す
      body.querySelectorAll('.comment-anchored').forEach((e) => e.classList.remove('comment-anchored'));

      const markers = [...byLine.entries()].map(([line, comments]) => {
        const { top, el } = resolve(line);
        // markdown はレンダリング表示で「行」が見えないので、該当ブロックを強調して位置を示す
        if (el) el.classList.add('comment-anchored');
        return { line, top: Math.max(0, top), comments };
      });
      setLineMarkers(markers);
    }, 60);
    return () => {
      clearTimeout(id);
      bodyRef.current?.querySelectorAll('.comment-anchored').forEach((e) => e.classList.remove('comment-anchored'));
    };
  }, [displaySaved, markdownToRender, markdownBody, fileContent, isText, isMarkdownFile, width, lightMode]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className={`drawer ${isHtml ? 'drawer-html' : ''} ${
          reviewItems.length > 0 || displaySaved.length > 0 || (responses && responses.length > 0)
            ? 'drawer-with-review'
            : ''
        }`}
        style={width != null ? { width, maxWidth: 'none', minWidth: 'auto' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-resize-handle" onMouseDown={onDragStart} />
        <div className="drawer-header">
          <div className="drawer-title-area">
            <span className="drawer-filename">
              {fileName}
              {displaySaved.length > 0 && (
                <span className="drawer-comment-count" title="このファイルに残したコメント数">
                  💬 {displaySaved.length}
                </span>
              )}
            </span>
            {filePath && <span className="drawer-path">{filePath}</span>}
          </div>
          <div className="drawer-actions">
            <button
              className="drawer-btn"
              onClick={toggleLightMode}
              title={lightMode ? 'ダーク表示に戻す' : 'ライト表示にする'}
            >
              {lightMode ? '🌙 ダーク' : '☀ ライト'}
            </button>
            {unresolvedCount > 0 && (
              <button className="drawer-btn drawer-btn-submit" onClick={handleSubmitAll}>
                {unresolvedCount}件送信
              </button>
            )}
            {filePath && (
              <a href={previewUrl(filePath)} target="_blank" rel="noopener noreferrer" className="drawer-btn">
                別タブ
              </a>
            )}
            <button className="drawer-close" onClick={onClose}>
              x
            </button>
          </div>
        </div>

        <div className="drawer-hint">テキストを選択してコメントを追加できます</div>

        <div className="drawer-content">
          <div className={`drawer-body ${lightMode ? 'preview-light' : ''}`} ref={bodyRef} onMouseUp={handleMouseUp}>
            {markdownToRender ? (
              <div className="drawer-markdown">
                {frontmatter && <FrontmatterTable data={frontmatter} />}
                <Markdown
                  remarkPlugins={[remarkGfm, remarkAlert]}
                  rehypePlugins={[rehypeSourceLine]}
                  components={markdownComponents}
                >
                  {markdownBody}
                </Markdown>
              </div>
            ) : (
              <>
                {isImage && <img src={previewUrl(filePath)} alt={fileName} className="drawer-image" />}
                {isHtml && (
                  <iframe
                    ref={iframeRef}
                    src={previewUrl(filePath)}
                    className="drawer-iframe"
                    title={fileName}
                    sandbox="allow-scripts allow-same-origin"
                  />
                )}
                {isPdf && <iframe src={previewUrl(filePath)} className="drawer-iframe" title={fileName} />}
                {isText &&
                  !isMarkdownFile &&
                  (loadError ? (
                    <pre className="drawer-text">読み込みに失敗しました</pre>
                  ) : fileContent == null ? (
                    <pre className="drawer-text">読み込み中...</pre>
                  ) : highlightedHtml ? (
                    <pre className="drawer-text hljs">
                      <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                    </pre>
                  ) : (
                    <pre className="drawer-text">{fileContent}</pre>
                  ))}
                {!isImage && !isHtml && !isPdf && !isText && !isMarkdownMode && (
                  <div className="drawer-unsupported">
                    <p>プレビュー非対応の形式です</p>
                  </div>
                )}
              </>
            )}

            {/* 選択時のポップアップ */}
            {selectionPopup && (
              <div
                className="selection-popup"
                style={{
                  top: selectionPopup.top + 4,
                  left: selectionPopup.left,
                }}
              >
                <button
                  className="selection-popup-btn"
                  onClick={() => addComment(selectionPopup.text, selectionPopup.location, 'review')}
                >
                  レビューに追加（送る）
                </button>
                {onSaveComment && (
                  <button
                    className="selection-popup-btn"
                    onClick={() => addComment(selectionPopup.text, selectionPopup.location, 'save')}
                  >
                    コメントに残す（送らない）
                  </button>
                )}
              </div>
            )}

            {/* コメントがある行の 💬 マーカー（本文左ガター） */}
            {lineMarkers.length > 0 && (
              <div className="comment-gutter">
                {lineMarkers.map((m) => (
                  <button
                    key={m.line}
                    className="comment-gutter-marker"
                    style={{ top: m.top }}
                    onClick={() => setActiveMarker((cur) => (cur?.line === m.line ? null : m))}
                    title={`この箇所に ${m.comments.length} 件のコメント`}
                  >
                    💬{m.comments.length > 1 ? m.comments.length : ''}
                  </button>
                ))}
              </div>
            )}

            {/* 行マーカークリックで内容表示 */}
            {activeMarker && (
              <div className="comment-gutter-popup" style={{ top: activeMarker.top }}>
                <div className="comment-gutter-popup-head">
                  <span>💬 残したコメント</span>
                  <button onClick={() => setActiveMarker(null)}>x</button>
                </div>
                {activeMarker.comments.map((c) => (
                  <div key={c.id} className="comment-gutter-item">
                    {c.selectedText && (
                      <div className="comment-gutter-quote">
                        “{c.selectedText.slice(0, 60)}
                        {c.selectedText.length > 60 ? '…' : ''}”
                      </div>
                    )}
                    <div className="comment-gutter-text">{c.comment}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* レビュースレッド */}
          {(reviewItems.length > 0 || displaySaved.length > 0 || (responses && responses.length > 0)) && (
            <div className="drawer-review-pane">
              <div className="review-pane-header">レビュースレッド</div>
              <div className="review-pane-thread">
                {/* 未送信コメント */}
                {reviewItems
                  .filter((i) => !i.resolved)
                  .map((item, index) => (
                    <div key={item.id} className={`review-pane-item ${item.kind === 'save' ? 'save' : ''}`}>
                      <div className="review-pane-item-header">
                        <span className="review-pane-num">
                          #{index + 1} {item.kind === 'save' ? '（残す）' : '（送る）'}
                        </span>
                        <button className="review-pane-remove" onClick={() => removeItem(item.id)}>
                          x
                        </button>
                      </div>
                      <div className="review-pane-selected">
                        {item.selectedText.slice(0, 120)}
                        {item.selectedText.length > 120 ? '...' : ''}
                      </div>
                      <textarea
                        className="review-pane-input"
                        value={item.comment}
                        onChange={(e) => updateComment(item.id, e.target.value)}
                        onFocus={() => setEditingId(item.id)}
                        onKeyDown={(e) => {
                          // Ctrl/Cmd+Enter でその欄のボタン相当（残す＝保存 / 送る＝全件送信）。通常の Enter は改行
                          if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
                          e.preventDefault();
                          if (item.kind === 'save') saveComment(item.id);
                          else handleSubmitAll();
                        }}
                        placeholder={
                          item.kind === 'save'
                            ? 'コメントを書く（送信されません / Ctrl+Enterで保存）...'
                            : '指摘を入力...（Ctrl+Enterで送信）'
                        }
                        rows={2}
                        autoFocus={editingId === item.id}
                      />
                      {item.kind === 'save' && (
                        <button
                          className="review-pane-edit-btn"
                          onClick={() => saveComment(item.id)}
                          disabled={!item.comment.trim()}
                        >
                          コメントを残す（保存）
                        </button>
                      )}
                    </div>
                  ))}

                {/* 送信ボタン */}
                {unresolvedCount > 0 && (
                  <div className="review-pane-send-area">
                    {submitStatus && <div className="review-pane-status">{submitStatus}</div>}
                    <button className="btn btn-primary review-pane-submit" onClick={handleSubmitAll}>
                      {unresolvedCount}件送信
                    </button>
                  </div>
                )}

                {/* 残したcomment（送信せず保存）。ファイルプレビューは保存済み全件を表示。 */}
                {displaySaved.length > 0 && (
                  <div className="review-thread-saved">
                    <div className="review-thread-label">💬 残したコメント（送信なし）</div>
                    {displaySaved.map((c) => (
                      <div key={c.id} className="review-pane-item saved">
                        {c.persisted && onDeleteComment && (
                          <div className="review-pane-item-header">
                            <span className="review-pane-num">💬</span>
                            <button
                              className="review-pane-remove"
                              onClick={() => onDeleteComment(c.id)}
                              title="このコメントを削除"
                            >
                              x
                            </button>
                          </div>
                        )}
                        {c.selectedText && (
                          <div className="review-pane-selected">
                            {c.selectedText.slice(0, 80)}
                            {c.selectedText.length > 80 ? '...' : ''}
                          </div>
                        )}
                        <div className="review-pane-comment-sent">{c.comment}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 送信済み + 返信のスレッド表示 */}
                {reviewItems.filter((i) => i.resolved).length > 0 && (
                  <div className="review-thread-sent">
                    <div className="review-thread-label">送信済み</div>
                    {reviewItems
                      .filter((i) => i.resolved)
                      .map((item, index) => (
                        <div key={item.id} className="review-pane-item resolved">
                          <div className="review-pane-item-header">
                            <span className="review-pane-num sent">#{index + 1}</span>
                            <button
                              className="review-pane-resolve"
                              onClick={() => toggleResolved(item.id)}
                              title="未解決に戻す"
                            >
                              ↩
                            </button>
                          </div>
                          <div className="review-pane-selected">{item.selectedText.slice(0, 80)}...</div>
                          <div className="review-pane-comment-sent">{item.comment}</div>
                        </div>
                      ))}
                  </div>
                )}

                {/* Claude の返信 */}
                {responses &&
                  responses.map((r, i) => (
                    <div key={`resp-${i}`} className="review-pane-response">
                      <div className="review-pane-response-header">
                        <span className="review-pane-response-role">Claude</span>
                        <span className="review-pane-response-time">
                          {r.timestamp ? new Date(r.timestamp).toLocaleTimeString('ja-JP') : ''}
                        </span>
                      </div>
                      <div className="review-pane-response-body">
                        <Markdown remarkPlugins={[remarkGfm, remarkAlert]} components={markdownComponents}>
                          {r.content}
                        </Markdown>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
