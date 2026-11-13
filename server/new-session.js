// 新規セッション（内蔵 PTY）の起動オプション。
// `-w`（--worktree）を付けると claude は git worktree を作ってそこへ移るので、起動時の cwd と
// JSONL の置き場（projectDir）がずれる。移り先は Claude Code が書くステータスファイル
// （<SESSIONS_DIR>/<pid>.json の cwd）から拾って、JSONL 監視をそちらに向ける。
import * as childProcess from 'child_process';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { SESSIONS_DIR } from './claude-session-meta.js';
import { escapeForShell } from './tmux-session.js';

// worktree 名は claude にそのまま渡すので、ディレクトリ名として安全な文字だけ許す
export const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// モデル指定（opus / sonnet / claude-opus-5-5 / opus[1m] など）。引数として渡すので記号は絞る
export const MODEL_RE = /^[A-Za-z0-9][\w.[\]-]{0,63}$/;
export const PROMPT_MAX = 20000;

// クライアントの指定から claude のオプション引数を作る（最初の指示は含めない）。不正な値は throw（黙って捨てない）
export function buildNewSessionArgs({ worktree, worktreeName, model, sessionId } = {}) {
  const args = [];
  if (sessionId) args.push('--session-id', sessionId);
  const modelName = typeof model === 'string' ? model.trim() : '';
  if (modelName) {
    if (!MODEL_RE.test(modelName)) throw new Error(`モデル名が不正です: ${modelName}`);
    args.push('--model', modelName);
  }
  if (worktree) {
    const name = typeof worktreeName === 'string' ? worktreeName.trim() : '';
    if (name && !WORKTREE_NAME_RE.test(name)) {
      throw new Error('worktree 名は英数字と . _ - だけ（64 文字まで）にしてください');
    }
    args.push('-w', ...(name ? [name] : []));
  }
  return args;
}

// 最初の指示（claude の位置引数）。空なら null。`-w [name]` に食われないよう呼び出し側で `--` の後ろに置く
export function normalizePrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const text = prompt.trim();
  if (!text) return null;
  if (text.length > PROMPT_MAX) throw new Error(`最初の指示が長すぎます（${PROMPT_MAX} 文字まで）`);
  return text;
}

// 内蔵 PTY 用: spawn に渡す引数配列（シェルを通らない）
export function ptyArgs(args, prompt) {
  return prompt ? [...args, '--', prompt] : args;
}

// tmux 用: シェルに打つ 1 行。最初の指示は改行を含み得て send-keys で打つと崩れるので、
// 0600 のファイルに書いておき、コマンド置換で読んだ直後に消す
export function tmuxCommand(args, promptFile) {
  const parts = ['claude', ...args.map((a) => escapeForShell(a))];
  if (promptFile) {
    const f = escapeForShell(promptFile);
    parts.push('--', `"$(cat ${f}; rm -f ${f})"`);
  }
  return parts.join(' ');
}

export async function writePromptFile(dataDir, id, prompt) {
  const dir = join(dataDir, 'prompts');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.txt`);
  await writeFile(file, prompt, { mode: 0o600 });
  return file;
}

// cwd が git 管理下か（-w は git リポジトリでないと失敗する）
export function isGitRepo(cwd, { run = defaultRun } = {}) {
  return run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    .then((out) => out.trim() === 'true')
    .catch(() => false);
}

function defaultRun(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, { ...opts, timeout: 10000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

// claude の pid のステータスファイルに worktree（<repo>/.claude/worktrees/<name>）の cwd が書かれるまで待つ。
// 起動直後は元の cwd のまま書かれ得る。元の cwd との比較は末尾の / やシンボリックリンクの解決で
// 食い違うので、worktree のパスかどうかで判定する（見つからなければ null）
export async function waitForSessionCwd(pid, { timeoutMs = 30000, intervalMs = 500, dir = SESSIONS_DIR } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const o = JSON.parse(await readFile(join(dir, `${pid}.json`), 'utf8'));
      if (typeof o.cwd === 'string' && o.cwd.includes('/.claude/worktrees/')) return o.cwd;
    } catch {
      // まだ書かれていない／書きかけ
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// tmux 起動では pid がすぐ分からないので、sessionId でステータスファイルを探して worktree の cwd を待つ
export async function waitForSessionCwdById(
  sessionId,
  { timeoutMs = 30000, intervalMs = 500, dir = SESSIONS_DIR } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let files = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      // まだ無い
    }
    for (const f of files) {
      try {
        const o = JSON.parse(await readFile(join(dir, f), 'utf8'));
        if (o.sessionId === sessionId && typeof o.cwd === 'string' && o.cwd.includes('/.claude/worktrees/')) {
          return o.cwd;
        }
      } catch {
        // 書きかけ
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
