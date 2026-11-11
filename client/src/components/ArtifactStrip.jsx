import { useEffect, useRef, useState } from 'react';
import { TbLink } from 'react-icons/tb';
import './ArtifactStrip.css';

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('ja-JP');
}

// このセッションで公開した Artifact。チャット右上に件数付きのアイコン 1 つだけ貼り付け（本文の幅を取らない）、
// クリックで一覧を開く。同じ URL への再デプロイは 1 件にまとめ、回数を ×N で添える。
export default function ArtifactStrip({ artifacts }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!artifacts || artifacts.length === 0) return null;

  return (
    <div className="artifact-strip" ref={rootRef}>
      <button
        className={`artifact-strip-toggle${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="このセッションで公開した Artifact"
      >
        <TbLink aria-hidden="true" />
        {artifacts.length}
      </button>
      {open && (
        <div className="artifact-strip-menu" role="menu">
          {artifacts.map((artifact) => (
            <a
              key={artifact.url}
              className="artifact-chip"
              role="menuitem"
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
              title={[artifact.path, artifact.lastTimestamp && `公開: ${formatTime(artifact.lastTimestamp)}`]
                .filter(Boolean)
                .join('\n')}
            >
              <span className="artifact-chip-text">{artifact.title}</span>
              {artifact.count > 1 && <span className="artifact-chip-count">×{artifact.count}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
