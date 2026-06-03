#!/usr/bin/env node
// claude-bridge turn 配信フック（Stop hook）
// 応答終了時に inbox の未読コメントを {decision:"block", reason} で注入する。
// monitor watcher が生きているセッションでは defer（二重配信を避ける）。
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

let hook = {};
try {
  hook = JSON.parse(readStdin());
} catch {
  process.exit(0);
}

// 無限ループ回避（block で再起動した Stop は処理しない）
if (hook.stop_hook_active) process.exit(0);

const sessionId = hook.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

const baseDir =
  process.env.CLAUDE_BRIDGE_DIR || join(homedir(), ".claude-bridge");
const inboxDir = join(baseDir, "inbox");
const file = join(inboxDir, `${sessionId}.jsonl`);
if (!existsSync(file)) process.exit(0);

// monitor watcher 生存時は monitor 側が配信するので defer
const pidfile = join(inboxDir, `watch.${sessionId}.pid`);
if (existsSync(pidfile)) {
  try {
    const wpid = parseInt(readFileSync(pidfile, "utf-8").trim(), 10);
    if (wpid) {
      process.kill(wpid, 0); // 生存なら例外を投げない
      process.exit(0);
    }
  } catch {
    // 死んでいれば通常処理へ
  }
}

const offsetFile = join(inboxDir, `${sessionId}.offset`);
let offset = 0;
if (existsSync(offsetFile)) {
  offset = parseInt(readFileSync(offsetFile, "utf-8").trim(), 10) || 0;
}

const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
if (lines.length <= offset) process.exit(0);

const fresh = lines.slice(offset);
writeFileSync(offsetFile, String(lines.length));

const texts = fresh
  .map((l) => {
    try {
      return JSON.parse(l).text;
    } catch {
      return "";
    }
  })
  .filter(Boolean);
if (texts.length === 0) process.exit(0);

const reason = `[claude-bridge からのコメント]\n${texts.join("\n")}`;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
