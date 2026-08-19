#!/usr/bin/env node
// claude-bridge statusLine tee。
// Claude Code の statusLine コマンドとしてこのスクリプトが登録され、stdin で渡ってくる
// JSON（cwd/cost/rate_limits 等）のうち rate_limits だけをファイルに横流ししてから、
// 元々登録されていた statusLine コマンドへそのまま引き継ぐ（表示は一切変えない）。
// 依存を持たず（node 組み込みのみ）、statusLine は毎ターン呼ばれるため軽量に保つ。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const dataDir = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const rateLimitsFile = join(dataDir, 'rate-limits.json');
const originalFile = join(dataDir, 'statusline-original.json');

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

const stdinRaw = readStdin();

// tee: rate_limits だけを抜き出してアトミックに保存する。
// ここで何が起きても（parse 不能・書き込み失敗）statusline 自体は壊さない。
try {
  const hook = JSON.parse(stdinRaw);
  if (hook && typeof hook.rate_limits === 'object' && hook.rate_limits !== null) {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${rateLimitsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ rate_limits: hook.rate_limits, ts: Date.now() }));
    renameSync(tmp, rateLimitsFile);
  }
} catch (e) {
  process.stderr.write(`[claude-bridge] statusline tee failed: ${e.message}\n`);
}

// 元の statusLine コマンドへ処理を引き継ぐ。未登録なら何も出力せず終了する。
let original;
try {
  original = JSON.parse(readFileSync(originalFile, 'utf-8'));
} catch {
  original = null;
}

const command = original?.command;
if (!command) {
  process.exit(0);
}

const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
// 元コマンドが stdin を読まずに終了すると EPIPE が飛ぶが、それで statusline を壊さない
child.stdin.on('error', () => {});
child.stdin.write(stdinRaw);
child.stdin.end();
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (e) => {
  process.stderr.write(`[claude-bridge] statusline original command failed: ${e.message}\n`);
  process.exit(0);
});
