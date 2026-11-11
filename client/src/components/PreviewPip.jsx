import { useEffect } from 'react';
import PreviewDrawer from './PreviewDrawer.jsx';

// Document Picture-in-Picture が使えるか（Chromium 116+）。使えなければ PiP ボタンを出さない
export function isDocumentPipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// PiP 窓へ親のスタイルを写す。Vite は dev では <style>、本番では <link> で CSS を入れるので両方を複製する
function copyStyles(targetDoc) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    targetDoc.head.appendChild(node.cloneNode(true));
  });
}

// PiP 窓を開く。user activation が要るのでクリックハンドラから直接呼ぶこと
export async function openPreviewPipWindow({ width = 720, height = 640 } = {}) {
  const pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });
  copyStyles(pipWindow.document);
  return pipWindow;
}

// PiP 窓に描くプレビュー。中身はドロワーと同じ PreviewDrawer を pipWindow 付きで描く
// （createPortal で PiP の body に流し、キー・選択・ピックのリスナは PiP の document に張る。
// そのため PiP にフォーカスがあるときだけ効き、メイン画面で他セッションを操作するキーは横取りしない）。
// レビューの送信先は PiP を開いたセッションに固定する（App が onReviewSubmit を束ねて渡す）。
export default function PreviewPip({ pipWindow, onClose, ...drawerProps }) {
  // ユーザーが PiP 窓を閉じたら状態を片付ける
  useEffect(() => {
    const handler = () => onClose(pipWindow);
    pipWindow.addEventListener('pagehide', handler);
    return () => pipWindow.removeEventListener('pagehide', handler);
  }, [pipWindow, onClose]);

  // 窓のタイトルとテーマ（body.light-mode）を親に合わせる
  const fileName = drawerProps.filePath ? drawerProps.filePath.split('/').pop() : drawerProps.title || 'Preview';
  useEffect(() => {
    pipWindow.document.title = fileName;
  }, [pipWindow, fileName]);
  useEffect(() => {
    const sync = () =>
      pipWindow.document.body.classList.toggle('light-mode', document.body.classList.contains('light-mode'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [pipWindow]);

  // x ボタンは窓ごと閉じる（pagehide で onClose が呼ばれて state が片付く）
  const handleClose = () => pipWindow.close();

  return <PreviewDrawer {...drawerProps} pipWindow={pipWindow} onClose={handleClose} />;
}
