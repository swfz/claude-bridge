#!/usr/bin/env node
// claude-bridge の statusLine tee を ~/.claude/settings.json に登録する。
// 既存の statusLine コマンドを退避し、代わりにラッパー（bridge-statusline-tee.js）を
// 挟むことで、stdin の rate_limits をファイルに横流ししつつ元の表示は変えない。
// --uninstall で退避しておいた元のコマンドに戻す。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(__dirname, 'statusline', 'bridge-statusline-tee.js');

// テストから実ファイルを差し替えられるよう、settings/data のパスは引数で上書き可能にする
// （--uninstall 以外は本番既定値を使う）
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const arg = (name) => {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const settingsPath = arg('settings-path') || join(homedir(), '.claude', 'settings.json');
const dataDir = arg('data-dir') || process.env.CLAUDE_BRIDGE_DIR || join(homedir(), '.claude-bridge');
const originalFile = join(dataDir, 'statusline-original.json');

mkdirSync(dataDir, { recursive: true });

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    console.error('settings.json の読み込みに失敗:', e.message);
    process.exit(1);
  }
}

function loadOriginal() {
  try {
    return JSON.parse(readFileSync(originalFile, 'utf-8'));
  } catch {
    return { command: null };
  }
}

if (uninstall) {
  const original = loadOriginal();
  if (original.command) {
    settings.statusLine = { ...(settings.statusLine || {}), command: original.command };
  } else {
    delete settings.statusLine;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('[claude-bridge] statusLine を元の設定に戻しました:');
  console.log('  statusLine: ' + (original.command || '(未設定)'));
  console.log('settings: ' + settingsPath);
  console.log('既存セッションは Claude Code 再起動後に反映されます。');
  process.exit(0);
}

const currentCommand = settings.statusLine?.command || null;
// ラッパー自身がすでに登録されている（再実行）場合、それを original として
// 保存してしまうと元のコマンドを失うので、original は上書きしない。
const alreadyWrapped = typeof currentCommand === 'string' && currentCommand.includes('bridge-statusline-tee');

if (!alreadyWrapped) {
  writeFileSync(originalFile, JSON.stringify({ command: currentCommand }, null, 2));
}

settings.statusLine = settings.statusLine || {};
settings.statusLine.type = settings.statusLine.type || 'command';
// 再実行時もラッパーの絶対パスを現在のリポジトリ位置に合わせて更新する
settings.statusLine.command = `node ${wrapper}`;

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log('[claude-bridge] statusLine tee を登録しました:');
console.log('  statusLine : node ' + wrapper);
console.log('  元のコマンド: ' + (alreadyWrapped ? '(前回登録時のまま保持)' : currentCommand || '(未設定)'));
console.log('  rate-limits: ' + join(dataDir, 'rate-limits.json'));
console.log('settings: ' + settingsPath);
console.log('既存セッションは Claude Code 再起動後に反映されます。');
console.log('元に戻す場合: node scripts/setup-statusline.js --uninstall');
