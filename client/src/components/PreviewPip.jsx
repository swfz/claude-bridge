import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAlert } from 'remark-github-blockquote-alert';
import { FrontmatterTable, PreviewTextBody, markdownComponents } from './PreviewContent.jsx';
import { usePreviewSource } from '../hooks/usePreviewSource.js';
import { previewUrl } from '../utils/previewUrl.js';
import './PreviewDrawer.css';

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

// PiP 窓に描くプレビュー（閲覧専用）。レビュー・行ピック・選択コメントは持ち込まない
// （それらはメインの document / window に keydown 等を張るので、PiP で他セッションを
// 操作している最中のキーを横取りしてしまう）。
// 描画は createPortal で PiP の body に流すだけで、状態は App 側が持つ。
export default function PreviewPip({ pipWindow, filePath, markdown, title, onClose }) {
  // 表 / テキストとライト表示はドロワーと同じ localStorage の値を初期値にする（PiP 内での切替は保存しない）
  const [tableMode, setTableMode] = useState(() => localStorage.getItem('previewTableMode') !== 'text');
  const [lightMode, setLightMode] = useState(() => localStorage.getItem('previewLight') === '1');
  const src = usePreviewSource({ filePath, markdown, title, tableMode });
  const origin = window.location.origin;
  const url = filePath ? previewUrl(filePath, origin) : null;

  // ユーザーが PiP 窓を閉じたら状態を片付ける
  useEffect(() => {
    const handler = () => onClose(pipWindow);
    pipWindow.addEventListener('pagehide', handler);
    return () => pipWindow.removeEventListener('pagehide', handler);
  }, [pipWindow, onClose]);

  // 窓のタイトルとテーマ（body.light-mode）を親に合わせる
  useEffect(() => {
    pipWindow.document.title = src.fileName;
  }, [pipWindow, src.fileName]);
  useEffect(() => {
    const sync = () =>
      pipWindow.document.body.classList.toggle('light-mode', document.body.classList.contains('light-mode'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [pipWindow]);

  return createPortal(
    <div className="preview-pip">
      <div className="drawer-header preview-pip-header">
        <div className="drawer-title-area">
          <span className="drawer-filename">{src.fileName}</span>
          {filePath && <span className="drawer-path">{filePath}</span>}
        </div>
        <div className="drawer-actions">
          <button className="drawer-btn" onClick={() => setLightMode((v) => !v)}>
            {lightMode ? '🌙 ダーク' : '☀ ライト'}
          </button>
          {src.isTable && (
            <button className="drawer-btn" onClick={() => setTableMode((v) => !v)}>
              {tableMode ? '≡ テキスト' : '⊞ 表'}
            </button>
          )}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="drawer-btn">
              別タブ
            </a>
          )}
        </div>
      </div>
      <div className={`drawer-body preview-pip-body ${lightMode ? 'preview-light' : ''}`}>
        {src.markdownToRender ? (
          <div className="drawer-markdown">
            {src.frontmatter && <FrontmatterTable data={src.frontmatter} />}
            <Markdown remarkPlugins={[remarkGfm, remarkAlert]} components={markdownComponents}>
              {src.markdownBody}
            </Markdown>
          </div>
        ) : (
          <>
            {src.isImage && <img src={url} alt={src.fileName} className="drawer-image" />}
            {src.isHtml && (
              <iframe
                src={url}
                className="drawer-iframe"
                title={src.fileName}
                sandbox="allow-scripts allow-same-origin"
              />
            )}
            {src.isPdf && <iframe src={url} className="drawer-iframe" title={src.fileName} />}
            {src.isVideo && <video controls preload="metadata" src={url} className="drawer-video" />}
            {src.isCodeView && <PreviewTextBody source={src} />}
          </>
        )}
      </div>
    </div>,
    pipWindow.document.body,
  );
}
