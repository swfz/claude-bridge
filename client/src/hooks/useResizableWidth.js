import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clampWidth, maxWidthFor, parseStoredWidth, widthFromDrag, widthFromKey } from '../utils/resizableWidth.js';

function readStorage(key) {
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  if (!key) return;
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // 保存できなくても今の幅は変える
  }
}

// 右端に寄せたドロワーの左端をつまんで幅を変える。
//   - ドラッグ（mousedown では幅を変えず、動かしてから変える。起点は実際の描画幅）
//   - つまみにフォーカスして ←/→（Shift で大きく）。← で広がる
//   - ダブルクリックで既定の幅（CSS）に戻す
// storageKey を渡すと選んだ幅を localStorage に覚える。画面が狭くなって上限を超えたら表示だけ詰める。
// 戻り値の width が null の間は CSS の既定幅のまま（inline style を当てない）。
// hostWin は mousemove / mouseup / resize を張る窓（PiP 窓に描くときはそちら）
export default function useResizableWidth({
  elementRef,
  storageKey = null,
  min = 400,
  maxRatio = 0.95,
  margin = 0,
  hostWin = window,
  label = '幅を変える',
}) {
  const opts = useMemo(() => ({ min, maxRatio, margin }), [min, maxRatio, margin]);
  const [pref, setPref] = useState(() => parseStoredWidth(readStorage(storageKey)));
  const [viewport, setViewport] = useState(() => hostWin.innerWidth);
  const [dragging, setDragging] = useState(false);
  // aria-valuenow 用の実際の幅（既定幅のときも値を出す）
  const [measured, setMeasured] = useState(null);
  const cleanupRef = useRef(null);

  useEffect(() => {
    const onResize = () => setViewport(hostWin.innerWidth);
    hostWin.addEventListener('resize', onResize);
    return () => hostWin.removeEventListener('resize', onResize);
  }, [hostWin]);

  const width = pref == null ? null : clampWidth(pref, viewport, opts);

  useLayoutEffect(() => {
    const el = elementRef.current;
    if (el) setMeasured(Math.round(el.getBoundingClientRect().width));
  }, [elementRef, width, viewport]);

  // ドラッグの途中でアンマウントされたら後始末する
  useEffect(() => () => cleanupRef.current?.(), []);

  const currentWidth = () => width ?? elementRef.current?.getBoundingClientRect().width ?? min;

  const onMouseDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      // テキスト選択を始めさせない（ドラッグ中もさせない）
      e.preventDefault();
      const doc = hostWin.document;
      const startX = e.clientX;
      const startWidth = elementRef.current?.getBoundingClientRect().width ?? min;
      let moved = false;
      // 保存する値は最後に計算した幅（state は再描画まで反映されないので、ここで持つ）
      let last = startWidth;
      const prevSelect = doc.body.style.userSelect;
      const prevCursor = doc.body.style.cursor;
      const onMove = (ev) => {
        if (!moved) {
          // 動き始めてから幅を持つ（押しただけでは既定幅のまま）
          moved = true;
          setDragging(true);
          doc.body.style.userSelect = 'none';
          doc.body.style.cursor = 'col-resize';
        }
        last = clampWidth(widthFromDrag(startWidth, startX, ev.clientX), hostWin.innerWidth, opts);
        setPref(last);
      };
      const finish = () => {
        doc.removeEventListener('mousemove', onMove);
        doc.removeEventListener('mouseup', finish);
        cleanupRef.current = null;
        if (!moved) return;
        doc.body.style.userSelect = prevSelect;
        doc.body.style.cursor = prevCursor;
        setDragging(false);
        writeStorage(storageKey, last);
      };
      doc.addEventListener('mousemove', onMove);
      doc.addEventListener('mouseup', finish);
      cleanupRef.current = finish;
    },
    [hostWin, elementRef, storageKey, min, opts],
  );

  const onDoubleClick = useCallback(() => {
    setPref(null);
    writeStorage(storageKey, null);
  }, [storageKey]);

  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = widthFromKey(currentWidth(), e);
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    const clamped = clampWidth(next, viewport, opts);
    setPref(clamped);
    writeStorage(storageKey, clamped);
  };

  const max = maxWidthFor(viewport, opts);
  const handleProps = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': label,
    'aria-valuenow': measured ?? undefined,
    'aria-valuemin': Math.min(min, max),
    'aria-valuemax': max,
    tabIndex: 0,
    title: `${label}（ドラッグ・←で広げる / →で狭める・ダブルクリックで既定の幅に戻す）`,
    onMouseDown,
    onDoubleClick,
    onKeyDown,
  };
  return { width, dragging, handleProps };
}
