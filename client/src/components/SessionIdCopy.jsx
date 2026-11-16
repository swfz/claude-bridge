import { useEffect, useRef, useState } from 'react';
import { TbCheck } from 'react-icons/tb';
import './SessionIdCopy.css';

const COPIED_MS = 1500;

// claude の session ID。先頭 8 文字だけ薄い等幅で出し、クリックで全文をコピーする
// （`claude --resume <id>` や新規作成ダイアログの ID 検索に貼るため）。トップバー・ホームのカード・
// セッション詳細で共用。コピー済みの印は同じ幅の中で文字と入れ替えるだけにして、隣を押し動かさない。
// カードの中に置くのでクリックは親へ伝播させない（伝播するとカードのクリックでセッションが開く）
export default function SessionIdCopy({ id, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => {
    setCopied(false);
  }, [id]);

  if (!id) return null;

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (err) {
      console.warn('[copy] failed', err);
    }
  };

  const label = `session ID: ${id}（クリックでコピー）`;
  return (
    <button
      type="button"
      className={`session-id-copy ${className}`.trim()}
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      <span className={copied ? 'session-id-copy-text hidden' : 'session-id-copy-text'}>{id.slice(0, 8)}</span>
      {copied && <TbCheck className="session-id-copy-done" aria-hidden />}
    </button>
  );
}
