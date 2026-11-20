import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  TbChevronDown,
  TbChevronRight,
  TbLayoutSidebarLeftCollapse,
  TbLayoutSidebarLeftExpand,
  TbPictureInPicture,
  TbPlus,
  TbRefresh,
  TbSquare,
  TbSquareCheck,
  TbX,
} from 'react-icons/tb';
import { EXT_TO_LANG, highlightCode } from '../highlight.js';
import {
  DIFF_SCOPES,
  absolutePath,
  diffStatusLabel,
  formatDiffComment,
  isCommentableRow,
  lineLabel,
  locateComment,
  parseDiffRows,
  quoteRows,
  rangeFromRows,
  rowAnchor,
  rowCode,
  shouldCollapseFile,
  splitPath,
  summarizeDiff,
} from '../utils/diffView.js';
import {
  DIFF_VIEW_MODES,
  DIFF_VIEW_STORAGE_KEY,
  effectiveViewMode,
  extOf,
  highlightDiffRows,
  normalizeViewMode,
  pairSplitRows,
  splitLineIndex,
} from '../utils/diffLayout.js';
import { buildNavList, extendNav, findNavIndex, jumpNav, navCursor, navRange, stepNav } from '../utils/diffNav.js';
import {
  canMarkReviewed,
  loadReviewed,
  migrateReviewed,
  reviewedKey,
  saveReviewed,
  subscribeReviewed,
  toggleReviewed,
} from '../utils/diffReviewed.js';
import { diffCommentKey, diffCommentStore, isUnsent } from '../utils/diffComments.js';
import { halfScreenJump } from '../utils/pickJump.js';
import {
  halfPageScrollKey,
  isConfirmShortcut,
  isDeleteItemShortcut,
  isEnterKey,
  isSubmitAllShortcut,
  vimNavKey,
} from '../utils/keys.js';
import useResizableWidth from '../hooks/useResizableWidth.js';
import './DiffDrawer.css';

const EMPTY = Object.freeze([]);
// ファイル一覧を既定で出すドロワーの幅（px）。狭いときは畳んでおく（開閉は覚える）
const FILE_LIST_MIN_DRAWER = 900;
const FILE_LIST_STORAGE_KEY = 'diffFileListOpen';
// ドロワーの幅（左端のつまみで変える）。下限は左右表示の下限（SPLIT_MIN_WIDTH）より狭くし、
// 狭めれば 1 列に倒せるようにしておく
export const DIFF_WIDTH_STORAGE_KEY = 'diffDrawerWidth';
const DRAWER_MIN_WIDTH = 480;
const DRAWER_MAX_RATIO = 0.95;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても今の表示は切り替える
  }
}

// 中身を出すファイルか（行を描くか）
function showsRows(file, rows) {
  return !file.symlink && !file.sensitive && !file.binary && !file.tooLarge && !!rows && rows.length > 0;
}

function isNoChange(file) {
  return file.status === 'committed' || file.status === 'missing';
}

// 拡張子から hljs の言語を引き、色付け関数にする（無ければ null）
function highlighterFor(path) {
  const lang = EXT_TO_LANG[extOf(path)];
  return lang ? (text) => highlightCode(text, lang) : null;
}

function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable;
}

