import { useEffect, useRef } from 'react';
import { halfPageScrollKey, tabNavKey, isFocusInputShortcut, isShareModeShortcut } from '../utils/keys.js';

// テキスト入力中か（Ctrl+D/U はエディタ操作と衝突するので入力中は触らない）
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable === true
  );
}

// 今スクロールすべき本文。開いているものの内側から順に見る（ドロワー → チャット → ホーム）
function scrollContainer() {
  return (
    document.querySelector('.drawer-overlay .drawer-body') ||
    document.querySelector('.chat-view') ||
    document.querySelector('.home-view')
  );
}

/**
 * 画面全体で効くキー操作（App で 1 回だけ呼ぶ）。
 * - Ctrl+D / Ctrl+U: 半画面スクロール（vim）。入力欄にフォーカスがあるときは素通し
 * - Alt+Shift+J / K: 次・前のタブ（ホームを 0 番目として巡回）
 * - Alt+1〜9: n 番目のタブへ、Alt+0: ホームへ。入力欄にフォーカスがあっても効く
 * - Alt+I: 送信欄（`.input-textarea`）へフォーカス。ドロワー表示中は何もしない
 * - Alt+Shift+S: 共有モードの切り替え。入力欄にフォーカスがあっても効く
 *
 * `tabs` はサイドバーと同じ並び・同じ絞り込み（共有モードで隠しているものを含めない）で渡す。
 */
export function useGlobalKeys({ tabs, activeId, onSelectTab, onHome, onToggleShareMode }) {
  const ref = useRef(null);
  ref.current = { tabs, activeId, onSelectTab, onHome, onToggleShareMode };

  useEffect(() => {
    const handler = (e) => {
      if (e.defaultPrevented) return;

      if (isShareModeShortcut(e)) {
        e.preventDefault();
        // 押し続けたときのキーリピートで切り替えを繰り返さない（オフで止まり得る）
        if (e.repeat || !ref.current.onToggleShareMode) return;
        ref.current.onToggleShareMode();
        return;
      }

      if (isFocusInputShortcut(e)) {
        // ドロワー表示中は後ろに隠れている送信欄へ飛ばさない
        if (document.querySelector('.drawer-overlay')) return;
        const textarea = document.querySelector('.input-textarea');
        if (!textarea) return; // ホーム表示中など送信欄が無い画面では何もしない
        e.preventDefault();
        textarea.focus();
        return;
      }

      const scroll = halfPageScrollKey(e);
      if (scroll) {
        if (isTextEntry(document.activeElement)) return;
        // ピック中は「対象を半画面分先へ飛ばす」操作（ChatView / PreviewDrawer 側）に譲る
        if (document.querySelector('.msg-pick-hud, .line-pick-hud')) return;
        const el = scrollContainer();
        if (!el) return;
        e.preventDefault();
        el.scrollBy({ top: (el.clientHeight / 2) * (scroll === 'down' ? 1 : -1) });
        return;
      }

      const nav = tabNavKey(e);
      if (!nav) return;
      const { tabs, activeId, onSelectTab, onHome } = ref.current;
      // 0 番目をホームとした並び。activeId が見つからない（閉じた直後等）ときはホーム扱い
      const order = [null, ...tabs];
      const cur = Math.max(0, order.indexOf(activeId));
      let nextIdx;
      if (nav.type === 'index') {
        nextIdx = nav.n;
        if (nextIdx >= order.length) return;
      } else {
        nextIdx = (cur + (nav.type === 'next' ? 1 : -1) + order.length) % order.length;
      }
      e.preventDefault();
      const id = order[nextIdx];
      if (id == null) onHome?.();
      else onSelectTab?.(id);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}

export default useGlobalKeys;
