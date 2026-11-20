// 「前面にドロワーが開いていて、後ろの画面（チャット・Review パネル・送信欄）にキーを渡さない」状態の目印。
// プレビュー（PreviewDrawer の .drawer-overlay）と差分ドロワー（.diff-drawer-overlay）が該当する。
// 差分ドロワーに .drawer-overlay を付けないのは、PreviewDrawer.css の見た目と、
// プレビュー専用の判定（ShortcutHints のプレビュー用カンペ・E2E の目印）に混ざらないようにするため。
// PiP 窓の .drawer-pip-host は別の document にあり、メイン画面のキーを止めないので含めない。
export const BLOCKING_DRAWER_SELECTOR = '.drawer-overlay, .diff-drawer-overlay';

export function isBlockingDrawerOpen(doc = globalThis.document) {
  return !!doc?.querySelector(BLOCKING_DRAWER_SELECTOR);
}
