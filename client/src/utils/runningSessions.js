// ホーム画面用のデータ整形。
// サーバーから来る「起動中の Claude セッション」と、ブリッジで開いているタブ（session_list）を
// 突合し、どれがタブとして開かれているかを可視化するための情報を組み立てる。

// 起動中セッション 1 件に対応する「開いているタブ」を探す。
// claudeSessionId 一致が第一（同じ会話を指す最も確実なキー）、
// 次に claudePid（tmux タブは JSONL 未解決でも pid は分かる）。
// 死んだタブは開いているとは扱わない（切り替えても操作できないため）。
export function findOpenTab(running, bridgeSessions) {
  if (!running) return null;
  const tabs = (bridgeSessions || []).filter((s) => s.alive);
  return (
    tabs.find((s) => s.claudeSessionId && s.claudeSessionId === running.sessionId) ||
    tabs.find((s) => s.claudePid != null && s.claudePid === running.pid) ||
    null
  );
}

// 起動中セッション一覧に openTab（開いていなければ null）を付与する。
export function annotateRunningSessions(runningSessions, bridgeSessions) {
  return (runningSessions || []).map((r) => ({
    ...r,
    openTab: findOpenTab(r, bridgeSessions),
  }));
}

// 起動中セッションにも直近セッションにも紐づかない「開いているタブ」を返す。
// 閲覧（readonly）で開いた古いセッションや、claude が終了したタブなど、
// ホーム画面の一覧には出ないがブラウザからは開いたままのものを拾う。
export function findUnmatchedTabs(runningSessions, bridgeSessions, recentSessions) {
  const matched = new Set(
    [
      ...annotateRunningSessions(runningSessions, bridgeSessions),
      ...annotateRecentSessions(recentSessions, runningSessions, bridgeSessions),
    ]
      .map((r) => r.openTab?.id)
      .filter(Boolean),
  );
  return (bridgeSessions || []).filter((s) => !matched.has(s.id));
}

// 直近のセッション（終了済みを含む JSONL 由来の一覧）を整形する。
// 今起動中のものは上段のカードに出ているので除き、タブとして開いていれば openTab を付ける。
export function annotateRecentSessions(recentSessions, runningSessions, bridgeSessions) {
  const runningIds = new Set((runningSessions || []).map((r) => r.sessionId).filter(Boolean));
  const tabs = (bridgeSessions || []).filter((s) => s.alive);
  return (recentSessions || [])
    .filter((s) => !runningIds.has(s.sessionId))
    .map((s) => ({
      ...s,
      openTab: tabs.find((t) => t.claudeSessionId === s.sessionId) || null,
    }));
}

// status 値（busy / shell / idle など）を表示用の 2 値に落とす。
export function statusClass(status) {
  return status === 'busy' || status === 'working' ? 'busy' : 'idle';
}

// 経過時間の短い日本語表記（ホームのカードに出す最終更新）。
// 数値（epoch ms）と ISO 文字列のどちらも受ける。
export function formatElapsed(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!Number.isFinite(ms)) return '';
  const sec = Math.floor((now - ms) / 1000);
  if (sec < 0) return 'たった今';
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.floor(hour / 24)}日前`;
}
