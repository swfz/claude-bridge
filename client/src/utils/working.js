// 入力欄の直上に出す「推論中」インジケータの状態を決める純粋関数。
// status はサーバーが 4 秒間隔で読み直すので、送信直後はまだ busy になっていないことがある。
// その間は送信時刻（pendingSince）から PENDING_GRACE_MS だけ先回りして出す。

export const PENDING_GRACE_MS = 8000;

function timeOf(m) {
  const t = Date.parse(m?.timestamp || '');
  return Number.isFinite(t) ? t : null;
}

// 今のターン（最後の human 以降）で、まだ tool_result の返っていないツール呼び出し（実行中のもの）を返す。
// JSONL ではツール呼び出しが 1 件ずつ別の assistant レコードになるので、並列に呼んだときは
// 最後のレコードだけでなくターン内の assistant を全部見る（先に終わった方を見て「考え中」に戻さない）
export function runningToolOf(messages) {
  if (!Array.isArray(messages)) return null;
  const resolved = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'human') return null;
    if (m?.role === 'toolresult') {
      for (const r of m.results || []) if (r?.id) resolved.add(r.id);
      continue;
    }
    if (m?.role !== 'assistant') continue;
    const tools = m.toolUses || [];
    for (let j = tools.length - 1; j >= 0; j--) {
      if (tools[j]?.id && !resolved.has(tools[j].id)) return tools[j];
    }
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

// 表示するなら {mode, animated, tool, since, background}、出さないなら null。
// animated: 記号を動かすか。裏で動いているのがシェルだけ（dev サーバーの常駐など）なら止める
// （何が動いているかは TaskStrip のチップで分かるので、ずっと明滅させて画面をうるさくしない）。
// mode: 'turn'＝ターン中（busy か送信直後）、'background'＝ターンは終わったが裏でタスクが動いている
// （Claude Code はこの間 status を 'shell' にする。経過時間はターンの開始と合わないので since は null）。
// shell の間に送信したときは、busy になるまでの先回り（turn）を優先する。
// background は {agents, shells}＝実行中のサブエージェント・シェルの件数（TaskStrip と同じ一覧から数える）
export function workingStateOf({ status, waitingFor, messages, pendingSince, background, now = Date.now() }) {
  if (waitingFor || status === 'waiting') return null;
  const busy = status === 'busy';
  const pending =
    !busy &&
    Number.isFinite(pendingSince) &&
    now - pendingSince < PENDING_GRACE_MS &&
    !hasAssistantAfter(messages, pendingSince);
  if (busy || pending) {
    return {
      mode: 'turn',
      animated: true,
      tool: busy ? runningToolOf(messages) : null,
      since: turnStartOf(messages) ?? (pending ? pendingSince : null),
      background: null,
    };
  }
  if (status === 'shell') {
    const agents = background?.agents || 0;
    return {
      mode: 'background',
      animated: agents > 0,
      tool: null,
      since: null,
      background: { agents, shells: background?.shells || 0 },
    };
  }
  return null;
}

// 裏で動いているタスクの内訳（「サブエージェント 2 · シェル 1」）。どちらも 0 なら空文字
export function backgroundLabel(background) {
  const parts = [];
  if (background?.agents) parts.push(`サブエージェント ${background.agents}`);
  if (background?.shells) parts.push(`シェル ${background.shells}`);
  return parts.join(' · ');
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
