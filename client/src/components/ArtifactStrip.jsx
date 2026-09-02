import './ArtifactStrip.css';

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('ja-JP');
}

// このセッションで公開した Artifact のチップ列（チャットの最上部に貼り付ける）。
// 同じ URL への再デプロイは 1 チップにまとめ、回数を ×N で添える。
export default function ArtifactStrip({ artifacts }) {
  if (!artifacts || artifacts.length === 0) return null;

  return (
    <div className="artifact-strip">
      <span className="artifact-strip-label">Artifacts</span>
      {artifacts.map((artifact) => (
        <a
          key={artifact.url}
          className="artifact-chip"
          href={artifact.url}
          target="_blank"
          rel="noopener noreferrer"
          title={[artifact.path, artifact.lastTimestamp && `公開: ${formatTime(artifact.lastTimestamp)}`]
            .filter(Boolean)
            .join('\n')}
        >
          <span className="artifact-chip-icon">🔗</span>
          <span className="artifact-chip-text">{artifact.title}</span>
          {artifact.count > 1 && <span className="artifact-chip-count">×{artifact.count}</span>}
        </a>
      ))}
    </div>
  );
}
