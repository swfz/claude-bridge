// チャットのタスク通知（role: 'task'）の表示用の整形。中身は server/jsonl-utils.js の parseTaskNotifications() が作る
// {taskId, toolUseId, status, summary, event, result, tokens, toolUses, durationMs}
import { formatTokens } from './contextUsage.js';
import { formatDuration } from './sessionTurns.js';

// 何のタスクか。summary の定型文（`Agent "…" finished` / `Background command "…" …` / `Monitor event: …`）で見分ける
export function taskKindOf(task) {
  const summary = task?.summary || '';
  if (task?.status === 'event' || /^Monitor\b/.test(summary)) return 'monitor';
  if (/^Agent\b/.test(summary)) return 'agent';
  if (/^Background (command|shell)\b/.test(summary)) return 'shell';
  return 'other';
}

// 状態の印。完了（いつもの結果）は出さず、失敗・停止だけ文字で出す
export function taskStatusLabel(status) {
  if (status === 'failed') return '失敗';
  if (status === 'killed' || status === 'stopped') return '停止';
  return '';
}

// 所要時間・ツール数・トークン（サブエージェントのときだけ書かれる）を 1 つの薄い文字列にする
export function taskMetaText(task) {
  const parts = [];
  const duration = formatDuration(task?.durationMs);
  if (duration) parts.push(duration);
  if (Number.isFinite(task?.toolUses) && task.toolUses > 0) parts.push(`ツール ${task.toolUses}`);
  if (Number.isFinite(task?.tokens) && task.tokens > 0) parts.push(`${formatTokens(task.tokens)} tokens`);
  return parts.join(' · ');
}

// 開いて見せる詳細。Monitor のイベント本文か、意味のある result。
// サブエージェントの result は「報告は別のメッセージで届けた」という定型文なので出さない
const HANDBACK_RESULT = /^This agent's report was delivered/;
export function taskDetailText(task) {
  if (task?.event) return task.event;
  const result = task?.result || '';
  if (!result || HANDBACK_RESULT.test(result)) return '';
  return result;
}
