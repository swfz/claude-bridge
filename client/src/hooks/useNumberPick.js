import { useCallback, useEffect, useReducer, useRef } from 'react';
import { INITIAL_PICK_STATE, keyToPickAction, pickReducer, resolveTarget } from '../utils/numberPick.js';
import { isEnterKey, isPickModeShortcut, vimNavKey } from '../utils/keys.js';

// テキスト入力中かどうか。数字キーの素通し判定に使う
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable === true;
}

// イベントの発生元 or その document のフォーカス位置がテキスト入力なら、その要素を返す
function textEntryOf(e) {
  if (isTextEntry(e.target)) return e.target;
  const active = e.target?.ownerDocument?.activeElement;
  return isTextEntry(active) ? active : null;
}

/**
 * 「Alt+R（または数字キー）でピック開始 → 数字で番号を打つ → Enter で確定」を提供するフック。
 *
 * - `enabled`: 真偽値のほか、判定を毎回やり直したいとき（他のパネルが開いている間は無効にする等）は関数も渡せる
 * - `allowBareDigits`: テキスト入力にフォーカスが無ければ、Alt+R を待たず数字キーだけで開始する
 * - `invertArrows`: 「上に行くほど番号が大きい」並び（チャット）のとき、↑↓ の増減を反転する
 * - `allowSub`: `.` で 2 段目（チャットの「メッセージ番号 . 行番号」）に入れるようにする
 * - `subMax`: `(target) => number`。2 段目の上限。1 段目の対象が決まってから呼ぶ
 * - `onKey`: `(e, {target, subTarget}) => boolean`。ピック中に keyToPickAction より前に呼ばれ、
 *   true を返したら preventDefault して終了する。矢印の左右や文字キーなど呼び出し側固有のキー用
 * - `extraDocs`: iframe の contentDocument など、親 document にキーが届かない領域。
 *   iframe は読み込みで差し替わるので、毎レンダー貼り直して常に最新を見る
 *
 * Escape はピック中だけ握りつぶす（stopPropagation はしないので、呼び出し側は返り値の
 * `active` を見て「ピック中はドロワーを閉じない」等の判断ができる）。
 */
