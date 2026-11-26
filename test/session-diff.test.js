import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chmod, mkdtemp, mkdir, realpath, writeFile, rm, symlink, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { capPatches, headerPath, parseUnifiedDiff, readSessionDiff, untrackedPatch } from '../server/session-diff.js';

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync('git', args, { cwd });

describe('parseUnifiedDiff', () => {
  it('ファイルごとに分けて状態と行数を数える', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/b.txt b/b.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1 @@',
      '+--x',
      'diff --git a/c.txt b/c.txt',
      'deleted file mode 100644',
      '--- a/c.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git a/d.bin b/d.bin',
      'Binary files a/d.bin and b/d.bin differ',
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    assert.deepEqual(
      files.map(({ path, oldPath, status, binary, additions, deletions }) => ({
        path,
        oldPath,
        status,
        binary,
        additions,
        deletions,
      })),
      [
        { path: 'a.txt', oldPath: undefined, status: 'modified', binary: false, additions: 1, deletions: 1 },
        // 本文が "--x" の追加行（+--x）を --- ヘッダと取り違えない
        { path: 'b.txt', oldPath: undefined, status: 'added', binary: false, additions: 1, deletions: 0 },
        { path: 'c.txt', oldPath: undefined, status: 'deleted', binary: false, additions: 0, deletions: 1 },
        { path: 'd.bin', oldPath: undefined, status: 'modified', binary: true, additions: 0, deletions: 0 },
        { path: 'new.txt', oldPath: 'old.txt', status: 'renamed', binary: false, additions: 0, deletions: 0 },
      ],
    );
  });

  it('空なら空配列', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });
});

describe('untrackedPatch', () => {
  it('全行を追加にする', () => {
    const { patch, additions } = untrackedPatch('x.txt', 'a\nb\n');
    assert.equal(additions, 2);
    assert.match(patch, /@@ -0,0 \+1,2 @@\n\+a\n\+b\n$/);
  });

  it('末尾改行なしを示す', () => {
    assert.match(untrackedPatch('x.txt', 'a').patch, /\+a\n\\ No newline at end of file\n$/);
  });

  it('空ファイルは hunk なし', () => {
    const { patch, additions } = untrackedPatch('x.txt', '');
    assert.equal(additions, 0);
    assert.doesNotMatch(patch, /@@/);
  });
});

describe('capPatches', () => {
  it('1 ファイルの上限と合計の上限で patch を落とす', () => {
    const files = [
      { path: 'a', patch: 'x'.repeat(5) },
      { path: 'b', patch: 'x'.repeat(20) },
      { path: 'c', patch: 'x'.repeat(5) },
      { path: 'd', patch: 'x'.repeat(5) },
    ];
    const { files: capped, truncated } = capPatches(files, { total: 12, perFile: 10 });
    assert.deepEqual(
      capped.map((f) => [f.path, f.patch.length, !!f.tooLarge]),
      [
        ['a', 5, false],
        ['b', 0, true],
        ['c', 5, false],
        ['d', 0, true],
      ],
    );
    assert.equal(truncated, true);
  });
});

describe('headerPath', () => {
  it('a/ b/ の前置き・行末のタブ・引用符を剥がす', () => {
    assert.equal(headerPath('+++ b/src/a.js'), 'src/a.js');
    assert.equal(headerPath('--- a/with space.js\t'), 'with space.js');
    assert.equal(headerPath('+++ "b/q\\"uote.js"'), 'q"uote.js');
  });
});

