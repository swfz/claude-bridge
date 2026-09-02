import { useEffect, useMemo } from 'react';
import { ChatMessage } from './ChatView.jsx';
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import './SubagentDrawer.css';

// 実行中のサブエージェントの会話を取り直す間隔
const TRANSCRIPT_POLL_INTERVAL = 4000;
// memo した ChatMessage に毎レンダー新しい [] を渡すと比較が外れるので共有の空配列を使う
const EMPTY = [];

// サブエージェントの会話トランスクリプトを右サイドのドロワーで見せる。
// 会話の描画は ChatView の ChatMessage を再利用する（readonly 固定）。
export default function SubagentDrawer({
  agentId,
  description,
  agentType,
  status,
  messages,
  onRequestTranscript,
  onOpenPreview,
  onClose,
}) {
  // 最下部にいる間だけ新着に追従する（上を読んでいる最中に引き戻さない）
  const { scrollRef: bodyRef, onScroll, hasNew, scrollToBottom } = useStickToBottom(messages, agentId);

  // 開いた直後は即取得し、実行中の間だけポーリングで追いかける
  useEffect(() => {
    if (!agentId) return;
    onRequestTranscript(agentId);
    if (status !== 'running') return;
    const timer = setInterval(() => onRequestTranscript(agentId), TRANSCRIPT_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [agentId, status, onRequestTranscript]);

  // ChatMessage は id を key に使うので、クライアント側で採番する
  const items = useMemo(
    () =>
      (messages || []).map((m, i) => ({
        ...m,
        id: `${agentId}-${i}`,
      })),
    [messages, agentId],
  );

  return (
    <div className="subagent-drawer-overlay" onClick={onClose}>
      <div className="subagent-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-drawer-header">
          <div className="subagent-drawer-title-area">
            <span className="subagent-drawer-title">{description || agentType || agentId}</span>
            <div className="subagent-drawer-meta">
              {agentType && <span className="subagent-badge">{agentType}</span>}
              <span className={`subagent-badge subagent-badge-status ${status === 'running' ? 'running' : 'done'}`}>
                {status === 'running' ? '実行中' : '完了'}
              </span>
            </div>
          </div>
          <button className="subagent-drawer-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="subagent-drawer-body" ref={bodyRef} onScroll={onScroll}>
          {items.length === 0 ? (
            <div className="subagent-drawer-empty">
              {status === 'running' ? 'サブエージェントの応答を待っています...' : '会話がありません'}
            </div>
          ) : (
            items.map((m) => (
              <ChatMessage
                key={m.id}
                message={m}
                threads={EMPTY}
                comments={EMPTY}
                onOpenPreview={onOpenPreview}
                readonly
              />
            ))
          )}

          {hasNew && (
            <button className="scroll-to-latest" onClick={scrollToBottom}>
              ↓ 新しいメッセージ
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
