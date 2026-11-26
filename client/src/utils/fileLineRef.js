import { isPreviewable } from './previewExts.js';

// Claude の返答に出てくる `path:行` の読み取り（差分ドロワーのその行へ飛ぶため）。
//
// 拾う書き方: `src/app.js:42`、`src/app.js:42-50`、`src/app.js:L42`、`src/app.js:L42-L50`、`src/app.js#L42`、
// `/abs/path/app.js:42`（後ろに `:列` が付いていても行だけ使う）。パスは「`/` を含む」か「拡張子がある」ものだけ。
// 誤検出させないもの: URL（`http://host:8080`）、時刻（`12:30`）、`a:b` のような語、Windows のドライブ文字（`C:\x`）、
// `user@host.com:22`、数字と `/` だけのもの（`3/4:1`・`10.0.0.1/24:1`）、`~/`（home はクライアントで展開できない）。
// 地の文ではさらに、`/` を含まないものはプレビューできる拡張子のときだけ拾う（`foo.bar:3000`・`api.example.com:8080`）

// パスの部分に使える文字（空白・引用符・コロン・バックスラッシュは含めない）
const SEGMENT = '[\\w.@+-]+';
const PATH = `/?${SEGMENT}(?:/${SEGMENT})*`;
// `:42` `:42-50` `:L42` `:L42-L50` `:42:7`（列は捨てる）、`#L42` `#L42-L50`
const SUFFIX = '(?::L?(\\d+)(?:-L?(\\d+))?(?::\\d+)?|#L(\\d+)(?:-L(\\d+))?)';

const FULL_RE = new RegExp(`^(${PATH})${SUFFIX}$`);
// 地の文から探す。直前が語・パス・URL の一部（英数字・/ . : - \ @ など）なら拾わない（URL の途中・ドライブ文字を除く）。
// 直後に英数字・パスの続き（/ : -）、または `.英数字`（`app.js:42.5` など）が続くなら拾わない
const BARE_RE = new RegExp(`(?<![\\w/.:@+~\\\\-])(${PATH})${SUFFIX}(?![\\w/:-]|\\.\\w)`, 'g');

// パスらしいか: `/` を含むか、英字で始まる拡張子がある（`v1.2` の `2` は拡張子とみなさない）
export function looksLikePath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes(':') || path.includes('\\')) return false;
  // `user@host`（@ の前に文字がある）。`@scope/pkg` のような先頭・`/` の直後の @ は通す
  if (/[^/]@/.test(path)) return false;
  // 数字と . / だけ（分数・IP アドレス・日付）
  if (/^[\d./]+$/.test(path)) return false;
  const base = path.split('/').pop();
  if (!base || /^\.+$/.test(base)) return false;
  return path.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(base);
}

function toRef(path, a, b, c, d) {
  const line = Number(a ?? c);
  const endRaw = b ?? d;
  const endLine = endRaw == null ? null : Number(endRaw);
  if (!Number.isInteger(line) || line < 1 || line > 1e7) return null;
  if (endLine != null && (!Number.isInteger(endLine) || endLine < line || endLine > 1e7)) return null;
  if (!looksLikePath(path)) return null;
  return { path, line, endLine: endLine != null && endLine > line ? endLine : null };
}

// インラインコードの中身全体が `path:行` か。{path, line, endLine} か null
export function parseFileLineRef(text) {
  if (typeof text !== 'string') return null;
  const m = FULL_RE.exec(text.trim());
  if (!m) return null;
  return toRef(m[1], m[2], m[3], m[4], m[5]);
}

// 地の文から `path:行` を探す。[{start, end, raw, path, line, endLine}]（出現順）
export function findFileLineRefs(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  BARE_RE.lastIndex = 0;
  let m;
  while ((m = BARE_RE.exec(text))) {
    const ref = toRef(m[1], m[2], m[3], m[4], m[5]);
    // 地の文は誤検出が目立つので、`/` を含まないものはプレビューできる拡張子に限る（ドメイン・host:port を除く）
    if (ref && !ref.path.includes('/') && !isPreviewable(ref.path)) continue;
    if (ref) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0], ...ref });
  }
  return out;
}

// 行の表記（ピルに薄く添える）。`:42` / `:42-50`
export function lineSuffix({ line, endLine }) {
  return endLine ? `:${line}-${endLine}` : `:${line}`;
}