describe('readSessionDiff', () => {
  let repo;
  let secretDir;
  beforeAll(async () => {
    secretDir = await mkdtemp(join(tmpdir(), 'session-diff-secret-'));
    repo = await mkdtemp(join(tmpdir(), 'session-diff-'));
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 't@example.com');
    await git(repo, 'config', 'user.name', 't');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'mine.js'), 'a\n');
    await writeFile(join(repo, 'other.js'), 'o\n');
    await writeFile(join(repo, 'done.js'), 'd\n');
    await writeFile(join(repo, 'gone.js'), 'g\n');
    await writeFile(join(repo, 'with space.js'), 's\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'init');
    // このセッションの変更
    await writeFile(join(repo, 'src', 'mine.js'), 'a\nb\n');
    // 空白入りのパスは --- / +++ 行の末尾にタブが付く
    await writeFile(join(repo, 'with space.js'), 's\nt\n');
    // リンク先・資格情報の中身は出さない
    await writeFile(join(secretDir, 'id_rsa'), 'SECRET\n');
    await symlink(join(secretDir, 'id_rsa'), join(repo, 'link-to-secret'));
    await writeFile(join(repo, '.env'), 'TOKEN=SECRET\n');
    await writeFile(join(repo, 'src', 'new file.js'), 'n\n');
    await unlink(join(repo, 'gone.js'));
    // 別セッションの変更（session スコープには混ざらない）
    await writeFile(join(repo, 'other.js'), 'changed\n');
    await writeFile(join(repo, 'untracked-other.txt'), 'u\n');
    await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2]));
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  });

  it('all は未追跡を含めてリポジトリ全体の差分を返す', async () => {
    const result = await readSessionDiff({ cwd: join(repo, 'src'), scope: 'all' });
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      '.env',
      'bin.dat',
      'gone.js',
      'link-to-secret',
      'other.js',
      'src/mine.js',
      'src/new file.js',
      'untracked-other.txt',
      'with space.js',
    ]);
    assert.equal(byPath['with space.js'].status, 'modified');
    assert.equal(byPath['link-to-secret'].symlink, true);
    assert.equal(byPath['.env'].sensitive, true);
    assert.ok(result.files.every((f) => !f.patch.includes('SECRET')));
    assert.equal(byPath['src/mine.js'].status, 'modified');
    assert.equal(byPath['src/mine.js'].additions, 1);
    assert.equal(byPath['gone.js'].status, 'deleted');
    assert.equal(byPath['src/new file.js'].status, 'untracked');
    assert.equal(byPath['bin.dat'].binary, true);
    assert.equal(result.truncated, false);
  });

  it('session は編集したファイルだけに絞り、差分の無いものはコミット済みとして並べる', async () => {
    const editedFiles = [
      join(repo, 'src', 'mine.js'),
      join(repo, 'src', 'new file.js'),
      join(repo, 'gone.js'),
      join(repo, 'done.js'),
      join(repo, 'never.js'),
      join(repo, 'with space.js'),
      '/elsewhere/outside.js',
    ];
    const result = await readSessionDiff({ cwd: repo, scope: 'session', editedFiles });
    const statuses = Object.fromEntries(result.files.map((f) => [f.path, f.status]));
    assert.deepEqual(statuses, {
      'gone.js': 'deleted',
      'src/mine.js': 'modified',
      'src/new file.js': 'untracked',
      'with space.js': 'modified',
      'done.js': 'committed',
      'never.js': 'missing',
    });
    assert.equal(result.outside, 1);
  });

  it('session で編集が無ければ空', async () => {
    const result = await readSessionDiff({ cwd: repo, scope: 'session', editedFiles: [] });
    assert.deepEqual(result.files, []);
  });

  it('git 管理外はエラー', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-diff-nogit-'));
    try {
      await assert.rejects(readSessionDiff({ cwd: dir, scope: 'all' }), /git リポジトリではない/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('コミットの無いリポジトリでも差分を返す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-diff-empty-'));
    try {
      await git(dir, 'init', '-q');
      await writeFile(join(dir, 'a.txt'), 'a\n');
      await git(dir, 'add', 'a.txt');
      const result = await readSessionDiff({ cwd: dir, scope: 'all' });
      assert.deepEqual(
        result.files.map((f) => [f.path, f.status]),
        [['a.txt', 'added']],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cwd が無ければエラー', async () => {
    await assert.rejects(readSessionDiff({ scope: 'all' }), /作業ディレクトリが分かりません/);
  });

  it('ファイルはパス順に並び、変更・未追跡の patch と特殊な未追跡ファイルの中身なしを返す', async () => {
    const result = await readSessionDiff({ cwd: repo });
    assert.equal(result.scope, 'all');
    const paths = result.files.map((f) => f.path);
    assert.deepEqual(
      paths,
      [...paths].sort((a, b) => a.localeCompare(b)),
    );
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    assert.match(byPath['src/mine.js'].patch, /\n\+b\n/);
    assert.deepEqual(byPath['src/new file.js'], {
      path: 'src/new file.js',
      status: 'untracked',
      binary: false,
      additions: 1,
      deletions: 0,
      patch:
        'diff --git a/src/new file.js b/src/new file.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/new file.js\n@@ -0,0 +1,1 @@\n+n\n',
    });
    const empty = { status: 'untracked', binary: false, additions: 0, deletions: 0, patch: '' };
    assert.deepEqual(byPath['link-to-secret'], { path: 'link-to-secret', ...empty, symlink: true });
    assert.deepEqual(byPath['.env'], { path: '.env', ...empty, sensitive: true });
    assert.deepEqual(byPath['bin.dat'], { path: 'bin.dat', ...empty, binary: true });
  });

  it('session で editedFiles を省いたら編集なしとして扱う', async () => {
    const result = await readSessionDiff({ cwd: repo, scope: 'session' });
    assert.deepEqual(result.files, []);
    assert.equal(result.outside, 0);
  });

  it('session で編集がすべてリポジトリの外なら差分を取らずに件数だけ返す', async () => {
    const result = await readSessionDiff({ cwd: repo, scope: 'session', editedFiles: ['/elsewhere/a.js'] });
    assert.deepEqual(result, {
      root: await realpath(repo),
      cwdPrefix: '',
      scope: 'session',
      files: [],
      truncated: false,
      outside: 1,
    });
  });

  it('session の差分なしのファイルはパス順に、中身なしで並べる', async () => {
    const result = await readSessionDiff({
      cwd: repo,
      scope: 'session',
      editedFiles: [
        join(repo, 'with space.js'),
        join(repo, 'other.js'),
        join(repo, 'zz-missing.js'),
        join(repo, 'done.js'),
      ],
    });
    const clean = result.files.filter((f) => f.status === 'committed' || f.status === 'missing');
    const none = { binary: false, additions: 0, deletions: 0, patch: '' };
    assert.deepEqual(clean, [
      { path: 'done.js', status: 'committed', ...none },
      { path: 'zz-missing.js', status: 'missing', ...none },
    ]);
  });
});

