import { useMemo } from 'react';
import { groupArtifactPublishes } from '../utils/artifacts.js';
import './HomeArtifactChips.css';

const DEFAULT_MAX = 3;

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('ja-JP');
}

function chipTitle(artifact) {
  return [
    artifact.title,
    artifact.path,
    artifact.lastTimestamp && `公開: ${formatTime(artifact.lastTimestamp)}`,
    artifact.count > 1 && `${artifact.count} 回公開`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ホームのカード／行に出す「このセッションで公開した Artifact」のチップ列。
// artifacts はサーバーから来る publish の生リストで、URL ごとのまとめはここで行う。
// compact（行用）は折り返さず、タイトルは先頭のチップだけに出し、列幅に収まるようチップ側を縮めて省略する。
export default function HomeArtifactChips({ artifacts, compact = false, max = DEFAULT_MAX }) {
  const grouped = useMemo(() => groupArtifactPublishes(artifacts), [artifacts]);
  if (grouped.length === 0) return null;

  const shown = grouped.slice(0, max);
  const rest = grouped.slice(max);

  return (
    <div className={`home-artifacts ${compact ? 'compact' : ''}`}>
      {shown.map((artifact, i) => (
        <a
          key={artifact.url}
          className="home-artifact-chip"
          href={artifact.url}
          target="_blank"
          rel="noopener noreferrer"
          // カード／行のクリックはセッションを開くので、リンクのクリックは伝播させない
          onClick={(e) => e.stopPropagation()}
          title={chipTitle(artifact)}
        >
          <span className="home-artifact-icon">🔗</span>
          {/* 行（compact）では列幅が限られるので、タイトルと回数は先頭のチップだけに出して残りはアイコンにする（回数は tooltip にある） */}
          {(!compact || i === 0) && (
            <>
              <span className="home-artifact-text">{artifact.title}</span>
              {artifact.count > 1 && <span className="home-artifact-count">×{artifact.count}</span>}
            </>
          )}
        </a>
      ))}
      {rest.length > 0 && (
        <span className="home-artifact-chip more" title={rest.map((a) => a.title).join('\n')}>
          +{rest.length}
        </span>
      )}
    </div>
  );
}
