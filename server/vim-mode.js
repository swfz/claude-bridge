// Claude Code の vim モード（editorMode: "vim"）対策。
// 入力欄が NORMAL モードのままだと、ブリッジから送った本文が vim のコマンドとして解釈され、
// 入力欄に入らず送信もされない（Esc が届いた後などに起きる）。送る前に画面で判定し、
// NORMAL なら `i` で INSERT に戻してから送る。
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const RULE_RE = /^─{10,}$/;

// 画面テキストから「入力欄が NORMAL モードか」を判定する純粋関数。
// INSERT モードではフッター（入力欄の下の罫線より後ろ）に `-- INSERT --` が出て、
// NORMAL モードでは何も出ない。入力欄（罫線 2 本に挟まれた `❯` の行）が見えないとき
// （選択肢プロンプト・モーダル表示中など）は判定できないので false を返す
export function isVimNormalMode(screen) {
  const lines = String(screen ?? '')
    .split('\n')
    .map((l) => l.trimEnd());
  const rules = [];
  lines.forEach((l, i) => {
    if (RULE_RE.test(l.trim())) rules.push(i);
  });
  if (rules.length < 2) return false;
  const bottom = rules[rules.length - 1];
  const top = rules[rules.length - 2];
  const box = lines.slice(top + 1, bottom);
  if (!box.some((l) => l.startsWith('❯'))) return false;
  const footer = lines.slice(bottom + 1).join('\n');
  if (!footer.trim()) return false;
  return !footer.includes('-- INSERT --');
}

const CONFIG_TTL_MS = 30_000;
let cache = null;

// ~/.claude/settings.json か ~/.claude.json の editorMode が "vim" か。30 秒キャッシュ。
// vim モードでなければ `-- INSERT --` は出ないので、これが偽なら画面判定はしない
// （判定すると、通常モードで `i` を打ち込んでしまう）
export async function isVimEditorEnabled({ home = os.homedir(), now = Date.now() } = {}) {
  if (cache && cache.home === home && now - cache.at < CONFIG_TTL_MS) return cache.value;
  let value = false;
  for (const file of [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json')]) {
    try {
      const json = JSON.parse(await readFile(file, 'utf-8'));
      if (json?.editorMode === 'vim') {
        value = true;
        break;
      }
    } catch {
      // 無い・壊れているファイルは vim 設定なしとみなす
    }
  }
  cache = { home, at: now, value };
  return value;
}

export function clearVimEditorCache() {
  cache = null;
}
