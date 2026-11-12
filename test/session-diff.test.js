import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'fs/promises';
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
  before(async () => {
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
  after(async () => {
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
    await assert.rejects(readSessionDiff({ scope: 'all' }), /作業ディレクトリ/);
  });
});
