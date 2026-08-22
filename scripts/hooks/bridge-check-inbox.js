#!/usr/bin/env node
// claude-bridge turn 配信フック（Stop hook）
// 応答終了時に inbox の未読コメントを {decision:"block", reason} で注入する。
// 配信経路はこれ一本（monitor 常駐ウォッチャは廃止）。
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
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

const baseDir = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const inboxDir = join(baseDir, 'inbox');
const file = join(inboxDir, `${sessionId}.jsonl`);
if (!existsSync(file)) process.exit(0);

const offsetFile = join(inboxDir, `${sessionId}.offset`);
let offset = 0;
if (existsSync(offsetFile)) {
  offset = parseInt(readFileSync(offsetFile, 'utf-8').trim(), 10) || 0;
}

const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
if (lines.length <= offset) process.exit(0);

const fresh = lines.slice(offset);
writeFileSync(offsetFile, String(lines.length));

const texts = fresh
  .map((l) => {
    try {
      return JSON.parse(l).text;
    } catch {
      return '';
    }
  })
  .filter(Boolean);
if (texts.length === 0) process.exit(0);

// 監査ログ: 注入が確定したら delivery.log に全文記録する。
// 「ツール出力が改ざんされた」等と bridge を疑われた際、ここを見れば
// bridge が実際に何を・いつ注入したか（していないか）を確定できる。
const logFile = join(baseDir, 'delivery.log');
try {
  const entry = {
    ts: new Date().toISOString(),
    sessionId,
    count: texts.length,
    texts,
  };
  appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
} catch {
  // ログ失敗で配信本体は止めない
}

// 注入文には bridge 由来であることを明示する。モデルが「ツール実行結果が
// 書き換えられた」と誤解しないよう、UI 由来のユーザーメッセージだと明記する。
const reason =
  `[claude-bridge] 以下は claude-bridge の Web UI からユーザーが送信したメッセージです。\n` +
  `ツールの実行結果ではありません。\n\n` +
  `${texts.join('\n')}`;
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