// テストごとに 1 コミット済みのリポジトリを作って後始末する
async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'session-diff-case-'));
  try {
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 't@example.com');
    await git(dir, 'config', 'user.name', 't');
    await git(dir, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-qm', 'init');
    await fn(dir);
  } finally {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

describe('readSessionDiff の未追跡ファイルと上限', () => {
  it(
    '256KB ちょうどの未追跡ファイルは中身を出し、それを超えたら中身なしで tooLarge にする',
    { timeout: 30_000 },
    async () => {
      await withRepo(async (dir) => {
        await writeFile(join(dir, 'exact.txt'), 'a\n'.repeat(128 * 1024));
        await writeFile(join(dir, 'over.txt'), 'a\n'.repeat(128 * 1024) + 'b');
        const { files } = await readSessionDiff({ cwd: dir });
        const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
        assert.equal(byPath['exact.txt'].additions, 128 * 1024);
        assert.equal(byPath['exact.txt'].binary, false);
        assert.ok(byPath['exact.txt'].patch.endsWith('+a\n'));
        assert.equal(byPath['exact.txt'].tooLarge, undefined);
        assert.deepEqual(byPath['over.txt'], {
          path: 'over.txt',
          status: 'untracked',
          binary: false,
          additions: 0,
          deletions: 0,
          patch: '',
          tooLarge: true,
        });
      });
    },
  );

  it('読めない未追跡ファイルと入れ子のリポジトリは中身なしのバイナリ扱いにする', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();
    await withRepo(async (dir) => {
      await writeFile(join(dir, 'locked.txt'), 'secret\n');
      await chmod(join(dir, 'locked.txt'), 0o000);
      await mkdir(join(dir, 'nested'));
      await git(join(dir, 'nested'), 'init', '-q');
      // 資格情報の置き場と同じ名前の入れ子リポジトリも、ファイルでないものとして扱う
      await mkdir(join(dir, '.ssh'));
      await git(join(dir, '.ssh'), 'init', '-q');
      const { files } = await readSessionDiff({ cwd: dir });
      const bin = { status: 'untracked', binary: true, additions: 0, deletions: 0, patch: '' };
      assert.deepEqual(
        [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
        [
          { path: '.ssh/', ...bin },
          { path: 'locked.txt', ...bin },
          { path: 'nested/', ...bin },
        ],
      );
    });
  });

  it('git が列挙したのに lstat できないファイルは中身なしのバイナリ扱いにする', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();
    await withRepo(async (dir) => {
      const sub = join(dir, 'noexec');
      await mkdir(sub);
      await writeFile(join(sub, 'f.txt'), 'x\n');
      await chmod(sub, 0o444);
      try {
        const { files } = await readSessionDiff({ cwd: dir });
        assert.deepEqual(files, [
          { path: 'noexec/f.txt', status: 'untracked', binary: true, additions: 0, deletions: 0, patch: '' },
        ]);
      } finally {
        await chmod(sub, 0o755);
      }
    });
  });

  it('未追跡ファイルは 200 件まで読み、超えたら truncated にする', { timeout: 30_000 }, async () => {
    await withRepo(async (dir) => {
      for (let i = 0; i < 200; i++) await writeFile(join(dir, `u${String(i).padStart(3, '0')}.txt`), 'x\n');
      const exact = await readSessionDiff({ cwd: dir });
      assert.equal(exact.files.length, 200);
      assert.equal(exact.truncated, false);

      await writeFile(join(dir, 'u200.txt'), 'x\n');
      const over = await readSessionDiff({ cwd: dir });
      assert.equal(over.files.length, 200);
      assert.equal(over.truncated, true);
    });
  });

  it('patch の合計が 2MB を超えたら残りの patch を落として truncated にする', { timeout: 30_000 }, async () => {
    await withRepo(async (dir) => {
      for (let i = 0; i < 9; i++) await writeFile(join(dir, `big${i}.txt`), 'a\n'.repeat(125000));
      const result = await readSessionDiff({ cwd: dir });
      assert.equal(result.truncated, true);
      assert.ok(result.files.some((f) => f.tooLarge && f.patch === ''));
      assert.ok(result.files.some((f) => !f.tooLarge && f.patch !== ''));
    });
  });

  it(
    'session で編集したファイルが 500 件を超えたら 500 件までにして truncated にする',
    { timeout: 30_000 },
    async () => {
      await withRepo(async (dir) => {
        const edited = (n) => Array.from({ length: n }, (_, i) => join(dir, `e${String(i).padStart(3, '0')}.js`));
        const exact = await readSessionDiff({ cwd: dir, scope: 'session', editedFiles: edited(500) });
        assert.equal(exact.files.length, 500);
        assert.equal(exact.truncated, false);

        const over = await readSessionDiff({ cwd: dir, scope: 'session', editedFiles: edited(501) });
        assert.equal(over.files.length, 500);
        assert.ok(over.files.every((f) => f.status === 'missing'));
        assert.equal(over.truncated, true);
      });
    },
  );

  it('git diff の出力が大きすぎたら分かるエラーにする', { timeout: 30_000 }, async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, 'base.txt'), 'y\n'.repeat(11_500_000));
      const error = await readSessionDiff({ cwd: dir }).then(
        () => null,
        (e) => e,
      );
      assert.match(error?.message ?? '', /差分が大きすぎて表示できません/);
      assert.equal(error.cause?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });
  });

  it('それ以外の git diff の失敗は大きすぎるとは言わずにそのまま投げる', async () => {
    await withRepo(async (dir) => {
      // HEAD の指すコミットが存在しない壊れたリポジトリ
      const { stdout } = await git(dir, 'symbolic-ref', 'HEAD');
      await writeFile(join(dir, '.git', stdout.trim()), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      const error = await readSessionDiff({ cwd: dir }).then(
        () => null,
        (e) => e,
      );
      assert.ok(error, 'エラーになる');
      assert.doesNotMatch(error.message, /差分が大きすぎて/);
    });
  });
});

