import { isDocumentPipSupported, openPipWindow, usePipWindow } from '../hooks/usePipWindow.js';
import PreviewDrawer from './PreviewDrawer.jsx';

export { isDocumentPipSupported };

// プレビューの小窓を開く。user activation が要るのでクリックハンドラから直接呼ぶこと
export function openPreviewPipWindow(size) {
  return openPipWindow(size);
}

// PiP 窓に描くプレビュー。中身はドロワーと同じ PreviewDrawer を pipWindow 付きで描く
// （createPortal で PiP の body に流し、キー・選択・ピックのリスナは PiP の document に張る。
// そのため PiP にフォーカスがあるときだけ効き、メイン画面で他セッションを操作するキーは横取りしない）。
// レビューの送信先は PiP を開いたセッションに固定する（App が onReviewSubmit を束ねて渡す）。
export default function PreviewPip({ pipWindow, onClose, ...drawerProps }) {
  const fileName = drawerProps.filePath ? drawerProps.filePath.split('/').pop() : drawerProps.title || 'Preview';
  usePipWindow(pipWindow, { title: fileName, onClose });

  // x ボタンは窓ごと閉じる（pagehide で onClose が呼ばれて state が片付く）
  const handleClose = () => pipWindow.close();

  return <PreviewDrawer {...drawerProps} pipWindow={pipWindow} onClose={handleClose} />;
}
