import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// agent view が扱うバックグラウンドセッション一覧を取得する。
// `claude agents --json` は TTY 不要でライブセッションを JSON 配列で返す（claude プロセスは起動しない）。
// execFile（シェル非経由）+ timeout で安全に実行する。
export async function listClaudeAgents() {
  try {
    const { stdout } = await execFileAsync("claude", ["agents", "--json"], {
      timeout: 5000,
    });
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr)) return [];
    // 必要なフィールドだけ抽出（過剰な情報流出を避ける）
    return arr.map((a) => ({
      pid: a.pid,
      cwd: a.cwd,
      kind: a.kind,
      sessionId: a.sessionId,
      name: a.name,
      status: a.status,
    }));
  } catch {
    return [];
  }
}
