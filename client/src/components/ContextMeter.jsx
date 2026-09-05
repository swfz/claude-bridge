import { contextColorFor, contextPercent, formatTokens } from '../utils/contextUsage.js';
import './ContextMeter.css';

// ツールチップ: 使用量と内訳、どのモデルの窓で測っているか
function buildTooltip(usage, pct) {
  const lines = [
    `コンテキスト: ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)} トークン (${pct}%)`,
    `input ${formatTokens(usage.inputTokens)} · cache 作成 ${formatTokens(usage.cacheCreationTokens)} · cache 読み込み ${formatTokens(usage.cacheReadTokens)}`,
  ];
  if (usage.model) lines.push(`model: ${usage.model}`);
  return lines.join('\n');
}

// ヘッダーに出す「今このセッションが使っているコンテキスト量」のメーター。
// 直近の assistant の usage をそのまま描くだけの純表示コンポーネント
// （/compact 直後は次の応答まで古い値が残る）。
export default function ContextMeter({ usage }) {
  if (!usage) return null;
  const pct = contextPercent(usage);

  return (
    <div className="context-meter" title={buildTooltip(usage, pct)}>
      <span className="context-meter-label">ctx</span>
      <span className="context-meter-bar">
        <span className="context-meter-bar-fill" style={{ width: `${pct}%`, background: contextColorFor(pct) }} />
      </span>
      <span className="context-meter-value">{pct}%</span>
    </div>
  );
}
