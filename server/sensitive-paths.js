// /preview で配信してはいけない「機微なファイル」の判定。
//
// /preview は res.sendFile を dotfiles: 'allow' で呼ぶ（git worktree が `.claude/worktrees/`
// 配下にあり、既定の 'ignore' だとそこで開いたセッションのファイルが全部 404 になるため）。
// その代わり、ドット始まりなら何でも返すのではなく、資格情報の置き場として知られている
// パスは明示的に拒否する。ブリッジは認証なし・ローカル前提だが、ブラウザから叩ける
// エンドポイントで秘密鍵やトークンをそのまま返す理由はない。
//
// 許可リスト（.claude/worktrees だけ通す）にしないのは、~/.claude/ の CLAUDE.md・skills・
// memory や .github/workflows/*.yml のように、ドット配下でも普通にプレビューしたい
// ファイルが多いため。

// ディレクトリ名（パスのどこかのセグメントに現れたら配下ごと拒否）
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.terraform.d']);

// ファイル名（basename がこれなら拒否）
const SENSITIVE_FILES = new Set([
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.credentials.json', // ~/.claude/.credentials.json
  '.claude.json', // ~/.claude.json（アカウント情報）
  '.pgpass',
  '.my.cnf',
  '.bash_history',
  '.zsh_history',
]);

// 連続するセグメント列で拒否（.config / .local は雑多なので丸ごとは塞がない）
const SENSITIVE_SUBDIRS = [
  ['.config', 'gh'], // hosts.yml に OAuth トークン
  ['.config', 'gcloud'], // credentials.db / access_tokens.db
  ['.config', 'hub'], // 旧 hub コマンドの OAuth トークン
  ['.local', 'share', 'keyrings'],
  ['.git', 'config'], // URL にトークンを埋めた remote が残っていることがある
];

/**
 * 正規化済みの絶対パスが機微なファイルを指しているか。
 * @param {string} canonical path.resolve 済みのパス
 * @returns {boolean}
 */
export function isSensitivePath(canonical) {
  if (typeof canonical !== 'string' || !canonical) return false;
  // 大文字小文字を区別しない FS（macOS 既定）では ~/.SSH/ が ~/.ssh/ に解決されるので小文字で比べる
  const segs = canonical.toLowerCase().split('/').filter(Boolean);
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1];

  if (SENSITIVE_FILES.has(base)) return true;
  // .env / .env.local / .env.production など
  if (base === '.env' || base.startsWith('.env.')) return true;

  for (let i = 0; i < segs.length; i++) {
    if (SENSITIVE_DIRS.has(segs[i])) return true;
    for (const parts of SENSITIVE_SUBDIRS) {
      if (parts.every((part, j) => segs[i + j] === part)) return true;
    }
  }
  return false;
}
