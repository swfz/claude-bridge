#!/usr/bin/env node
// claude-bridge monitor 配信フック（SessionStart hook）
// hook input から session_id を取り出し、Claude に「Monitor ツールで
// bridge-watch.js を persistent 実行せよ」という指示を
// hookSpecificOutput.additionalContext（JSON）として出力する。
//
// 注意: SessionStart hook の additionalContext は JSON 形式
// {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
// で出さないと確実に注入されない。plain text は無視されうるため Node で生成する。
// また additionalContext は「次のユーザー入力に対する応答ターン」で初めて
// 読まれるため、セッション起動直後（入力前）には Monitor は起動しない。
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

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

const sessionId = hook.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

const baseDir = process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const inboxDir = join(baseDir, 'inbox');
// inbox ディレクトリが無い＝claude-bridge 未使用なら何もしない
if (!existsSync(inboxDir)) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = join(__dirname, 'bridge-watch.js');
if (!existsSync(watch)) process.exit(0);

const additionalContext = [
  'claude-bridge monitor: このセッション宛のコメントをリアルタイム受信するため、',
  '他の操作より先に Monitor ツールを次のパラメータで起動してください。',
  '',
  `  command: node ${watch} ${sessionId}`,
  '  description: claude-bridge inbox stream',
  '  persistent: true',
  '',
  '出力は1行=1コメント（`[claude-bridge] <本文>`）です。届いたら指示として扱い対応してください。',
].join('\n');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }),
);
