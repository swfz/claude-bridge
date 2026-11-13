// 入力欄の直上に出す「推論中」インジケータの状態を決める純粋関数。
// status はサーバーが 4 秒間隔で読み直すので、送信直後はまだ busy になっていないことがある。
// その間は送信時刻（pendingSince）から PENDING_GRACE_MS だけ先回りして出す。

export const PENDING_GRACE_MS = 8000;

function timeOf(m) {
  const t = Date.parse(m?.timestamp || '');
  return Number.isFinite(t) ? t : null;
}

// 末尾から見て、まだ tool_result の返っていないツール呼び出し（実行中のもの）を返す
export function runningToolOf(messages) {
  if (!Array.isArray(messages)) return null;
  const resolved = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'toolresult') {
      for (const r of m.results || []) if (r?.id) resolved.add(r.id);
      continue;
    }
    if (m?.role === 'assistant') {
      const tools = m.toolUses || [];
      for (let j = tools.length - 1; j >= 0; j--) {
        if (tools[j]?.id && !resolved.has(tools[j].id)) return tools[j];
      }
      return null;
    }
    if (m?.role === 'human') return null;
  }
  return null;
}

// 今のターンの開始時刻（最後の human メッセージ）。無ければ null
export function turnStartOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'human') return timeOf(messages[i]);
  }
  return null;
}

function hasAssistantAfter(messages, since) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const t = timeOf(m);
    return t != null && t > since;
  }
  return false;
}

// 表示するなら {tool, since}（since はターン開始の ms。分からなければ null）、出さないなら null
export function workingStateOf({ status, waitingFor, messages, pendingSince, now = Date.now() }) {
  if (waitingFor || status === 'waiting') return null;
  const busy = status === 'busy';
  const pending =
    !busy &&
    Number.isFinite(pendingSince) &&
    now - pendingSince < PENDING_GRACE_MS &&
    !hasAssistantAfter(messages, pendingSince);
  if (!busy && !pending) return null;
  return {
    tool: busy ? runningToolOf(messages) : null,
    since: turnStartOf(messages) ?? (pending ? pendingSince : null),
  };
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
