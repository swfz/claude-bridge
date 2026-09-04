import { useEffect, useState } from 'react';
import './ShortcutHints.css';

// 「今の画面で使えるキー操作」のカンペ。サイドバーの一番下に薄く出す。
//
// 状態は props ではなく DOM から読む。ピックモードやドロワーの開閉は ChatView / PreviewDrawer の
// ローカル state で、カンペのために App まで持ち上げると各コンポーネントに手が入るため。
// 見るのは「その目印になる要素があるか」だけで、中身は読まない。
const HINT_SETS = {
  previewInput: [
    ['Ctrl+Enter', '確定して本文へ'],
    ['Ctrl+Shift+Enter', '一括送信'],
    ['Ctrl+Shift+⌫', 'この指摘を削除'],
    ['Esc', '本文へ戻る'],
  ],
  previewLinePick: [
    ['0-9', '行番号'],
    ['↑↓ / Alt+K J', '行を移動'],
    ['Ctrl+D U', '半画面分先の行へ'],
    ['Enter', '指摘欄を開く'],
    ['⌫', '1 桁戻す'],
    ['Esc', '取消'],
  ],
  preview: [
    ['0-9', '行を選ぶ'],
    ['Alt+J K', '行を選んで移動'],
    ['Enter', 'ファイル全体への指摘'],
    ['Alt+R', 'ピック開始'],
    ['Ctrl+Shift+Enter', '一括送信'],
    ['Esc', '閉じる'],
  ],
  reviewInput: [
    ['Ctrl+Enter', '次の欄'],
    ['Ctrl+Shift+Enter', '一括 Submit'],
    ['Ctrl+Shift+⌫', 'この指摘を削除'],
    ['Alt+R / Alt+J K', 'メッセージを選ぶ'],
  ],
  chatLinePick: [
    ['0-9', '行番号'],
    ['↑↓ / Alt+K J', '行を移動'],
    ['Ctrl+D U', '半画面分先の行へ'],
    ['Enter', '指摘欄を開く'],
    ['⌫', '戻る'],
    ['Esc', '取消'],
  ],
  chatMsgPick: [
    ['0-9', 'メッセージ番号（最新が 1）'],
    ['.', '行を指定'],
    ['↑↓ / Alt+K J', '移動'],
    ['Ctrl+D U', '半画面分先へ'],
    ['→ ← / Alt+L H', '全文表示・折りたたみ'],
    ['p', 'ファイルをプレビュー'],
    ['Tab', '別のファイル'],
    ['Enter', '指摘欄を開く'],
    ['Esc', '取消'],
  ],
};

// 目印になる要素・フォーカス位置から「今のモード」を 1 つ決める（上から順に当たったもの）。
// どの画面でも使える共通のキー（末尾に足す）
const GLOBAL_HINTS = [
  ['Alt+Shift+J K', '次・前のタブ'],
  ['Alt+1-9 / 0', 'n 番目のタブ / ホーム'],
  ['Ctrl+D U', '半画面スクロール'],
];

function detectMode() {
  if (document.querySelector('.home-view')) return { key: 'home', hints: GLOBAL_HINTS };

  const active = document.activeElement;
  const inPreviewInput = Boolean(active?.classList?.contains('review-pane-input'));
  const inReviewInput = Boolean(active?.classList?.contains('review-draft-item-input'));
  const inSendBox = Boolean(active?.classList?.contains('input-textarea'));

  if (document.querySelector('.drawer-overlay')) {
    if (inPreviewInput) return { key: 'previewInput', hints: HINT_SETS.previewInput };
    if (document.querySelector('.line-pick-hud')) return { key: 'previewLinePick', hints: HINT_SETS.previewLinePick };
    return { key: 'preview', hints: HINT_SETS.preview };
  }

  if (inReviewInput) return { key: 'reviewInput', hints: HINT_SETS.reviewInput };

  const msgPick = document.querySelector('.msg-pick-hud');
  if (msgPick) {
    // 2 段目（メッセージの中の行を指定中）は data-mode="line" で示される
    if (msgPick.getAttribute('data-mode') === 'line') return { key: 'chatLinePick', hints: HINT_SETS.chatLinePick };
    return { key: 'chatMsgPick', hints: HINT_SETS.chatMsgPick };
  }

  // 通常のチャット。送信欄にフォーカスがあるときだけ Enter 系と / を足す
  const hasReviewPanel = Boolean(document.querySelector('.review-draft-panel'));
  const hints = [
    ['Alt+R', 'メッセージを選んでレビュー'],
    ['Alt+J K', 'メッセージを選んで移動'],
  ];
  if (inSendBox) hints.push(['Enter', '送信 / Shift+Enter 改行']);
  if (hasReviewPanel) hints.push(['Ctrl+Shift+Enter', '一括送信']);
  if (inSendBox) hints.push(['/', 'スラッシュコマンド補完']);
  hints.push(...GLOBAL_HINTS);
  return { key: `chat:${inSendBox ? 1 : 0}:${hasReviewPanel ? 1 : 0}`, hints };
}

export default function ShortcutHints() {
  const [mode, setMode] = useState(() => detectMode());

  useEffect(() => {
    let frame = null;
    const schedule = () => {
      // 連打・大量の DOM 変更で判定が走りすぎないよう 1 フレームにまとめる
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setMode((prev) => {
          const next = detectMode();
          if (prev?.key === next?.key) return prev;
          return next;
        });
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-mode', 'class'],
    });
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
    };
  }, []);

  if (!mode) return null;

  return (
    <div className="shortcut-hints">
      <div className="shortcut-hints-title">キー操作</div>
      {mode.hints.map(([key, label]) => (
        <div key={key} className="shortcut-hint">
          <kbd>{key}</kbd>
          <span className="shortcut-hint-label">{label}</span>
        </div>
      ))}
    </div>
  );
}