export function useNumberPick({
  enabled = true,
  max = 0,
  onPick,
  onEmptyEnter,
  onCancel,
  onKey,
  allowBareDigits = false,
  invertArrows = false,
  allowSub = false,
  subMax,
  extraDocs,
} = {}) {
  const [state, dispatch] = useReducer(pickReducer, INITIAL_PICK_STATE);

  // ハンドラを安定させたいので、変わり得る値は毎レンダー ref に写す
  const optsRef = useRef(null);
  optsRef.current = { enabled, max, onPick, onEmptyEnter, onCancel, onKey, allowBareDigits, invertArrows, allowSub };
  const subMaxRef = useRef(null);
  subMaxRef.current = typeof subMax === 'function' ? subMax : null;
  const stateRef = useRef(state);
  stateRef.current = state;
  const extraDocsRef = useRef(extraDocs);
  extraDocsRef.current = extraDocs;

  const start = useCallback(() => dispatch({ type: 'start' }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  // 1 段目の対象が決まっているときだけ 2 段目の上限を引く
  const subLimitOf = useCallback((target) => {
    if (target == null || !subMaxRef.current) return 0;
    return Math.floor(subMaxRef.current(target) || 0);
  }, []);

  // 番号を直接指定する（Ctrl+D/U の半画面ジャンプ等。2 段目に入っていれば行番号の方を動かす）
  const setTarget = useCallback(
    (value) => {
      const { max: maxN } = optsRef.current;
      const { buffer, sub } = stateRef.current;
      const limit = sub != null ? subLimitOf(resolveTarget(buffer, maxN)) : maxN;
      dispatch({ type: 'set', value, max: limit });
    },
    [subLimitOf],
  );

  const handleKeyDown = useCallback((e) => {
    const {
      enabled: en,
      max: maxN,
      onPick: pick,
      onEmptyEnter,
      onCancel,
      onKey,
      allowBareDigits,
      invertArrows,
      allowSub,
    } = optsRef.current;
    if (e.defaultPrevented) return;
    if (!(typeof en === 'function' ? en() : en !== false)) return;

    let { active, buffer, sub } = stateRef.current;

    // Alt+R: 入力欄にフォーカスがあれば外してから開始する（続けて数字を打てるように）
    if (isPickModeShortcut(e)) {
      e.preventDefault();
      textEntryOf(e)?.blur?.();
      dispatch({ type: 'start' });
      return;
    }

    // Alt+H/J/K/L は矢印キーの代わり（vim 風）。入力欄にフォーカスがあっても効き、
    // ピック中でなければ開始してそのまま移動する（↓/J で最初の対象に着地する）。
    // 以降は矢印キーとして処理するので、修飾キーを外した見かけのイベントに差し替える
    const nav = vimNavKey(e);
    if (nav) {
      e.preventDefault();
      if (!active) {
        textEntryOf(e)?.blur?.();
        dispatch({ type: 'start' });
        active = true;
        buffer = '';
        sub = null;
      }
      e = { key: nav, code: nav, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} };
    }

    if (!active) {
      if (!allowBareDigits) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (textEntryOf(e)) return;
      // 本文で Enter を空押し＝番号なしの確定（「全体への指摘」）。ピック開始を待たずに効かせる
      if (isEnterKey(e)) {
        e.preventDefault();
        onEmptyEnter?.();
        return;
      }
      if (!/^[0-9]$/.test(e.key)) return;
      e.preventDefault();
      dispatch({ type: 'digit', digit: e.key });
      return;
    }

    const target = resolveTarget(buffer, maxN);
    const subTarget = sub != null ? resolveTarget(sub, subLimitOf(target)) : null;

    // ピック中: Enter で確定、Escape で取消
    if (isEnterKey(e) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      dispatch({ type: 'clear' });
      // 2 段目に入っていても数字が未入力なら、1 段目だけで確定したものとして扱う
      if (target != null) pick?.(target, subTarget);
      else onEmptyEnter?.();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dispatch({ type: 'clear' });
      onCancel?.();
      return;
    }

    // 呼び出し側固有のキー（矢印の左右・文字キー等）。握ったら preventDefault して終わる
    if (onKey?.(e, { target, subTarget })) {
      e.preventDefault();
      return;
    }

    const action = keyToPickAction(e, { max: maxN });
    if (!action) return;
    // 2 段目に入れないとき（未対応・1 段目が未解決）は `.` を素通しする
    if (action.type === 'sep' && (!allowSub || target == null)) return;
    e.preventDefault();
    if (action.type === 'step') {
      // 2 段目（行）は上が小さい番号なので反転しない。反転は 1 段目にだけ効かせる
      const inSub = sub != null;
      dispatch({
        ...action,
        max: inSub ? subLimitOf(target) : maxN,
        delta: !inSub && invertArrows ? -action.delta : action.delta,
      });
      return;
    }
    dispatch(action);
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // iframe の contentDocument は差し替わるので、毎レンダー貼り直す（リスナは 1 つずつなので軽い）
  useEffect(() => {
    const docs = (extraDocsRef.current || []).filter(Boolean);
    if (docs.length === 0) return undefined;
    docs.forEach((d) => d.addEventListener('keydown', handleKeyDown));
    return () => docs.forEach((d) => d.removeEventListener('keydown', handleKeyDown));
  });

  // 無効化されたらピック中の状態を残さない（真偽値で渡されたときだけ判定できる）
  useEffect(() => {
    if (enabled === false) dispatch({ type: 'clear' });
  }, [enabled]);

  const target = resolveTarget(state.buffer, max);

  return {
    active: state.active,
    buffer: state.buffer,
    sub: state.sub,
    target,
    subTarget: state.sub != null ? resolveTarget(state.sub, subLimitOf(target)) : null,
    start,
    clear,
    setTarget,
    handleKeyDown,
  };
}

export default useNumberPick;