function trimSlash(p) {
  return p.replace(/\/+$/, '');
}

// 差分の path（リポジトリ相対）に直す。path は絶対パスか相対パス。root はリポジトリのルート（git の実体パス）、
// cwd はセッションの作業ディレクトリ（worktree やシンボリックリンクで root と表記が違い得る）、cwdPrefix は
// サーバーが返す「cwd のリポジトリ相対のプレフィックス」（git rev-parse --show-prefix。'' か 'sub/'）。
// → {rel, exact}。exact が偽なら rel は「どこかのディレクトリからの相対」でしか分からない（cwd が root の外に見え、
// cwdPrefix も無い）ので、末尾一致でしか当てない。相対パスはそのまま（先頭の ./ を外す）。どちらの下でもなければ null
export function resolveDiffPath(path, { root, cwd, cwdPrefix } = {}) {
  if (typeof path !== 'string' || !path) return null;
  if (!path.startsWith('/')) return { rel: path.replace(/^(\.\/)+/, ''), exact: true };
  const r = root ? trimSlash(root) : null;
  if (r && path.startsWith(`${r}/`)) return { rel: path.slice(r.length + 1), exact: true };
  const c = cwd ? trimSlash(cwd) : null;
  if (c && path.startsWith(`${c}/`)) {
    const rest = path.slice(c.length + 1);
    if (typeof cwdPrefix === 'string') return { rel: `${cwdPrefix}${rest}`, exact: true };
    // cwd がリポジトリの中のサブディレクトリ（表記も root と同じ）なら、その分を前に足す
    if (r && c.startsWith(`${r}/`)) return { rel: `${c.slice(r.length + 1)}/${rest}`, exact: true };
    return { rel: rest, exact: false };
  }
  return null;
}

// 表示・注記用の相対パス（分からなければ null）
export function relativeToRoot(path, where = {}) {
  return resolveDiffPath(path, where)?.rel ?? null;
}

// 差分のファイル一覧から path に当たるものを引く。完全一致、無ければ末尾一致（`/rel` で終わるものが 1 つだけ）。
// cwd 起点でしか相対にできない（exact が偽）ときは、別のディレクトリの同名ファイルを指さないよう末尾一致だけにする
export function matchDiffFile(files, path, where = {}) {
  const resolved = resolveDiffPath(path, where);
  if (!resolved) return null;
  const { rel, exact } = resolved;
  const list = files || [];
  if (exact) {
    const hit = list.find((f) => f.path === rel);
    if (hit) return hit;
  }
  const tail = list.filter((f) => f.path.endsWith(`/${rel}`));
  return tail.length === 1 ? tail[0] : null;
}

// 表示用の名前（差分の相対パスが分かればそれ、無ければファイル名）
export function displayRef(path, { line, endLine }, rel = null) {
  const name = rel || (typeof path === 'string' ? path.split('/').pop() : '');
  return `${name}${lineSuffix({ line, endLine })}`;
}

// 差分に飛び先の行が無かったときの注記の中身（{text, title, searchAll?}）。text は「<ファイル名:行> は …」の … の部分。
// file は差分に見つかったファイル（無ければ null）、rows はその行モデル、scope は今の範囲、rel は相対パス（分からなければ null）
export function jumpMissReason({ file, rows, scope, rel }) {
  if (file) {
    if (file.tooLarge) {
      return { text: '差分が大きく行を出していない', title: '差分が大きいため、このファイルの行は省略しています' };
    }
    if (file.binary) return { text: 'バイナリで行が無い', title: 'バイナリファイルのため行を出していません' };
    if (file.sensitive || file.symlink)
      return { text: '中身を出していない', title: 'このファイルは中身を表示しません' };
    if (!rows || rows.length === 0) return { text: '差分に無い行', title: 'このファイルに行の差分はありません' };
    return { text: '差分に無い行', title: 'この行は変更されていません' };
  }
  if (!rel) return { text: '差分に無い行', title: 'リポジトリの外か、差分のどのファイルか特定できません' };
  if (scope === 'session') {
    return {
      text: '差分に無い行',
      title: 'このセッションの編集に見つかりません（Bash での書き換えなどは「このセッション」に出ません）',
      searchAll: true,
    };
  }
  return { text: '差分に無い行', title: 'このファイルは差分に含まれていません' };
}
