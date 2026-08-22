import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { SESSIONS_DIR } from './claude-session-meta.js';
import { readSessionSummaryFor } from './session-summary.js';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';

const execAsync = promisify(exec);

// ~/.claude/sessions/<pid>.json の tmux フィールド ("0:@5.%7") から pane ID を取り出す。
// tmux コマンドに渡す値なので %<数字> 形式でなければ捨てる（インジェクション対策）。
export function parsePaneId(tmuxField) {
  if (typeof tmuxField !== 'string') return null;
  const m = tmuxField.match(/(%\d+)$/);
  return m ? m[1] : null;
}

// セッションメタ JSON を、ホーム画面が必要とするフィールドだけに正規化する。
// pid / sessionId が無いものは同定できないので捨てる。
export function normalizeRunningSession(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const pid = Number(meta.pid);
  if (!Number.isInteger(pid) || !meta.sessionId) return null;
  return {
    pid,
    sessionId: meta.sessionId,
    cwd: meta.cwd || '',
    name: meta.name || null,
    status: meta.status || null,
    kind: meta.kind || null,
    version: meta.version || null,
    tmuxTarget: typeof meta.tmux === 'string' ? meta.tmux : null,
    paneId: parsePaneId(meta.tmux),
    startedAt: meta.startedAt ?? null,
    updatedAt: meta.updatedAt ?? meta.statusUpdatedAt ?? meta.startedAt ?? null,
  };
}

// ps から生存 PID の集合を得る。ps が使えない環境では null（＝生存判定なし）。
export async function readLivePids() {
  try {
    const { stdout } = await execAsync('ps -eo pid=');
    const pids = new Set();
    for (const line of stdout.trim().split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid)) pids.add(pid);
    }
    return pids;
  } catch {
    return null;
  }
}

// tmux paneId -> claude pid の逆引き。tmux で開いたが claudePid がまだ分からない
// セッション（resume_in_tmux 直後など）を、ステータスファイルの tmux フィールドの
// paneId 突合でバックフィルするために使う。
// tmux の paneId はサーバー再起動で再利用されるため、同じ paneId を持つ古い
// ステータスファイルが複数残っていることがある。生存 pid に絞ったうえで、
// 候補が複数あれば updatedAt が最新のものを採用する。
export async function mapPaneIdsToPids(paneIds, { dir = SESSIONS_DIR, livePids } = {}) {
  const targets = new Set(paneIds);
  if (targets.size === 0) return new Map();

  let files;
  try {
    files = await readdir(dir);
  } catch {
    return new Map();
  }

  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          return normalizeRunningSession(JSON.parse(await readFile(join(dir, f), 'utf8')));
        } catch {
          // 壊れた/書き込み途中のファイルは無視
          return null;
        }
      }),
  );

  const alive = livePids !== undefined ? livePids : await readLivePids();

  const byPane = new Map();
  for (const m of metas) {
    if (!m || !m.paneId || !targets.has(m.paneId)) continue;
    if (alive !== null && !alive.has(m.pid)) continue;
    const existing = byPane.get(m.paneId);
    if (!existing || (m.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byPane.set(m.paneId, m);
    }
  }

  return new Map(Array.from(byPane, ([paneId, m]) => [paneId, m.pid]));
}

// 起動中の Claude セッション一覧。~/.claude/sessions/*.json を読み、
// プロセスが生きているものだけを最終更新の新しい順で返す。
// dir / livePids はテストから差し替えられるようにしている。
export async function listRunningSessions({ dir = SESSIONS_DIR, livePids, projectsDir = CLAUDE_PROJECTS_DIR } = {}) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          return normalizeRunningSession(JSON.parse(await readFile(join(dir, f), 'utf8')));
        } catch {
          // 壊れた/書き込み途中のファイルは無視
          return null;
        }
      }),
  );

  const alive = livePids !== undefined ? livePids : await readLivePids();
  const running = metas
    .filter((m) => m && (alive === null || alive.has(m.pid)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // カードで中身が分かるよう JSONL からタイトル・直近のやりとりを添える
  // （mtime キャッシュ済みなのでポーリングしても読み直さない）
  return Promise.all(
    running.map(async (m) => ({
      ...m,
      ...(await readSessionSummaryFor(m.cwd, m.sessionId, projectsDir)),
      // cwd はセッションメタ側が正（JSONL 由来で上書きしない）
      cwd: m.cwd,
    })),
  );
}
