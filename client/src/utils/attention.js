// タブの「ターン完了（未確認）」印（tmux のベル通知相当）。
// busy から busy 以外（idle/waiting/shell/null）に遷移した = ターンが終わって
// 入力待ちになったのに、ユーザーがまだそのタブを見ていないセッションを拾う。

// session_list 受信ごとに sessionId -> status の Map を作る（次回比較用のスナップショット）。
export function statusMapOf(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    map.set(s.id, s.status);
  }
  return map;
}

// 新しい attention Set を返す。変化が無ければ current と同一参照を返す（再レンダー抑制）。
//
// prev: 前回の statusMapOf() の結果（sessionId -> status）
// current: 現在の attention 対象 sessionId の Set
// sessions: 今回の session_list
// activeSessionId: 今アクティブなタブの id
// isViewingActive: ユーザーがそのアクティブタブを実際に見ているか（ホーム非表示 && document 可視）
export function updateAttention({ prev, current, sessions, activeSessionId, isViewingActive }) {
  const list = sessions || [];
  const base = current || new Set();
  const aliveIds = new Set(list.filter((s) => s.alive).map((s) => s.id));

  let next = base;
  let cloned = false;
  const clone = () => {
    if (!cloned) {
      next = new Set(base);
      cloned = true;
    }
  };

  // 一覧から消えた／死んだセッションは対象から外す
  for (const id of base) {
    if (!aliveIds.has(id)) {
      clone();
      next.delete(id);
    }
  }

  for (const s of list) {
    if (!s.alive) continue;
    const prevStatus = prev?.get(s.id);
    // 初回（前回の記録に無い）は接続直後の全件反映なので遷移扱いしない
    if (prevStatus === undefined) continue;
    const becameNonBusy = prevStatus === 'busy' && s.status !== 'busy';
    if (!becameNonBusy) continue;
    // 今まさに見ているアクティブタブなら「未確認」にはしない
    if (s.id === activeSessionId && isViewingActive) continue;
    if (!next.has(s.id)) {
      clone();
      next.add(s.id);
    }
  }

  return next;
}
