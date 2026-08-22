#!/usr/bin/env node
// claude-bridge monitor 配信の常駐ウォッチャ。
// Claude Code の Monitor ツールから起動され、inbox の新着コメントを
// 1行ずつ stdout に出す（Monitor がセッションへリアルタイムにプッシュ）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const sessionId = process.argv[2];
if (!sessionId || !/^[\w-]+$/.test(sessionId)) {
  console.error('usage: bridge-watch.js <session_id>');
  process.exit(1);
}

const baseDir = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const inboxDir = join(baseDir, 'inbox');
mkdirSync(inboxDir, { recursive: true });
const file = join(inboxDir, `${sessionId}.jsonl`);
const offsetFile = join(inboxDir, `${sessionId}.offset`);
const pidfile = join(inboxDir, `watch.${sessionId}.pid`);
const interval = (parseInt(process.env.CLAUDE_BRIDGE_WATCH_INTERVAL, 10) || 5) * 1000;

writeFileSync(pidfile, String(process.pid));
const removePid = () => {
  try {
    if (existsSync(pidfile) && readFileSync(pidfile, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(pidfile);
    }
  } catch {
    /* ignore */
  }
};
process.on('exit', removePid);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

setInterval(() => {
  if (!existsSync(file)) return;
  let offset = 0;
  if (existsSync(offsetFile)) {
    offset = parseInt(readFileSync(offsetFile, 'utf-8').trim(), 10) || 0;
  }
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  if (lines.length <= offset) return;
  const fresh = lines.slice(offset);
  writeFileSync(offsetFile, String(lines.length));
  for (const l of fresh) {
    try {
      const m = JSON.parse(l);
      if (m.text) process.stdout.write(`[claude-bridge] ${m.text}\n`);
    } catch {
      /* skip malformed */
    }
  }
}, interval);
