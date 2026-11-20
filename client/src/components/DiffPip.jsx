import { usePipWindow } from '../hooks/usePipWindow.js';
import DiffDrawer from './DiffDrawer.jsx';

// 差分ドロワーを小窓（Document Picture-in-Picture）に描く。中身は DiffDrawer を pipWindow 付きで描いたもの
// （PreviewPip と同じ作法）。指摘の送信先は開いたときのセッションに固定する（App が onSubmitComments を束ねて渡す）。
// 下書き（diffCommentStore）と確認済みはメイン側のドロワーと共有する
export default function DiffPip({ pipWindow, onClose, ...drawerProps }) {
  usePipWindow(pipWindow, { title: '差分', onClose });
  return <DiffDrawer {...drawerProps} pipWindow={pipWindow} />;
}