describe('parseUnifiedDiff の細部', () => {
  const pick = (files) =>
    files.map(({ path, oldPath, status, binary, additions, deletions }) => ({
      path,
      oldPath,
      status,
      binary,
      additions,
      deletions,
    }));

  it('--- と +++ が違えば +++ の側、削除なら --- の側のパスを使う', () => {
    const text = [
      'diff --git a/x b/y b/x b/z',
      'similarity index 90%',
      'rename from x b/y',
      'rename to x b/z',
      '--- a/x b/y',
      '+++ b/x b/z',
      '@@ -1 +1 @@ func()',
      '-a',
      '+b',
      'diff --git a/p b/q b/p b/q',
      'deleted file mode 100644',
      '--- a/p b/q',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n');
    assert.deepEqual(pick(parseUnifiedDiff(text)), [
      { path: 'x b/z', oldPath: 'x b/y', status: 'renamed', binary: false, additions: 1, deletions: 1 },
      { path: 'p b/q', oldPath: undefined, status: 'deleted', binary: false, additions: 0, deletions: 1 },
    ]);
  });

  it('中身の変わらない rename は rename to のパスを使う', () => {
    const text = ['diff --git a/a b/c b/a b/d', 'similarity index 100%', 'rename from a b/c', 'rename to a b/d'].join(
      '\n',
    );
    assert.deepEqual(pick(parseUnifiedDiff(text)), [
      { path: 'a b/d', oldPath: 'a b/c', status: 'renamed', binary: false, additions: 0, deletions: 0 },
    ]);
  });

  it('最初の @@ より後ろの行はヘッダとして読まない', () => {
    // ヘッダの欠けた塊で、本文に +++ / --- / rename to に見える行がある
    const text = ['diff --git a/real.txt b/real.txt', '@@ -1 +1 @@ ctx', '+++ fake.txt', '--- fake2.txt'].join('\n');
    const [file] = parseUnifiedDiff(text);
    assert.equal(file.path, 'real.txt');
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
  });

  it('--- /dev/null しか無い塊は diff --git 行のパスを使う', () => {
    const [file] = parseUnifiedDiff(['diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null'].join('\n'));
    assert.equal(file.path, 'n.txt');
  });

  it('引用符で囲まれたパスは +++ 行から読み、ヘッダの無い塊でも落ちない', () => {
    const text = [
      'diff --git "a/q\\"x.js" "b/q\\"x.js"',
      '--- "a/q\\"x.js"',
      '+++ "b/q\\"x.js"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/q\\"y.bin" "b/q\\"y.bin"',
      'Binary files "a/q\\"y.bin" and "b/q\\"y.bin" differ',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'q"x.js');
    assert.equal(files[1].binary, true);
  });

  it('git の --binary 出力もバイナリとして扱い、本文の中の文字列では判定しない', () => {
    const text = [
      'diff --git a/img.png b/img.png',
      'index 1..2 100644',
      'GIT binary patch',
      'literal 3',
      'diff --git a/t.txt b/t.txt',
      '--- a/t.txt',
      '+++ b/t.txt',
      '@@ -1 +1 @@',
      '-x',
      '+Binary files a and b differ',
    ].join('\n');
    assert.deepEqual(
      parseUnifiedDiff(text).map((f) => [f.path, f.binary]),
      [
        ['img.png', true],
        ['t.txt', false],
      ],
    );
  });

  it('先頭の diff --git 以外の行と、行の途中の diff --git では塊を分けない', () => {
    const text = [
      'warning: something',
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+run diff --git a/z b/z here',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    assert.deepEqual(
      files.map((f) => [f.path, f.additions, f.deletions]),
      [['a.txt', 1, 1]],
    );
  });

  it('undefined なら空配列', () => {
    assert.deepEqual(parseUnifiedDiff(undefined), []);
  });
});

describe('headerPath / untrackedPatch / capPatches の細部', () => {
  it('行の途中のタブ・片側だけの引用符・途中の a/ b/ は残す', () => {
    assert.equal(headerPath('+++ b/a\tb.js'), 'a\tb.js');
    assert.equal(headerPath('+++ "b/x'), '"b/x');
    assert.equal(headerPath('+++ b/x"'), 'x"');
    assert.equal(headerPath('+++ lib/a/x.js'), 'lib/a/x.js');
  });

  it('空ファイルの patch はヘッダだけ', () => {
    assert.deepEqual(untrackedPatch('e.txt', ''), {
      patch: 'diff --git a/e.txt b/e.txt\nnew file mode 100644\n--- /dev/null\n+++ b/e.txt\n',
      additions: 0,
    });
  });

  it('1 ファイルの上限を超えたものは合計に余裕があっても落とし、ちょうどの大きさは残す', () => {
    const { files, truncated } = capPatches(
      [
        { path: 'big', patch: 'x'.repeat(11) },
        { path: 'edge', patch: 'x'.repeat(10) },
        { path: 'none' },
        { path: 'fill', patch: 'x'.repeat(10) },
      ],
      { total: 20, perFile: 10 },
    );
    assert.deepEqual(
      files.map((f) => [f.path, !!f.tooLarge]),
      [
        ['big', true],
        ['edge', false],
        ['none', false],
        ['fill', false],
      ],
    );
    assert.equal(truncated, false);
  });
});

describe('readSessionDiff の cwdPrefix', () => {
  it('cwd のリポジトリ相対のプレフィックスを返す（サブディレクトリなら sub/、ルートなら空）', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cb-prefix-')));
    try {
      await git(dir, 'init', '-q');
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'sub', 'a.js'), 'x\n');
      const sub = await readSessionDiff({ cwd: join(dir, 'sub'), scope: 'all' });
      assert.equal(sub.cwdPrefix, 'sub/');
      assert.equal(sub.root, dir);
      const top = await readSessionDiff({ cwd: dir, scope: 'session', editedFiles: [] });
      assert.equal(top.cwdPrefix, '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