// 入力欄の /diff で開く差分ドロワー。Claude Code の /diff は TUI 内のモーダルで
// ブラウザからは見えないので、ブリッジがサーバーで git diff を取って出す。
// data: { loading, files, truncated, error, root, outside } | null
//
// 行番号（ガター）のクリック、またはキーボードの行カーソル（↑↓・Enter）でその行へ指摘を書く。
// 書きかけは utils/diffComments.js の store（モジュールレベル）に置き、閉じても取り直しても残す。
// focusTarget（{path, side, line, nonce}）を渡すと、差分が届いた後にその行へスクロールする（Claude から開く口）。
//
// pipWindow を渡すと小窓（Document Picture-in-Picture）に描く（DiffPip.jsx）。そのときは
// createPortal で PiP の body に流し、キー・スクロール・幅の計測は PiP の document / window で扱う
// （メイン画面で打つキーを横取りしない）。overlay（.diff-drawer-overlay）を付けず、Esc では閉じず、幅は窓に従う。
export default function DiffDrawer({
  sessionKey,
  scope,
  data,
  focusTarget,
  onChangeScope,
  onRefresh,
  onOpenPreview,
  onSubmitComments,
  onClose,
  onOpenPip,
  pipWindow,
}) {
  const hostWin = pipWindow || window;
  const hostDoc = hostWin.document;
  const entry = useSyncExternalStore(diffCommentStore.subscribe, () => diffCommentStore.snapshot(sessionKey));
  const [activeKey, setActiveKey] = useState(null);
  // スクロールして見せる行（{path, side, line, nonce}）。DiffFile が見せ終わったら null に戻す
  const [jump, setJump] = useState(null);
  // 行カーソル（{path, side, line}）と、Shift+↑↓ で広げた範囲の起点（同じ形）
  const [cursor, setCursor] = useState(null);
  const [selAnchor, setSelAnchor] = useState(null);
  // ファイルごとの開閉（ユーザーが切り替えたものだけ。無ければ既定）
  const [openMap, setOpenMap] = useState({});
  const [reviewed, setReviewed] = useState(() => loadReviewed());
  const [viewPref, setViewPref] = useState(() => normalizeViewMode(readStorage(DIFF_VIEW_STORAGE_KEY)));
  const [listPref, setListPref] = useState(() => readStorage(FILE_LIST_STORAGE_KEY));
  const [drawerWidth, setDrawerWidth] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [currentPath, setCurrentPath] = useState(null);
  const drawerRef = useRef(null);
  const bodyRef = useRef(null);
  const { width: resizedWidth, handleProps: resizeHandleProps } = useResizableWidth({
    elementRef: drawerRef,
    storageKey: DIFF_WIDTH_STORAGE_KEY,
    min: DRAWER_MIN_WIDTH,
    maxRatio: DRAWER_MAX_RATIO,
    label: '差分ドロワーの幅を変える',
  });
  // 小窓では幅は窓に従う（保存した幅を当てない）
  const drawerWidthStyle =
    !pipWindow && resizedWidth != null ? { width: resizedWidth, maxWidth: 'none', minWidth: 0 } : undefined;
  // handleGutter を安定させる（行は memo してあり、ハンドラが変わると全行を描き直すため）
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const files = useMemo(() => data?.files || EMPTY, [data]);
  const ready = !!data && !data.loading;
  const rowsByPath = useMemo(() => new Map(files.map((f) => [f.path, parseDiffRows(f.patch)])), [files]);
  const summary = summarizeDiff(files);
  const unsent = entry.list.filter(isUnsent);
  const sending = entry.list.some((c) => c.sendingId);

  const reviewedSet = useMemo(() => new Set(reviewed), [reviewed]);
  const isReviewed = useCallback(
    (file) => canMarkReviewed(file) && reviewedSet.has(reviewedKey(sessionKey, file)),
    [reviewedSet, sessionKey],
  );
  const reviewable = files.filter(canMarkReviewed);
  const reviewedCount = reviewable.filter(isReviewed).length;

  const isOpen = useCallback(
    (file) => {
      if (isNoChange(file)) return false;
      if (openMap[file.path] != null) return openMap[file.path];
      const hasComments = (entry.byPath[file.path] || EMPTY).length > 0;
      return !isReviewed(file) && (!shouldCollapseFile(file) || hasComments);
    },
    [openMap, entry.byPath, isReviewed],
  );

  const listOpen = listPref != null ? listPref === '1' : drawerWidth >= FILE_LIST_MIN_DRAWER;
  const mode = effectiveViewMode(viewPref, bodyWidth);

  // キーボードで動く順（開いていて行を出しているファイルの、指摘を付けられる行）
  const nav = useMemo(
    () =>
      buildNavList(
        files
          .filter((f) => isOpen(f) && showsRows(f, rowsByPath.get(f.path)))
          .map((f) => ({ path: f.path, rows: rowsByPath.get(f.path) })),
      ),
    [files, isOpen, rowsByPath],
  );
  const cursorIdx = findNavIndex(nav, cursor);
  const anchorIdx = findNavIndex(nav, selAnchor);
  const selection = cursorIdx >= 0 && anchorIdx >= 0 ? navRange(nav, anchorIdx, cursorIdx) : null;

  useEffect(() => {
    if (focusTarget) setJump(focusTarget);
  }, [focusTarget]);

  // 開いたら本文にフォーカスを置く（送信欄に残ったままだと Ctrl+D / U が効かず、打鍵が裏の送信欄に入る）
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  // ドロワーと本文の幅（ファイル一覧の既定・左右表示に倒すかの判定）。画面の幅ではなく実際の要素の幅で決める
  // （つまみで幅を変えたとき・小窓の大きさを変えたときにも効く）。小窓の要素は小窓の ResizeObserver で測る
  useEffect(() => {
    const ro = new hostWin.ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        if (e.target === drawerRef.current) setDrawerWidth(w);
        else if (e.target === bodyRef.current) setBodyWidth(w);
      }
    });
    if (drawerRef.current) ro.observe(drawerRef.current);
    if (bodyRef.current) ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, [hostWin]);

  // 確認済みは別のドロワー（メインと小窓）や App の付け替えでも変わるので、書き込みを購読して読み直す
  useEffect(() => subscribeReviewed(setReviewed), []);

  // sessionKey がブリッジ ID から claudeSessionId に変わったら（tmux タブ）確認済みを付け替える。
  // ドロワーが閉じている間の付け替えは App が持つ（どちらも同じ結果になる）
  const prevKeyRef = useRef(sessionKey);
  useEffect(() => {
    const prev = prevKeyRef.current;
    prevKeyRef.current = sessionKey;
    if (prev === sessionKey) return;
    const list = loadReviewed();
    const next = migrateReviewed(list, prev, sessionKey);
    if (next !== list) saveReviewed(next);
    setReviewed(next);
  }, [sessionKey]);

  // 開いている指摘欄へフォーカスを移す（既にある指摘の行を押したときは欄がマウント済みで autoFocus が効かない）
  useEffect(() => {
    if (!activeKey) return;
    const el = bodyRef.current?.querySelector(`[data-comment-key="${CSS.escape(activeKey)}"] textarea`);
    if (el && hostDoc.activeElement !== el) el.focus();
  }, [activeKey, hostDoc]);

  // 今見ているファイル（本文の上端を過ぎた最後のファイル）。一覧で示す
  const updateCurrent = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.getBoundingClientRect().top + 8;
    let cur = null;
    for (const el of body.querySelectorAll('[data-file-path]')) {
      if (el.getBoundingClientRect().top <= top) cur = el.getAttribute('data-file-path');
      else break;
    }
    setCurrentPath(cur ?? body.querySelector('[data-file-path]')?.getAttribute('data-file-path') ?? null);
  }, []);
  useEffect(() => {
    updateCurrent();
  }, [files, updateCurrent]);
  const scrollFrame = useRef(null);
  const handleScroll = useCallback(() => {
    if (scrollFrame.current != null) return;
    scrollFrame.current = hostWin.requestAnimationFrame(() => {
      scrollFrame.current = null;
      updateCurrent();
    });
  }, [updateCurrent, hostWin]);

  const rowElement = useCallback((c) => {
    if (!c) return null;
    const fileEl = bodyRef.current?.querySelector(`[data-file-path="${CSS.escape(c.path)}"]`);
    return fileEl?.querySelector(`[data-anchor="${c.side}:${c.line}"]`) || null;
  }, []);

  // カーソルが動いたら見える位置へ（見えていればスクロールしない）
  useEffect(() => {
    rowElement(cursor)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rowElement]);

  const handleSubmitAll = useCallback(() => {
    // 読み込み中は今の差分が分からない（対象行の有無を確かめられない）ので送らない
    if (!ready) return;
    const list = diffCommentStore.snapshot(sessionKey).list.filter(isUnsent);
    if (list.length === 0 || !onSubmitComments) return;
    const items = list.map((c) => {
      const rows = rowsByPath.get(c.path);
      // 「取り直す前の行番号」と添えるのは、そのファイルの行が今の差分にあって、同じ本文の行が引けないときだけ。
      // ファイルごと今の差分に無い（範囲外・コミット済み）・中身を出していない（バイナリ・大きすぎる）ものは
      // 確かめようがないので、書いたときの行番号のまま注記を付けない
      const stale = !!rows && rows.length > 0 && !locateComment(rows, c);
      return { text: formatDiffComment({ ...c, stale }) };
    });
    onSubmitComments(
      items,
      list.map((c) => c.key),
    );
    setActiveKey(null);
    bodyRef.current?.focus({ preventScroll: true });
  }, [ready, sessionKey, rowsByPath, onSubmitComments]);

  // 指摘欄を開く。同じ行（範囲）の指摘が既にあればそれを開く。replaceKey を渡すとその指摘の範囲を変える（本文は引き継ぐ）
  const openComment = useCallback(
    (path, range, replaceKey = null) => {
      const rows = rowsByPath.get(path);
      const file = files.find((f) => f.path === path);
      if (!rows || !file || !range) return;
      const list = diffCommentStore.snapshot(sessionKey).list;
      const current = activeKeyRef.current ? list.find((c) => c.key === activeKeyRef.current) : null;
      const key = diffCommentKey({ sessionKey, path, ...range });
      if (list.some((c) => c.key === key)) {
        if (current && current.key !== key && !current.text.trim()) diffCommentStore.remove(sessionKey, current.key);
        setActiveKey(key);
        return;
      }
      const comment = {
        key,
        path,
        oldPath: file.oldPath || null,
        ...range,
        quote: quoteRows(rows, range),
        text: '',
        sendingId: null,
      };
      const replacing = replaceKey ? list.find((c) => c.key === replaceKey) : null;
      if (replacing) {
        diffCommentStore.replace(sessionKey, replacing.key, { ...comment, text: replacing.text });
      } else {
        if (current && !current.text.trim()) diffCommentStore.remove(sessionKey, current.key);
        diffCommentStore.upsert(sessionKey, comment);
      }
      setActiveKey(key);
    },
    [rowsByPath, files, sessionKey],
  );

  const handleGutter = useCallback(
    (path, idx, shift) => {
      const rows = rowsByPath.get(path);
      const clicked = rowAnchor(rows?.[idx]);
      if (!clicked) return;
      setCursor({ path, side: clicked.side, line: clicked.line });
      setSelAnchor(null);
      const list = diffCommentStore.snapshot(sessionKey).list;
      const current = activeKeyRef.current ? list.find((c) => c.key === activeKeyRef.current) : null;
      // Shift+クリックは「今書いている指摘」の先頭行から押した行までに範囲を変える。
      // 同じファイル・同じ側で途切れないときだけで、それ以外（指摘欄が開いていない・側が違う・途切れる・
      // 対象行が見つからない指摘）は普通のクリックと同じく押した 1 行の指摘にする
      if (shift && current && current.path === path && !current.sendingId && current.side === clicked.side) {
        const loc = locateComment(rows, current);
        if (loc) {
          openComment(path, rangeFromRows(rows, loc.startIdx, idx), current.key);
          return;
        }
      }
      openComment(path, rangeFromRows(rows, null, idx));
    },
    [rowsByPath, sessionKey, openComment],
  );

  const handleChangeText = useCallback((key, text) => diffCommentStore.update(sessionKey, key, { text }), [sessionKey]);
  const focusBody = useCallback(() => bodyRef.current?.focus({ preventScroll: true }), []);
  // 確定（Ctrl+Enter / Esc）: 欄を閉じて本文へ。空なら捨てる
  const handleConfirm = useCallback(
    (key) => {
      const c = diffCommentStore.snapshot(sessionKey).list.find((x) => x.key === key);
      if (c && !c.text.trim()) diffCommentStore.remove(sessionKey, key);
      setActiveKey(null);
      focusBody();
    },
    [sessionKey, focusBody],
  );
  const handleDelete = useCallback(
    (key) => {
      diffCommentStore.remove(sessionKey, key);
      setActiveKey((cur) => (cur === key ? null : cur));
      focusBody();
    },
    [sessionKey, focusBody],
  );
  const commentHandlers = useMemo(
    () => ({
      onChange: handleChangeText,
      onConfirm: handleConfirm,
      onDelete: handleDelete,
      onSubmitAll: handleSubmitAll,
      onFocus: setActiveKey,
    }),
    [handleChangeText, handleConfirm, handleDelete, handleSubmitAll],
  );

  // ── キーボード（行カーソル）──────────────────────────────
  // 指摘欄などのテキスト入力にフォーカスがある間は効かない。Enter はボタン（ガター以外）にフォーカスがあれば
  // そのボタンの操作に譲る。Ctrl+D / U はカーソルがあれば半画面分先の行へ、無ければ本文をスクロールする
  const moveCursor = useCallback(
    (index, extend) => {
      const item = nav[index];
      if (!item) return;
      if (extend) {
        const from = anchorIdx >= 0 ? anchorIdx : cursorIdx;
        if (from < 0 || extendNav(nav, rowsByPath, from, index) == null) return;
        if (anchorIdx < 0) setSelAnchor(navCursor(nav[from]));
      } else {
        setSelAnchor(null);
      }
      setCursor(navCursor(item));
      // カーソルを動かしたら本文へフォーカスを戻す。直前に押したボタン（確認済み・取り直す・表示の切り替え・
      // ファイル一覧の項目など）にフォーカスが残っていると、続く Enter がそのボタンをもう一度押してしまう
      if (hostDoc.activeElement !== bodyRef.current) focusBody();
    },
    [nav, anchorIdx, cursorIdx, rowsByPath, hostDoc, focusBody],
  );

  const halfScreen = useCallback(
    (direction) => {
      const body = bodyRef.current;
      if (!body) return;
      if (cursorIdx < 0) {
        body.scrollBy({ top: (body.clientHeight / 2) * (direction === 'down' ? 1 : -1) });
        return;
      }
      // 画面上の位置で決める（左右表示では移動の順と上下の順が一致しないので top で並べる）
      const items = nav
        .map((n, k) => ({ n: k, top: rowElement(n)?.getBoundingClientRect().top }))
        .filter((it) => it.top != null)
        .sort((a, b) => a.top - b.top || a.n - b.n);
      const next = halfScreenJump({ items, current: cursorIdx, half: body.clientHeight / 2, direction });
      if (next != null) moveCursor(next, false);
    },
    [nav, cursorIdx, rowElement, moveCursor],
  );

  const keyHandlerRef = useRef(null);
  keyHandlerRef.current = (e) => {
    if (isSubmitAllShortcut(e)) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      handleSubmitAll();
      return;
    }
    if (e.defaultPrevented || e.isComposing) return;
    const active = hostDoc.activeElement;
    if (e.key === 'Escape') {
      // 範囲を広げている最中なら範囲だけ解く。それ以外は閉じる（小窓では閉じない。閉じるのは x）
      if (selAnchor && !isTextEntry(active)) {
        e.preventDefault();
        setSelAnchor(null);
        return;
      }
      if (!pipWindow) onClose();
      return;
    }
    if (isTextEntry(active)) return;
    const onButton = active?.tagName === 'BUTTON' && !active.classList.contains('diff-gutter');

    const scroll = halfPageScrollKey(e);
    if (scroll) {
      e.preventDefault();
      halfScreen(scroll);
      return;
    }
    // 行カーソルの移動先が無い（全部確認済みで畳んだ・バイナリだけ等）ときは矢印・n/p などの既定動作
    // （本文のスクロール・ボタンの操作）を止めない
    const noNav = nav.length === 0;
    const vim = vimNavKey(e);
    if (vim) {
      if (noNav || e.shiftKey || (vim !== 'ArrowDown' && vim !== 'ArrowUp')) return;
      e.preventDefault();
      moveCursor(stepNav(nav, cursorIdx, vim === 'ArrowDown' ? 1 : -1), false);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (noNav) return;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      if (e.shiftKey && cursorIdx >= 0) moveCursor(stepNav(nav, cursorIdx, delta), true);
      else moveCursor(stepNav(nav, cursorIdx, delta), false);
      return;
    }
    if (isEnterKey(e) && !e.shiftKey) {
      if (onButton || cursorIdx < 0) return;
      // 先に既定動作を止めてからフォーカスを移す（改行が指摘欄に入らないように）
      e.preventDefault();
      const item = nav[cursorIdx];
      openComment(item.path, navRange(nav, anchorIdx >= 0 ? anchorIdx : null, cursorIdx));
      setSelAnchor(null);
      return;
    }
    const jumps = { n: [1, 'hunkStart'], p: [-1, 'hunkStart'], ']': [1, 'fileStart'], '[': [-1, 'fileStart'] };
    const j = jumps[e.key];
    if (j && !noNav) {
      e.preventDefault();
      moveCursor(jumpNav(nav, cursorIdx, j[0], j[1]), false);
    }
  };

  useEffect(() => {
    const handler = (e) => keyHandlerRef.current(e);
    hostDoc.addEventListener('keydown', handler);
    return () => hostDoc.removeEventListener('keydown', handler);
  }, [hostDoc]);

  // 未送信の指摘を順に見せる（ヘッダの件数のクリック）
  const jumpSeq = useRef(0);
  const handleJumpNext = useCallback(() => {
    if (unsent.length === 0) return;
    const c = unsent[jumpSeq.current++ % unsent.length];
    setJump({ path: c.path, side: c.side, line: c.end, nonce: Date.now() });
  }, [unsent]);
  const handleJumpDone = useCallback(() => setJump(null), []);
  const handleSetOpen = useCallback((path, open) => setOpenMap((m) => ({ ...m, [path]: open })), []);

  const handleToggleReviewed = useCallback(
    (file) => {
      const key = reviewedKey(sessionKey, file);
      const on = !reviewedSet.has(key);
      // 保存先を読み直してから書く（他のタブ・App の付け替えで変わっていても上書きしない）
      const next = toggleReviewed(loadReviewed(), key, on);
      saveReviewed(next);
      setReviewed(next);
      // 付けたら畳み、外したら開く。開閉は「確認済みかどうか」から決まる既定に任せ、openMap には畳んだことを
      // 残さない（残すと、中身が変わって確認済みが外れても畳まれたままになり、行カーソルの移動先にも入らない）。
      // 外したときに既定では畳む大きなファイルだけは、開くことを残す（開いた状態を残しても隠れはしない）
      setOpenMap((m) => {
        const { [file.path]: _drop, ...rest } = m;
        return !on && shouldCollapseFile(file) ? { ...rest, [file.path]: true } : rest;
      });
    },
    [sessionKey, reviewedSet],
  );

  const handleSelectFile = useCallback((path) => {
    const el = bodyRef.current?.querySelector(`[data-file-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    setCurrentPath(path);
  }, []);

  const handleChangeView = (value) => {
    setViewPref(value);
    writeStorage(DIFF_VIEW_STORAGE_KEY, value);
  };
  const handleToggleList = () => {
    const next = listOpen ? '0' : '1';
    setListPref(next);
    writeStorage(FILE_LIST_STORAGE_KEY, next);
  };

  const presentPaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  // 今の差分に無いファイルへの指摘（範囲を「このセッション」に切り替えた・コミット済みになった等）
  const absent = ready ? entry.list.filter((c) => !presentPaths.has(c.path)) : EMPTY;
  const splitTooNarrow = viewPref === 'split' && mode === 'unified' && bodyWidth > 0;

  // 小窓では overlay（暗幕・クリックで閉じる）を持たず窓いっぱいに広げる。.diff-drawer-overlay を付けないのは、
  // メイン側の「前面にドロワーがある」判定（isBlockingDrawerOpen・ShortcutHints・useGlobalKeys）と混ざらないため
  const content = (
    <div
      className={pipWindow ? 'diff-drawer-pip-host' : 'diff-drawer-overlay'}
      onClick={pipWindow ? undefined : onClose}
    >
      <div className="diff-drawer" ref={drawerRef} style={drawerWidthStyle} onClick={(e) => e.stopPropagation()}>
        {!pipWindow && <div className="diff-drawer-resize" {...resizeHandleProps} />}
        <div className="diff-drawer-header">
          <button
            className="diff-list-toggle"
            onClick={handleToggleList}
            title={listOpen ? 'ファイル一覧を畳む' : 'ファイル一覧を出す'}
            aria-label={listOpen ? 'ファイル一覧を畳む' : 'ファイル一覧を出す'}
            aria-pressed={listOpen}
          >
            {listOpen ? (
              <TbLayoutSidebarLeftCollapse aria-hidden="true" />
            ) : (
              <TbLayoutSidebarLeftExpand aria-hidden="true" />
            )}
          </button>
          <div className="diff-drawer-title-area">
            <span className="diff-drawer-title">未コミットの差分</span>
            <div className="diff-drawer-meta">
              {!data?.loading && !data?.error && (
                <span className="diff-drawer-summary">
                  {summary.changed} ファイル <span className="diff-add">+{summary.additions}</span>{' '}
                  <span className="diff-del">−{summary.deletions}</span>
                </span>
              )}
              {ready && reviewable.length > 0 && (
                <span className="diff-drawer-reviewed" title="確認済みのファイル / 確認済みを付けられるファイル">
                  確認済み {reviewedCount}/{reviewable.length}
                </span>
              )}
              {data?.root && (
                <span className="diff-drawer-root" title={data.root}>
                  {data.root.split('/').pop()}
                </span>
              )}
              {entry.status && (
                <span className={`diff-drawer-status${entry.status.ok ? '' : ' error'}`} role="status">
                  {entry.status.ok ? `${entry.status.count}件送信しました` : '送信に失敗しました（指摘は残しています）'}
                </span>
              )}
            </div>
          </div>
          {/* 未送信の指摘。0 件でも場所を取っておき、出し入れで範囲トグル・更新ボタンを動かさない */}
          <div className={`diff-drawer-review${unsent.length === 0 ? ' empty' : ''}`}>
            <button
              className="diff-comment-count"
              onClick={handleJumpNext}
              title="未送信の指摘を順に表示"
              aria-label={`未送信の指摘 ${unsent.length} 件を順に表示`}
              tabIndex={unsent.length === 0 ? -1 : 0}
            >
              <span className="diff-comment-count-dot" aria-hidden="true" />
              {unsent.length}
            </button>
            <button
              className="btn btn-primary diff-submit"
              onClick={handleSubmitAll}
              disabled={unsent.length === 0 || sending || !ready}
              title="差分への指摘を一括送信（Ctrl+Shift+Enter）"
              tabIndex={unsent.length === 0 ? -1 : 0}
            >
              {unsent.length}件送信
            </button>
          </div>
          <div className="diff-segmented" role="group" aria-label="表示">
            {DIFF_VIEW_MODES.map((m) => (
              <button
                key={m.value}
                className={`diff-segment${viewPref === m.value ? ' active' : ''}`}
                onClick={() => handleChangeView(m.value)}
                aria-pressed={viewPref === m.value}
                title={
                  m.value === 'split'
                    ? splitTooNarrow
                      ? '左右に並べる（幅が狭いので今は 1 列で表示しています）'
                      : '左に旧・右に新を並べる'
                    : '1 列で表示'
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="diff-drawer-scope" role="group" aria-label="差分の範囲">
            {DIFF_SCOPES.map((s) => (
              <button
                key={s.value}
                className={`diff-scope-btn${scope === s.value ? ' active' : ''}`}
                onClick={() => onChangeScope(s.value)}
                aria-pressed={scope === s.value}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            className="diff-drawer-icon diff-drawer-refresh"
            onClick={onRefresh}
            title="取り直す"
            aria-label="取り直す"
          >
            <TbRefresh aria-hidden="true" />
          </button>
          {!pipWindow && onOpenPip && (
            <button
              className="diff-drawer-icon diff-drawer-pip"
              onClick={onOpenPip}
              title="小窓に出す（他のタブへ移っても残り、指摘はこのセッションへ送ります）"
              aria-label="小窓に出す"
            >
              <TbPictureInPicture aria-hidden="true" />
            </button>
          )}
          <button
            className="diff-drawer-close"
            onClick={pipWindow ? () => pipWindow.close() : onClose}
            title={pipWindow ? '小窓を閉じる' : '閉じる（Esc）'}
            aria-label={pipWindow ? '小窓を閉じる' : '閉じる'}
          >
            ×
          </button>
        </div>

        <div className="diff-drawer-main">
          {listOpen && (
            <FileList
              files={ready ? files : EMPTY}
              byPath={entry.byPath}
              currentPath={currentPath}
              isReviewed={isReviewed}
              reviewedCount={reviewedCount}
              reviewableCount={reviewable.length}
              onSelect={handleSelectFile}
            />
          )}
          <div
            className={`diff-drawer-body${mode === 'split' ? ' split' : ''}`}
            ref={bodyRef}
            tabIndex={-1}
            onScroll={handleScroll}
          >
            {data?.loading && <div className="diff-drawer-empty">読み込み中...</div>}
            {data?.error && <div className="diff-drawer-error">{data.error}</div>}
            {absent.length > 0 && (
              <div className="diff-orphans" data-diff-orphans="">
                <div className="diff-drawer-note">今の差分に無いファイルへの指摘</div>
                {absent.map((c) => (
                  <CommentBox
                    key={c.key}
                    comment={c}
                    stale
                    showPath
                    active={c.key === activeKey}
                    {...commentHandlers}
                  />
                ))}
              </div>
            )}
            {ready && !data.error && files.length === 0 && (
              <div className="diff-drawer-empty">
                {scope === 'session' ? 'このセッションで編集したファイルはありません' : '未コミットの変更はありません'}
              </div>
            )}
            {ready && data.outside > 0 && (
              <div className="diff-drawer-note">リポジトリ外のファイル {data.outside} 件は対象外です</div>
            )}
            {ready &&
              files.map((file) => (
                <DiffFile
                  key={`${scope}:${file.path}`}
                  file={file}
                  rows={rowsByPath.get(file.path)}
                  root={data.root}
                  mode={mode}
                  open={isOpen(file)}
                  reviewed={isReviewed(file)}
                  comments={entry.byPath[file.path] || EMPTY}
                  activeKey={activeKey && entry.byPath[file.path]?.some((c) => c.key === activeKey) ? activeKey : null}
                  cursorAnchor={cursor?.path === file.path ? `${cursor.side}:${cursor.line}` : null}
                  selection={selection && nav[cursorIdx]?.path === file.path ? selection : null}
                  jump={jump?.path === file.path ? jump : null}
                  onJumpDone={handleJumpDone}
                  onSetOpen={handleSetOpen}
                  onToggleReviewed={handleToggleReviewed}
                  onGutter={handleGutter}
                  onOpenPreview={onOpenPreview}
                  handlers={commentHandlers}
                />
              ))}
            {data?.truncated && (
              <div className="diff-drawer-note">差分が大きいため、一部のファイルは中身を省略しています</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  return pipWindow ? createPortal(content, hostDoc.body) : content;
}

// ドロワー左のファイル一覧。今見ているファイルは中立色の下地で示す（行カーソルが「今の操作対象」のピンク）
function FileList({ files, byPath, currentPath, isReviewed, reviewedCount, reviewableCount, onSelect }) {
  return (
    <nav className="diff-filelist" aria-label="ファイル一覧">
      <div className="diff-filelist-head">
        <span>ファイル</span>
        {reviewableCount > 0 && (
          <span className="diff-filelist-reviewed" title="確認済みのファイル / 確認済みを付けられるファイル">
            {reviewedCount}/{reviewableCount}
          </span>
        )}
      </div>
      {files.map((file) => {
        const { dir, name } = splitPath(file.path);
        const unsentCount = (byPath[file.path] || EMPTY).filter(isUnsent).length;
        const label = diffStatusLabel(file.status);
        const done = isReviewed(file);
        return (
          <button
            key={file.path}
            className={`diff-filelist-item${file.path === currentPath ? ' current' : ''}${done ? ' reviewed' : ''}`}
            onClick={() => onSelect(file.path)}
            title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}${label ? `（${label}）` : ''}${
              done ? '・確認済み' : ''
            }`}
            aria-current={file.path === currentPath ? 'true' : undefined}
          >
            <span className="diff-filelist-name">
              <span className="diff-filelist-file">{name}</span>
              <span className="diff-filelist-dir">{dir}</span>
            </span>
            <span className="diff-filelist-meta">
              {label && <span className="diff-filelist-label">{label}</span>}
              {!isNoChange(file) && (
                <span className="diff-filelist-stat">
                  <span className="diff-add">+{file.additions}</span>{' '}
                  <span className="diff-del">−{file.deletions}</span>
                </span>
              )}
              {/* 未送信の指摘と確認済みの印は、0 件・未確認でも幅を取っておく（出し入れで +/− を動かさない） */}
              <span className={`diff-filelist-comments${unsentCount ? '' : ' empty'}`} title="未送信の指摘">
                {unsentCount || 0}
              </span>
              <span className={`diff-filelist-check${done ? '' : ' empty'}`} aria-hidden="true">
                <TbSquareCheck />
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

const DiffFile = memo(function DiffFile({
  file,
  rows,
  root,
  mode,
  open,
  reviewed,
  comments,
  activeKey,
  cursorAnchor,
  selection,
  jump,
  onJumpDone,
  onSetOpen,
  onToggleReviewed,
  onGutter,
  onOpenPreview,
  handlers,
}) {
  const fileRef = useRef(null);
  const label = diffStatusLabel(file.status);
  const { dir, name } = splitPath(file.path);
  const noChange = isNoChange(file);
  const previewPath = file.status === 'deleted' || file.status === 'missing' ? null : absolutePath(root, file.path);
  const visible = open && showsRows(file, rows);

  // 構文ハイライト（開いているファイルだけ）
  const html = useMemo(
    () => (visible ? highlightDiffRows(rows, highlighterFor(file.path)) : null),
    [visible, rows, file.path],
  );
  const splitLines = useMemo(() => (visible && mode === 'split' ? pairSplitRows(rows) : null), [visible, mode, rows]);

  // 指摘ごとに今の行の位置を引く。引けないものは見出しの下に「対象行が見つからない」として残す
  const { boxesAfter, rowCls, stale } = useMemo(() => {
    const boxesAfter = new Map();
    const marked = new Set();
    const target = new Set();
    const stale = [];
    const lineOf = splitLines ? splitLineIndex(splitLines) : null;
    for (const c of comments) {
      const loc = rows ? locateComment(rows, c) : null;
      if (!loc) {
        stale.push(c);
        continue;
      }
      const at = lineOf ? lineOf.get(loc.endIdx) : loc.endIdx;
      if (!boxesAfter.has(at)) boxesAfter.set(at, []);
      boxesAfter.get(at).push(c);
      for (let i = loc.startIdx; i <= loc.endIdx; i++) {
        // 強調するのは指摘と同じ側の行だけ
        if (rowAnchor(rows[i])?.side !== c.side) continue;
        if (c.key === activeKey) target.add(i);
        else if (isUnsent(c)) marked.add(i);
      }
    }
    // キーボードで広げている範囲も「今の操作対象」
    if (selection && rows) {
      rows.forEach((row, i) => {
        const a = rowAnchor(row);
        if (a && a.side === selection.side && a.line >= selection.start && a.line <= selection.end) target.add(i);
      });
    }
    const rowCls = new Map();
    const add = (i, c) => rowCls.set(i, `${rowCls.get(i) || ''} ${c}`);
    marked.forEach((i) => add(i, 'has-comment'));
    target.forEach((i) => add(i, 'target'));
    if (cursorAnchor && rows) {
      rows.forEach((row, i) => {
        const a = rowAnchor(row);
        if (a && `${a.side}:${a.line}` === cursorAnchor) add(i, 'cursor');
      });
    }
    return { boxesAfter, rowCls, stale };
  }, [comments, rows, activeKey, selection, cursorAnchor, splitLines]);

  // 外から指定された行（focusTarget / 未送信の指摘を順に見る）へスクロールする。畳んでいれば開く
  useEffect(() => {
    if (!jump) return;
    if (!open && !noChange) {
      onSetOpen(file.path, true);
      return;
    }
    const el =
      fileRef.current?.querySelector(`[data-anchor="${jump.side}:${jump.line}"]`) ||
      fileRef.current?.querySelector('.diff-comment.stale') ||
      null;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    onJumpDone();
  }, [jump, open, noChange, onJumpDone, onSetOpen, file.path]);

  const unsentCount = comments.filter(isUnsent).length;
  const reviewable = canMarkReviewed(file);
  const renderBoxes = (k) =>
    boxesAfter.get(k)?.map((c) => <CommentBox key={c.key} comment={c} active={c.key === activeKey} {...handlers} />);

  return (
    <div
      className={`diff-file${noChange ? ' no-change' : ''}${reviewed ? ' reviewed' : ''}`}
      ref={fileRef}
      data-file-path={file.path}
    >
      <div className="diff-file-header">
        <button
          className="diff-file-toggle"
          onClick={() => onSetOpen(file.path, !open)}
          disabled={noChange}
          aria-expanded={open}
          aria-label={open ? '畳む' : '開く'}
        >
          {open ? <TbChevronDown aria-hidden="true" /> : <TbChevronRight aria-hidden="true" />}
        </button>
        <button
          className="diff-file-path"
          onClick={() => previewPath && onOpenPreview(previewPath)}
          disabled={!previewPath}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          <span className="diff-file-dir">{dir}</span>
          <span className="diff-file-name">{name}</span>
        </button>
        {unsentCount > 0 && (
          <span className="diff-file-comments" title={`未送信の指摘 ${unsentCount} 件`}>
            指摘 {unsentCount}
          </span>
        )}
        {label && <span className="diff-file-label">{label}</span>}
        {!noChange && (
          <span className="diff-file-stat">
            <span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span>
          </span>
        )}
        {reviewable && (
          <button
            className={`diff-file-reviewed${reviewed ? ' on' : ''}`}
            onClick={() => onToggleReviewed(file)}
            aria-pressed={reviewed}
            title={reviewed ? '確認済みを外す' : '確認済みにして畳む（中身が変わると外れます）'}
          >
            {reviewed ? <TbSquareCheck aria-hidden="true" /> : <TbSquare aria-hidden="true" />}
            <span>確認済み</span>
          </button>
        )}
      </div>
      {stale.length > 0 && (
        <div className="diff-file-stale">
          {stale.map((c) => (
            <CommentBox key={c.key} comment={c} stale active={c.key === activeKey} {...handlers} />
          ))}
        </div>
      )}
      {open && !noChange && (
        <div className="diff-file-body">
          {file.symlink ? (
            <div className="diff-file-note">シンボリックリンク（リンク先の中身は表示しません）</div>
          ) : file.sensitive ? (
            <div className="diff-file-note">資格情報の置き場のため中身は表示しません</div>
          ) : file.binary ? (
            <div className="diff-file-note">バイナリファイル</div>
          ) : file.tooLarge ? (
            <div className="diff-file-note">差分が大きいため省略しました</div>
          ) : !rows || rows.length === 0 ? (
            <div className="diff-file-note">中身の差分はありません（モードや名前の変更のみ）</div>
          ) : splitLines ? (
            <div className="diff-lines split">
              {splitLines.map((line, k) => (
                <SplitLineWithComments key={k} boxes={renderBoxes(k)}>
                  {line.type === 'hunk' ? (
                    <DiffRow row={rows[line.idx]} idx={line.idx} path={file.path} cls="" html={null} />
                  ) : (
                    <SplitRow
                      left={line.left == null ? null : rows[line.left]}
                      right={line.right == null ? null : rows[line.right]}
                      leftIdx={line.left}
                      rightIdx={line.right}
                      leftCls={rowCls.get(line.left) || ''}
                      rightCls={rowCls.get(line.right) || ''}
                      leftHtml={html?.[line.left] ?? null}
                      rightHtml={html?.[line.right] ?? null}
                      path={file.path}
                      onGutter={onGutter}
                    />
                  )}
                </SplitLineWithComments>
              ))}
            </div>
          ) : (
            <div className="diff-lines">
              <div className="diff-lines-inner">
                {rows.map((row, i) => (
                  <SplitLineWithComments key={i} boxes={renderBoxes(i)}>
                    <DiffRow
                      row={row}
                      idx={i}
                      path={file.path}
                      cls={rowCls.get(i) || ''}
                      html={html?.[i] ?? null}
                      onGutter={onGutter}
                    />
                  </SplitLineWithComments>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function SplitLineWithComments({ boxes, children }) {
  return (
    <>
      {children}
      {boxes}
    </>
  );
}

// 行の本文。色付けできた行は hljs の HTML（hljs が本文をエスケープ済み）、できなかった行は素のテキスト
function LineText({ row, html }) {
  if (!isCommentableRow(row)) return <span className="diff-line-text">{row.text || ' '}</span>;
  const sign = row.text[0] || ' ';
  return (
    <span className="diff-line-text">
      <span className="diff-sign">{sign}</span>
      {html != null ? <span dangerouslySetInnerHTML={{ __html: html || ' ' }} /> : rowCode(row) || ' '}
    </span>
  );
}

function Gutter({ row, idx, path, onGutter, numbers }) {
  const anchor = rowAnchor(row);
  if (!anchor) return <span className={`diff-gutter${numbers.length === 1 ? ' single' : ''}`} aria-hidden="true" />;
  return (
    <button
      type="button"
      className={`diff-gutter${numbers.length === 1 ? ' single' : ''}`}
      tabIndex={-1}
      // クリックでフォーカスを奪わない（本文のキー操作を続けられるように。指摘欄は開いた後に自分でフォーカスする）
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onGutter(path, idx, e.shiftKey)}
      title="この行に指摘を書く（Shift+クリックで範囲）"
      aria-label={`${lineLabel({ side: anchor.side, start: anchor.line, end: anchor.line })} に指摘を書く`}
    >
      {numbers.map((n, k) => (
        <span key={k} className="diff-ln">
          {n ?? ''}
        </span>
      ))}
      <span className="diff-gutter-mark" aria-hidden="true" />
      <span className="diff-gutter-plus" aria-hidden="true">
        <TbPlus />
      </span>
    </button>
  );
}

const DiffRow = memo(function DiffRow({ row, idx, path, cls, html, onGutter }) {
  const anchor = rowAnchor(row);
  return (
    <div className={`diff-line ${row.kind}${cls}`} data-anchor={anchor ? `${anchor.side}:${anchor.line}` : undefined}>
      <Gutter row={row} idx={idx} path={path} onGutter={onGutter} numbers={[row.oldLine, row.newLine]} />
      <LineText row={row} html={html} />
    </div>
  );
});

// 左右に並べた 1 行。左＝旧（削除・文脈）、右＝新（追加・文脈）。文脈行は同じ行を左右に出し、
// data-anchor（ジャンプ・E2E の目印）は右にだけ付ける。左の文脈行を押しても文脈行（新側）の指摘になる
const SplitRow = memo(function SplitRow({
  left,
  right,
  leftIdx,
  rightIdx,
  leftCls,
  rightCls,
  leftHtml,
  rightHtml,
  path,
  onGutter,
}) {
  const cell = (row, idx, cls, html, side) => {
    if (!row) {
      return (
        <div className="diff-line diff-cell empty">
          <span className="diff-gutter single" aria-hidden="true" />
          <span className="diff-line-text" />
        </div>
      );
    }
    const anchor = rowAnchor(row);
    const mirror = side === 'left' && row.kind === 'ctx';
    return (
      <div
        className={`diff-line diff-cell ${row.kind}${cls}`}
        data-anchor={anchor && !mirror ? `${anchor.side}:${anchor.line}` : undefined}
      >
        <Gutter
          row={row}
          idx={idx}
          path={path}
          onGutter={onGutter}
          numbers={[side === 'left' ? row.oldLine : row.newLine]}
        />
        <LineText row={row} html={html} />
      </div>
    );
  };
  return (
    <div className="diff-split-line">
      {cell(left, leftIdx, leftCls, leftHtml, 'left')}
      {cell(right, rightIdx, rightCls, rightHtml, 'right')}
    </div>
  );
});

function CommentBox({ comment, active, stale, showPath, onChange, onConfirm, onDelete, onSubmitAll, onFocus }) {
  const sending = !!comment.sendingId;
  const where = `${showPath ? `${comment.side === 'old' && comment.oldPath ? comment.oldPath : comment.path} ` : ''}${
    comment.side === 'old' ? '削除行 ' : ''
  }${lineLabel(comment)}`;
  return (
    <div
      className={`diff-comment${active ? ' active' : ''}${stale ? ' stale' : ''}${sending ? ' sending' : ''}`}
      data-comment-key={comment.key}
    >
      <div className="diff-comment-head">
        <span className="diff-comment-where">{where}</span>
        {stale && <span className="diff-comment-stale">対象行が見つからない</span>}
        {stale && comment.quote && <span className="diff-comment-quote">{comment.quote}</span>}
        {sending && <span className="diff-comment-sending">送信中…</span>}
        <button
          className="diff-comment-remove"
          onClick={() => onDelete(comment.key)}
          title="この指摘を削除（Ctrl+Shift+⌫）"
          aria-label="この指摘を削除"
        >
          <TbX aria-hidden="true" />
        </button>
      </div>
      <textarea
        className="diff-comment-input"
        value={comment.text}
        readOnly={sending}
        rows={2}
        autoFocus={active}
        placeholder="指摘を入力...（Ctrl+Enterで確定 / Ctrl+Shift+Enterで一括送信）"
        onFocus={() => onFocus(comment.key)}
        onChange={(e) => onChange(comment.key, e.target.value)}
        onKeyDown={(e) => {
          // Esc は確定と同じ扱いにし、document の「ドロワーを閉じる」には届かせない
          if (isDeleteItemShortcut(e)) {
            e.preventDefault();
            onDelete(comment.key);
          } else if (isSubmitAllShortcut(e)) {
            e.preventDefault();
            onSubmitAll();
          } else if (isConfirmShortcut(e)) {
            e.preventDefault();
            onConfirm(comment.key);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onConfirm(comment.key);
          }
        }}
      />
    </div>
  );
}
