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

// 起動中セッションに紐づかない「開いているタブ」を返す。
// 閲覧（readonly）で開いた過去セッションや、claude が終了したタブなど、
// ホーム画面の主一覧には出ないがブラウザからは開いたままのものを拾う。
export function findUnmatchedTabs(runningSessions, bridgeSessions) {
  const matched = new Set(
    annotateRunningSessions(runningSessions, bridgeSessions)
      .map((r) => r.openTab?.id)
      .filter(Boolean)
  );
  return (bridgeSessions || []).filter((s) => !matched.has(s.id));
}

// status 値（busy / shell / idle など）を表示用の 2 値に落とす。
export function statusClass(status) {
  return status === "busy" || status === "working" ? "busy" : "idle";
}

// 経過時間の短い日本語表記（ホームのカードに出す最終更新）。
export function formatElapsed(timestamp, now = Date.now()) {
  if (!timestamp) return "";
  const sec = Math.floor((now - timestamp) / 1000);
  if (sec < 0) return "たった今";
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.floor(hour / 24)}日前`;
}
