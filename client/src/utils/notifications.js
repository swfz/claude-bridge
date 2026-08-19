// ターン完了（busy -> 非busy 遷移）したデスクトップ通知の対象セッションを返す純粋関数。
// attention.js の updateAttention と同じ「busy -> 非busy」遷移判定を使うが、
// こちらは通知トリガー専用なので現在の attention 状態や active タブは見ない。

// prev: 前回の statusMapOf() の結果（sessionId -> status の Map）。undefined/null なら空配列
// sessions: 今回の session_list の sessions
export function pickNotifyTargets({ prev, sessions }) {
  if (!prev) return [];
  const list = sessions || [];
  const targets = [];
  for (const s of list) {
    if (!s.alive) continue;
    const prevStatus = prev.get(s.id);
    // 初回（前回の記録に無い）は接続直後の全件反映なので遷移扱いしない
    if (prevStatus === undefined) continue;
    const becameNonBusy = prevStatus === 'busy' && s.status !== 'busy';
    if (!becameNonBusy) continue;
    targets.push(s);
  }
  return targets;
}
