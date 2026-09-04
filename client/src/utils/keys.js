// レビュー系のキーボードショートカット判定（ReviewDraftPanel / PreviewDrawer で共用）。
//
// 割り当ては「書く → Ctrl+Enter で確定して次へ（溜める）→ … → Ctrl+Shift+Enter で一気に送信」。
// 日本語 IME 経由だと Enter の keydown が `key: 'Process'` で届くことがあり、
// `e.key === 'Enter'` だけでは拾えないので物理キーを表す `e.code` も見る。
// 変換中（isComposing）の Enter は確定操作なのでショートカット扱いしない。
export function isEnterKey(e) {
  if (e.isComposing) return false;
  return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
}

// Ctrl/Cmd+Enter: この欄を確定して次の欄へ（残す項目なら保存）
export function isConfirmShortcut(e) {
  return isEnterKey(e) && (e.metaKey || e.ctrlKey) && !e.shiftKey;
}

// Ctrl/Cmd+Shift+Enter: 溜めた指摘を一括送信
export function isSubmitAllShortcut(e) {
  return isEnterKey(e) && (e.metaKey || e.ctrlKey) && e.shiftKey;
}

// Alt+R: 対象を数字キーで選ぶピックモードを開始する。
// Ctrl/Cmd 系は既存のブラウザ・アプリのショートカットと衝突しやすいので Alt にしてある。
// キーボードレイアウトによっては Alt 併用で e.key が別文字になるため、物理キー（e.code）も見る。
export function isPickModeShortcut(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.code === 'KeyR' || (e.key || '').toLowerCase() === 'r';
}

// Ctrl/Cmd+Shift+Backspace（Delete）: 今書いている指摘の欄そのものを消す。
// Ctrl+Backspace 単体は textarea の「単語削除」なので、Shift 併用を必須にして踏み分ける。
export function isDeleteItemShortcut(e) {
  if (!e || !(e.ctrlKey || e.metaKey) || !e.shiftKey) return false;
  return e.key === 'Backspace' || e.key === 'Delete';
}

// Alt+H/J/K/L を矢印キー（← ↓ ↑ →）として扱う（vim 風）。入力欄にフォーカスがあっても効かせるための Alt 併用。
// 該当しなければ null。Ctrl/Cmd が混ざるものは対象外。
const VIM_NAV = { KeyH: 'ArrowLeft', KeyJ: 'ArrowDown', KeyK: 'ArrowUp', KeyL: 'ArrowRight' };
const VIM_NAV_BY_KEY = { h: 'ArrowLeft', j: 'ArrowDown', k: 'ArrowUp', l: 'ArrowRight' };
export function vimNavKey(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey) return null;
  return VIM_NAV[e.code] || VIM_NAV_BY_KEY[(e.key || '').toLowerCase()] || null;
}

// Ctrl+D / Ctrl+U: 半画面スクロール（vim）。'down' | 'up' | null。
// ブラウザ側ではブックマーク／ソース表示に割り当たっているが予約キーではないので、
// 呼び出し側で preventDefault すればページが横取りできる（このページを開いている間だけ抑止される）。
export function halfPageScrollKey(e) {
  if (!e || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.code === 'KeyD' || (e.key || '').toLowerCase() === 'd') return 'down';
  if (e.code === 'KeyU' || (e.key || '').toLowerCase() === 'u') return 'up';
  return null;
}

// セッションタブの移動。Alt+Shift+J / K で次・前、Alt+1〜9 で n 番目のタブ、Alt+0 でホーム。
// { type: 'next' } | { type: 'prev' } | { type: 'index', n } | null
export function tabNavKey(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey) {
    if (e.code === 'KeyJ' || (e.key || '').toLowerCase() === 'j') return { type: 'next' };
    if (e.code === 'KeyK' || (e.key || '').toLowerCase() === 'k') return { type: 'prev' };
    return null;
  }
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '') || /^([0-9])$/.exec(e.key || '');
  if (m) return { type: 'index', n: Number(m[1]) };
  return null;
}
