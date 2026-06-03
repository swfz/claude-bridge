#!/usr/bin/env node
// claude-bridge のフックを ~/.claude/settings.json にグローバル登録する。
// 既存の hooks を壊さずマージし、claude-bridge 由来の重複は置き換える。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkInbox = resolve(__dirname, "hooks", "bridge-check-inbox.js");
const sessionStart = resolve(__dirname, "hooks", "bridge-session-start.js");

// inbox ディレクトリを先に用意する。
// SessionStart hook は inbox ディレクトリの有無で「claude-bridge 利用中か」を判定し、
// 無ければ Monitor を起動しない。初回コメント送信より前に起動したセッションでも
// monitor 配信（リアルタイム受信）が効くよう、登録時に作成しておく。
const dataDir = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), ".claude-bridge");
const inboxDir = join(dataDir, "inbox");
mkdirSync(inboxDir, { recursive: true });

const settingsPath = join(homedir(), ".claude", "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (e) {
    console.error("settings.json の読み込みに失敗:", e.message);
    process.exit(1);
  }
}

// サンドボックス有効時の書き込み許可。
// hook 本体（Stop/SessionStart）はホスト権限で動くが、Monitor が起動する
// watcher 子プロセスは Bash と同じサンドボックス制限を受け、inbox への書き込みが
// read-only FS（EROFS）で弾かれて即終了する。inbox を allowWrite に加える。
// （sandbox.enabled は触らない＝ユーザーの有効/無効設定を尊重）
settings.sandbox = settings.sandbox || {};
settings.sandbox.filesystem = settings.sandbox.filesystem || {};
const allowWrite = settings.sandbox.filesystem.allowWrite || [];
if (!allowWrite.includes(dataDir)) allowWrite.push(dataDir);
settings.sandbox.filesystem.allowWrite = allowWrite;

settings.hooks = settings.hooks || {};

// claude-bridge 由来の登録を除去するヘルパ（再実行で重複しないように）
const dropBridge = (arr, marker) =>
  (arr || []).filter((h) => !JSON.stringify(h).includes(marker));

// Stop hook（turn 配信）
settings.hooks.Stop = dropBridge(settings.hooks.Stop, "bridge-check-inbox");
settings.hooks.Stop.push({
  hooks: [{ type: "command", command: `node ${checkInbox}` }],
});

// SessionStart hook（monitor 配信。スクリプトが存在する時だけ登録）
if (existsSync(sessionStart)) {
  settings.hooks.SessionStart = dropBridge(
    settings.hooks.SessionStart,
    "bridge-session-start"
  );
  settings.hooks.SessionStart.push({
    hooks: [{ type: "command", command: `node ${sessionStart}` }],
  });
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log("[claude-bridge] フックを登録しました:");
console.log("  Stop        : node " + checkInbox);
if (existsSync(sessionStart)) console.log("  SessionStart: " + sessionStart);
console.log("  inbox       : " + inboxDir);
console.log("  allowWrite  : " + dataDir + "（sandbox 書き込み許可）");
console.log("settings: " + settingsPath);
console.log("既存セッションは Claude Code 再起動後に反映されます。");
