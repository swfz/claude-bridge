import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { CLAUDE_PROJECTS_DIR, cwdToProjectDir } from './jsonl-utils.js';

const execAsync = promisify(exec);

// Claude Code が `/rename` 等で更新するセッションメタの保存先
// 各ファイルは <claude プロセスPID>.json で、name / status / sessionId / cwd を持つ
export const SESSIONS_DIR = process.env.CLAUDE_BRIDGE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');

// ~/.claude/sessions/*.json を読み、claude プロセスPID -> メタ情報のマップを構築
async function readSessionMetaByPid() {
  const byPid = new Map();
  let files;
  try {
    files = await readdir(SESSIONS_DIR);
  } catch {
    return byPid;
  }
  await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const o = JSON.parse(await readFile(join(SESSIONS_DIR, f), 'utf8'));
          if (o && o.pid) byPid.set(o.pid, o);
        } catch {
          // 壊れた/書き込み途中のファイルは無視
        }
      }),
  );
  return byPid;
}

// ps で全プロセスの親子関係 (ppid -> [pid...]) を構築
async function readProcessTree() {
  const childrenOf = new Map();
  try {
    const { stdout } = await execAsync('ps -eo pid=,ppid=');
    for (const line of stdout.trim().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
      childrenOf.get(ppid).push(pid);
    }
  } catch {
    // ps が使えない環境では空マップ（紐づけ不可）
  }
  return childrenOf;
}

// シェルPID (tmux pane_pid) の子孫から claude セッションの pid を探す
export function findClaudePid(shellPid, childrenOf, metaByPid) {
  const stack = [...(childrenOf.get(shellPid) || [])];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (metaByPid.has(pid)) return pid;
    stack.push(...(childrenOf.get(pid) || []));
  }
  return null;
}

// sessionId に対応する JSONL から slug を取得（name 未設定ペインの識別フォールバック用）
async function readSlug(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const path = join(CLAUDE_PROJECTS_DIR, cwdToProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const content = await readFile(path, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.slug) return o.slug;
      } catch {
        // 行単位のパース失敗は無視
      }
    }
  } catch {
    // JSONL が見つからない場合は slug なし
  }
  return null;
}

// tmux ペイン一覧に sessionName / status / slug / claudePid / claudeSessionId を付与
export async function enrichPanesWithSessionMeta(panes) {
  if (panes.length === 0) return panes;
  const [metaByPid, childrenOf] = await Promise.all([readSessionMetaByPid(), readProcessTree()]);
  return Promise.all(
    panes.map(async (p) => {
      const claudePid = findClaudePid(Number(p.panePid), childrenOf, metaByPid);
      const meta = claudePid != null ? metaByPid.get(claudePid) : null;
      // name が無いペインだけ slug を引く（無駄な JSONL 読み込みを避ける）
      const slug = meta && !meta.name ? await readSlug(meta.cwd || p.cwd, meta.sessionId) : null;
      return {
        ...p,
        claudePid,
        claudeSessionId: meta?.sessionId ?? null,
        sessionName: meta?.name ?? null,
        status: meta?.status ?? null,
        waitingFor: meta?.waitingFor ?? null,
        slug,
      };
    }),
  );
}

// claudePid から最新の status / waitingFor を読む（タブの status 常時更新用）
// waitingFor は選択肢待ちの検知に使う（"input needed" = AskUserQuestion 等、
// "permission prompt" = ツール許可）。status が waiting でなければ null。
export async function readStatusByPid(claudePid) {
  if (claudePid == null) return { status: null, waitingFor: null };
  try {
    const o = JSON.parse(await readFile(join(SESSIONS_DIR, `${claudePid}.json`), 'utf8'));
    return { status: o.status ?? null, waitingFor: o.waitingFor ?? null };
  } catch {
    return { status: null, waitingFor: null };
  }
}
