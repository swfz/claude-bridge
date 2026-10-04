// ホームの「セッション詳細」（ターン詳細）の表示用の整形。

const pad = (n) => String(n).padStart(2, '0');

// ターンの所要時間。turn_duration が無い（古い JSONL・途中で止まった）ターンは 0 なので出さない
export function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 時間 ${rest} 分` : `${hours} 時間`;
}

// ターンの開始時刻。前のターンと日付が変わったときだけ日付を付ける（同じ日なら時刻だけ）
export function formatTurnTime(iso, previousIso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const previous = previousIso ? new Date(previousIso) : null;
  const sameDay =
    previous &&
    !Number.isNaN(previous.getTime()) &&
    previous.getFullYear() === date.getFullYear() &&
    previous.getMonth() === date.getMonth() &&
    previous.getDate() === date.getDate();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

// 編集したファイルを cwd からの相対パスで見せる（cwd の外はそのまま）
export function relativeToCwd(path, cwd) {
  if (!cwd) return path;
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// PR の表示名。同じリポジトリなら #番号だけ、別リポジトリならリポジトリ名を添える
export function prLabel(pr, repository) {
  if (!pr) return '';
  const number = pr.number != null ? `#${pr.number}` : pr.url;
  return pr.repository && repository && pr.repository !== repository ? `${pr.repository}${number}` : number;
}

// セッションで一番多く出てくる PR のリポジトリ（PR ラベルを短くするための基準）
export function mainRepository(turns) {
  const counts = new Map();
  for (const t of turns || []) {
    for (const pr of t.prs || []) {
      if (pr.repository) counts.set(pr.repository, (counts.get(pr.repository) || 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [repo, count] of counts) {
    if (count > bestCount) {
      best = repo;
      bestCount = count;
    }
  }
  return best;
}
