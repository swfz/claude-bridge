// チャットの human メッセージの見出し。人が打っていないもの（サーバーが `sender` を付ける）は
// 「You」と区別する。sender の種類は server/jsonl-utils.js の injectedSenderOf() を参照
export function humanSenderLabel(sender) {
  if (!sender) return 'You';
  switch (sender.kind) {
    case 'subagent':
      return sender.name ? `Subagent · ${sender.name}` : 'Subagent';
    case 'peer':
      return sender.name ? `Agent · ${sender.name}` : 'Agent';
    case 'task-notification':
      return 'Task';
    default:
      return 'System';
  }
}
