import { useEffect } from 'react';

// Document Picture-in-Picture（小窓）の共通部分。プレビュー（PreviewPip）と差分（DiffPip）で使う。
// 小窓はタブにつき 1 つで、新しく開くとブラウザが前の窓を閉じる（前の窓の pagehide が飛ぶ）。

// 使えるか（Chromium 116+）。使えなければ小窓のボタンを出さない
export function isDocumentPipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// 小窓へ親のスタイルを写す。Vite は dev では <style>、本番では <link> で CSS を入れるので両方を複製する
function copyStyles(targetDoc) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    targetDoc.head.appendChild(node.cloneNode(true));
  });
}

// 小窓を開く。user activation が要るのでクリックハンドラから直接（await より前に）呼ぶこと
export async function openPipWindow({ width = 720, height = 640 } = {}) {
  const pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });
  copyStyles(pipWindow.document);
  return pipWindow;
}

// 小窓の後始末・タイトル・テーマ（body.light-mode）を親に合わせる。
// onClose(pipWindow) はユーザーが窓を閉じたとき（と、別の小窓を開いてブラウザが閉じたとき）に呼ぶ
export function usePipWindow(pipWindow, { title, onClose }) {
  useEffect(() => {
    const handler = () => onClose(pipWindow);
    pipWindow.addEventListener('pagehide', handler);
    return () => pipWindow.removeEventListener('pagehide', handler);
  }, [pipWindow, onClose]);

  useEffect(() => {
    pipWindow.document.title = title;
  }, [pipWindow, title]);

  useEffect(() => {
    const sync = () =>
      pipWindow.document.body.classList.toggle('light-mode', document.body.classList.contains('light-mode'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [pipWindow]);
}
