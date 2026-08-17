import { exec } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { SESSIONS_DIR } from "./claude-session-meta.js";

const execAsync = promisify(exec);

// ~/.claude/sessions/<pid>.json の tmux フィールド ("0:@5.%7") から pane ID を取り出す。
// tmux コマンドに渡す値なので %<数字> 形式でなければ捨てる（インジェクション対策）。
export function parsePaneId(tmuxField) {
  if (typeof tmuxField !== "string") return null;
  const m = tmuxField.match(/(%\d+)$/);
  return m ? m[1] : null;
}

// セッションメタ JSON を、ホーム画面が必要とするフィールドだけに正規化する。
// pid / sessionId が無いものは同定できないので捨てる。
export function normalizeRunningSession(meta) {
  if (!meta || typeof meta !== "object") return null;
  const pid = Number(meta.pid);
  if (!Number.isInteger(pid) || !meta.sessionId) return null;
  return {
    pid,
    sessionId: meta.sessionId,
    cwd: meta.cwd || "",
    name: meta.name || null,
    status: meta.status || null,
    kind: meta.kind || null,
    version: meta.version || null,
    tmuxTarget: typeof meta.tmux === "string" ? meta.tmux : null,
    paneId: parsePaneId(meta.tmux),
    startedAt: meta.startedAt ?? null,
    updatedAt: meta.updatedAt ?? meta.statusUpdatedAt ?? meta.startedAt ?? null,
  };
}

// ps から生存 PID の集合を得る。ps が使えない環境では null（＝生存判定なし）。
export async function readLivePids() {
  try {
    const { stdout } = await execAsync("ps -eo pid=");
    const pids = new Set();
    for (const line of stdout.trim().split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid)) pids.add(pid);
    }
    return pids;
  } catch {
    return null;
  }
}

// 起動中の Claude セッション一覧。~/.claude/sessions/*.json を読み、
// プロセスが生きているものだけを最終更新の新しい順で返す。
// dir / livePids はテストから差し替えられるようにしている。
export async function listRunningSessions({ dir = SESSIONS_DIR, livePids } = {}) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        try {
          return normalizeRunningSession(JSON.parse(await readFile(join(dir, f), "utf8")));
        } catch {
          // 壊れた/書き込み途中のファイルは無視
          return null;
        }
      })
  );

  const alive = livePids !== undefined ? livePids : await readLivePids();
  return metas
    .filter((m) => m && (alive === null || alive.has(m.pid)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
