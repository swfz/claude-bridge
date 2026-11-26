import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyEdit,
  clearDiffSourcesCache,
  clearTurnDiffCache,
  lineCount,
  patchLineDelta,
  slimRecord,
  contentPatch,
  editFromRecord,
  listDiffSources,
  mayBeEditResult,
  perEditPatch,
  readCommitDiff,
  readTurnDiff,
  replayEdits,
  turnIndexAt,
} from '../server/session-diff-sources.js';
import { parseDiffRows } from '../client/src/utils/diffView.js';

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync('git', args, { cwd });

async function initRepo(dir) {
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 't@example.com');
  await git(dir, 'config', 'user.name', 't');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  // 手元のグローバルなフック（secretlint など）が .env のコミットを止めないよう、このリポジトリだけ外す
  await git(dir, 'config', 'core.hooksPath', '/dev/null');
}

function prompt(text, timestamp) {
  return { type: 'user', timestamp, message: { role: 'user', content: text } };
}

function result(toolUseResult, timestamp, { isError = false } = {}) {
  return {
    type: 'user',
    timestamp,
    toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: isError, content: 'ok' }] },
  };
}

function bash(id, command, timestamp) {
  return {
    type: 'assistant',
    timestamp,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  };
}

function bashResult(id, timestamp) {
  return {
    type: 'user',
    timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  };
}

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('editFromRecord', () => {
  const ts = '2026-01-01T00:00:00Z';
  it('Write 新規・上書き・Edit・MultiEdit を見分ける', () => {
    const create = editFromRecord(
      result({ type: 'create', filePath: '/r/a.js', content: 'x', originalFile: null, structuredPatch: [] }, ts),
    );
    assert.equal(create.kind, 'create');
    assert.equal(create.content, 'x');
    const write = editFromRecord(
      result({ type: 'update', filePath: '/r/a.js', content: 'y', originalFile: 'x', structuredPatch: [] }, ts),
    );
    assert.equal(write.kind, 'write');
    assert.equal(write.originalFile, 'x');
    const edit = editFromRecord(
      result({ filePath: '/r/a.js', oldString: 'a', newString: 'b', originalFile: null, structuredPatch: [] }, ts),
    );
    assert.equal(edit.kind, 'edit');
    assert.equal(edit.originalFile, null);
    const multi = editFromRecord(result({ filePath: '/r/a.js', edits: [], structuredPatch: [] }, ts));
    assert.equal(multi.kind, 'multi');
  });

  it('一覧用（full: false）は中身を持たない', () => {
    const edit = editFromRecord(
      result({ type: 'update', filePath: '/r/a.js', content: 'big', originalFile: 'x', structuredPatch: [] }, ts),
      { full: false },
    );
    assert.deepEqual(edit, { ts, filePath: '/r/a.js', kind: 'write' });
  });

  it('失敗した編集・形の違うもの・相対パスは除く', () => {
    const ok = { filePath: '/r/a.js', oldString: 'a', newString: 'b', structuredPatch: [] };
    assert.equal(editFromRecord(result(ok, ts, { isError: true })), null);
    assert.equal(editFromRecord(result('Error: string result', ts)), null);
    assert.equal(editFromRecord(result({ ...ok, filePath: 'a.js' }, ts)), null);
    assert.equal(editFromRecord(result({ ...ok, structuredPatch: 'x' }, ts)), null);
    assert.equal(editFromRecord(result({ filePath: '/r/a.js', structuredPatch: [] }, ts)), null);
    assert.equal(editFromRecord({ ...result(ok, ts), type: 'assistant' }), null);
    assert.equal(editFromRecord(null), null);
  });

  it('プリフィルタは toolUseResult と structuredPatch の両方を含む行だけ通す', () => {
    assert.equal(mayBeEditResult('{"toolUseResult":{"structuredPatch":[]}}'), true);
    assert.equal(mayBeEditResult('{"message":"structuredPatch"}'), false);
  });
});

describe('applyEdit / replayEdits', () => {
  it('置き換え後の文字列の $& などを展開しない', () => {
    assert.equal(applyEdit('a b a', 'a', '$&$1', false), '$&$1 b a');
    assert.equal(applyEdit('a b a', 'a', '$$', true), '$$ b $$');
    assert.equal(applyEdit('abc', 'x', 'y', false), null);
    assert.equal(applyEdit('abc', 'x', 'y', true), null);
    assert.equal(applyEdit('', '', 'new', false), 'new');
    assert.equal(applyEdit('old', '', 'new', false), null);
    assert.equal(applyEdit('abc', 1, 'y', false), null);
  });

  it('新規作成から再生する', () => {
    const r = replayEdits([
      { kind: 'create', content: 'a\nb\n', originalFile: null },
      { kind: 'edit', oldString: 'b', newString: 'c', originalFile: null },
      { kind: 'multi', edits: [{ old_string: 'a', new_string: 'z' }], originalFile: 'a\nc\n' },
    ]);
    assert.deepEqual(r, { start: '', end: 'z\nc\n', created: true });
  });

  it('最初の編集の originalFile が null なら再生しない', () => {
    assert.equal(replayEdits([{ kind: 'edit', oldString: 'a', newString: 'b', originalFile: null }]), null);
  });

  it('途中で合わなくなったら null（oldString が無い・記録された直前の内容と違う・上書きの中身が無い）', () => {
    assert.equal(
      replayEdits([
        { kind: 'write', content: 'x', originalFile: 'o' },
        { kind: 'edit', oldString: 'nope', newString: 'b', originalFile: null },
      ]),
      null,
    );
    assert.equal(
      replayEdits([
        { kind: 'write', content: 'x', originalFile: 'o' },
        { kind: 'edit', oldString: 'x', newString: 'y', originalFile: 'changed by bash' },
      ]),
      null,
    );
    assert.equal(replayEdits([{ kind: 'write', content: null, originalFile: 'o' }]), null);
    assert.equal(
      replayEdits([
        { kind: 'write', content: 'x', originalFile: 'o' },
        { kind: 'create', content: 'again', originalFile: null },
      ]),
      null,
    );
    assert.equal(
      replayEdits([
        { kind: 'write', content: 'abc', originalFile: 'o' },
        { kind: 'multi', edits: [{ old_string: 'q', new_string: 'r' }], originalFile: null },
      ]),
      null,
    );
  });
});

describe('再生の検算（行数の増減・userModified）', () => {
  const hunk = (oldLines, newLines) => [{ oldStart: 1, oldLines, newStart: 1, newLines, lines: [] }];
  it('lineCount / patchLineDelta', () => {
    assert.equal(lineCount(''), 0);
    assert.equal(lineCount('a'), 1);
    assert.equal(lineCount('a\n'), 1);
    assert.equal(lineCount('a\nb'), 2);
    assert.equal(patchLineDelta([]), null);
    assert.equal(patchLineDelta(null), null);
    assert.equal(patchLineDelta([{ oldLines: 'x', newLines: 1 }]), null);
    assert.equal(patchLineDelta([...hunk(1, 3), ...hunk(2, 1)]), 1);
  });

  it('最後の編集でも、行数の増減が structuredPatch と合わなければ再生しない', () => {
    const start = 'a\nb\n';
    const ok = replayEdits([
      { kind: 'edit', oldString: 'b', newString: 'b\nc', originalFile: start, structuredPatch: hunk(1, 2) },
    ]);
    assert.equal(ok.end, 'a\nb\nc\n');
    // 記録された structuredPatch は 2 行増やしているのに、再生では 1 行しか増えない（間に別の書き換えがあった等）
    const bad = replayEdits([
      { kind: 'edit', oldString: 'b', newString: 'b\nc', originalFile: start, structuredPatch: hunk(1, 3) },
    ]);
    assert.equal(bad, null);
  });

  it('userModified の編集があれば再生しない', () => {
    assert.equal(
      replayEdits([{ kind: 'write', content: 'x', originalFile: 'o', structuredPatch: [], userModified: true }]),
      null,
    );
    const e = editFromRecord(
      result(
        { filePath: '/r/a.js', oldString: 'a', newString: 'b', structuredPatch: [], userModified: true },
        '2026-01-01T00:00:00Z',
      ),
    );
    assert.equal(e.userModified, true);
  });
});

describe('slimRecord', () => {
  it('buildTurns に要る部分だけを残す', () => {
    const p = prompt('指示', 't0');
    assert.deepEqual(slimRecord({ ...p, toolUseResult: { big: 'x' } }), p);
    assert.deepEqual(
      slimRecord({
        type: 'user',
        timestamp: 't1',
        toolUseResult: { content: 'big' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'long output' }] },
      }),
      {
        type: 'user',
        timestamp: 't1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true }] },
      },
    );
    assert.equal(slimRecord({ type: 'user', message: { content: [{ type: 'text', text: '<tag>' }] } }), null);
    assert.equal(slimRecord({ type: 'user', isMeta: true, message: { content: 'meta' } }), null);
    const a = slimRecord({
      type: 'assistant',
      timestamp: 't2',
      message: {
        id: 'm1',
        model: 'claude-x',
        usage: { input_tokens: 1 },
        content: [
          { type: 'text', text: '長い本文' },
          { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'git commit -m "x"', description: 'd' } },
          { type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: '/a', old_string: 'big' } },
          { type: 'tool_use', id: 'u3', name: 'Read', input: { file_path: '/b' } },
        ],
      },
    });
    assert.deepEqual(a.message.content, [
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'git commit -m "x"' } },
      { type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: '/a', notebook_path: undefined } },
    ]);
    assert.deepEqual(a.message.usage, { input_tokens: 1 });
    assert.deepEqual(slimRecord({ type: 'assistant' }).message.content, []);
    const d = { type: 'system', subtype: 'turn_duration', durationMs: 5 };
    assert.equal(slimRecord(d), d);
    const pr = { type: 'pr-link', prUrl: 'u' };
    assert.equal(slimRecord(pr), pr);
    assert.equal(slimRecord({ type: 'system', subtype: 'other' }), null);
    assert.equal(slimRecord(null), null);
  });
});

describe('perEditPatch', () => {
  it('編集ごとの hunk を時刻順に並べ、見出しに「編集 k/n」を添える', () => {
    const patch = perEditPatch('src/a.js', [
      {
        kind: 'edit',
        structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-a', '+b'] }],
      },
      {
        kind: 'edit',
        structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-b', '+c'] }],
      },
    ]);
    assert.match(patch, /^diff --git a\/src\/a\.js b\/src\/a\.js\n--- a\/src\/a\.js\n\+\+\+ b\/src\/a\.js\n/);
    assert.match(patch, /@@ -10,1 \+10,1 @@ 編集 1\/2\n-a\n\+b\n@@ -10,1 \+10,1 @@ 編集 2\/2\n-b\n\+c\n$/);
    // 2 つの hunk は同じ行番号を持つ（行モデルの hunk 番号で見分ける）
    const rows = parseDiffRows(patch).filter((r) => r.kind === 'add');
    assert.deepEqual(
      rows.map((r) => [r.newLine, r.hunk]),
      [
        [10, 0],
        [10, 1],
      ],
    );
  });

  it('structuredPatch が空の新規作成は中身から作る', () => {
    const patch = perEditPatch('n.txt', [{ kind: 'create', content: 'x\ny\n', structuredPatch: [] }]);
    assert.match(patch, /new file mode 100644\n--- \/dev\/null/);
    assert.match(patch, /@@ -0,0 \+1,2 @@ 編集 1\/1\n\+x\n\+y\n$/);
  });
});

describe('turnIndexAt', () => {
  it('ターンの開始時刻から番号（1 始まり）を引く', () => {
    const starts = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T01:00:00Z')];
    assert.equal(turnIndexAt(starts, '2025-12-31T23:00:00Z'), 0);
    assert.equal(turnIndexAt(starts, '2026-01-01T00:00:00Z'), 1);
    assert.equal(turnIndexAt(starts, '2026-01-01T00:59:59Z'), 1);
    assert.equal(turnIndexAt(starts, '2026-01-01T01:00:00Z'), 2);
    assert.equal(turnIndexAt(starts, 'bad'), 0);
  });
});

describe('contentPatch', () => {
  it('git diff --no-index の出力からヘッダを組み直す（一時パスを出さない）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-cp-'));
    try {
      const patch = await contentPatch('src/x y.js', 'a\nb\n', 'a\nc\n', dir);
      assert.match(
        patch,
        /^diff --git a\/src\/x y\.js b\/src\/x y\.js\n--- a\/src\/x y\.js\n\+\+\+ b\/src\/x y\.js\n@@/,
      );
      assert.ok(!patch.includes(dir));
      assert.match(patch, /-b\n\+c\n$/);
      assert.equal(await contentPatch('same.js', 'a\n', 'a\n', dir), '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readTurnDiff / listDiffSources', () => {
  let base;
  let repo;
  let jsonlDir;
  let filePath;
  const SID = 'sess-1';

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'cb-turn-')));
    repo = join(base, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await initRepo(repo);
    await writeFile(join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'init');
    jsonlDir = join(base, 'projects');
    await mkdir(join(jsonlDir, SID, 'subagents'), { recursive: true });
    filePath = join(jsonlDir, `${SID}.jsonl`);

    const a = join(repo, 'src/a.js');
    const b = join(repo, 'src/b.js');
    const env = join(repo, '.env');
    const out = join(base, 'scratch.txt');
    await writeFile(
      filePath,
      jsonl([
        // ターン 1: Edit（originalFile あり）→ 再生できる。失敗した編集は除く
        prompt('最初の指示', '2026-01-01T00:00:00Z'),
        result(
          {
            filePath: a,
            oldString: 'two',
            newString: 'TWO',
            originalFile: 'one\ntwo\nthree\n',
            structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-two', '+TWO'] }],
          },
          '2026-01-01T00:00:10Z',
        ),
        result(
          { filePath: a, oldString: 'one', newString: 'ONE', originalFile: 'x', structuredPatch: [] },
          '2026-01-01T00:00:11Z',
          { isError: true },
        ),
        // 本文に structuredPatch と書いてあるだけの行（プリフィルタは通るが編集ではない）
        { type: 'assistant', timestamp: '2026-01-01T00:00:12Z', message: { content: 'toolUseResult structuredPatch' } },
        bash('c1', 'git commit -m "first change"', '2026-01-01T00:00:20Z'),
        bashResult('c1', '2026-01-01T00:00:21Z'),
        // ターン 2: 編集なし
        prompt('質問だけ', '2026-01-01T01:00:00Z'),
        // ターン 3: Edit（originalFile null）が 2 回 → 編集ごとの差分。新規作成・.env・リポジトリ外
        prompt('三つ目の指示', '2026-01-01T02:00:00Z'),
        result(
          {
            filePath: a,
            oldString: 'three',
            newString: 'THREE',
            originalFile: null,
            structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-three', '+THREE'] }],
          },
          '2026-01-01T02:00:10Z',
        ),
        result(
          {
            filePath: a,
            oldString: 'THREE',
            newString: 'four',
            originalFile: null,
            structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-THREE', '+four'] }],
          },
          '2026-01-01T02:00:30Z',
        ),
        result(
          { type: 'create', filePath: env, content: 'SECRET=1\n', originalFile: null, structuredPatch: [] },
          '2026-01-01T02:00:40Z',
        ),
        result(
          { type: 'create', filePath: out, content: 'scratch\n', originalFile: null, structuredPatch: [] },
          '2026-01-01T02:00:41Z',
        ),
      ]),
    );
    // サブエージェント: ターン 3 の区間に新規作成と編集（本体の編集より時刻が後なのでその後に並ぶ）
    await writeFile(
      join(jsonlDir, SID, 'subagents', 'agent-x.jsonl'),
      jsonl([
        prompt('サブエージェントへのタスク（ターンの区切りにしない）', '2026-01-01T02:00:05Z'),
        result(
          { type: 'create', filePath: b, content: 'b1\n', originalFile: null, structuredPatch: [] },
          '2026-01-01T02:00:20Z',
        ),
        result(
          {
            filePath: b,
            oldString: 'b1',
            newString: 'b2',
            originalFile: 'b1\n',
            structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-b1', '+b2'] }],
          },
          '2026-01-01T02:00:25Z',
        ),
      ]),
    );
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearDiffSourcesCache();
    clearTurnDiffCache();
  });

  it('ターンの差分は JSONL が変わらない間は使い回し、追記されたら取り直す', async () => {
    const first = await readTurnDiff({ filePath, cwd: repo, index: 1 });
    assert.equal(await readTurnDiff({ filePath, cwd: repo, index: 1 }), first);
    await appendFile(filePath, JSON.stringify({ type: 'system', subtype: 'noop' }) + '\n');
    const again = await readTurnDiff({ filePath, cwd: repo, index: 1 });
    assert.notEqual(again, first);
    assert.deepEqual(again.files, first.files);
    // 範囲外の番号の失敗は覚えない
    await assert.rejects(readTurnDiff({ filePath, cwd: repo, index: 9 }));
    await assert.rejects(readTurnDiff({ filePath, cwd: repo, index: 9 }));
  });

  it('ターン 1: 開始内容から再生して 1 つの差分にし、失敗した編集は除く', async () => {
    const r = await readTurnDiff({ filePath, cwd: repo, index: 1 });
    assert.equal(r.root, repo);
    assert.equal(r.files.length, 1);
    const [f] = r.files;
    assert.equal(f.path, 'src/a.js');
    assert.equal(f.status, 'modified');
    assert.equal(f.perEdit, undefined);
    assert.equal(f.additions, 1);
    assert.equal(f.deletions, 1);
    assert.match(f.patch, /-two\n\+TWO\n/);
    assert.equal(r.turn.index, 1);
    assert.equal(r.turn.prompt, '最初の指示');
    assert.equal(r.cwdPrefix, '');
  });

  it('ターン 3: 再生できないファイルは編集ごとの差分、サブエージェントの編集も時刻で載る', async () => {
    const r = await readTurnDiff({ filePath, cwd: repo, index: 3 });
    assert.equal(r.outside, 1);
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['.env', 'src/a.js', 'src/b.js']);
    assert.equal(byPath['src/a.js'].perEdit, true);
    assert.equal(byPath['src/a.js'].editCount, 2);
    assert.match(byPath['src/a.js'].patch, /編集 1\/2\n-three\n\+THREE\n@@ -3,1 \+3,1 @@ 編集 2\/2\n-THREE\n\+four/);
    assert.equal(byPath['src/b.js'].status, 'added');
    assert.match(byPath['src/b.js'].patch, /\+b2\n$/);
    assert.equal(byPath['.env'].sensitive, true);
    assert.equal(byPath['.env'].patch, '');
  });

  it('番号の範囲外・不正はエラー', async () => {
    await assert.rejects(readTurnDiff({ filePath, cwd: repo, index: 9 }), /ターンが見つかりません/);
    await assert.rejects(readTurnDiff({ filePath, cwd: repo, index: 0 }), /正しくありません/);
  });

  it('cwd が git 管理外でも JSONL から組み立てる', async () => {
    const r = await readTurnDiff({ filePath, cwd: join(base, 'gone'), index: 1 });
    assert.equal(r.files.length, 0);
    assert.equal(r.outside, 1);
  });

  it('一覧: 編集のあったターンだけを新しい順に、ファイル数は本体＋サブエージェント', async () => {
    const s = await listDiffSources({ filePath, cwd: repo });
    assert.deepEqual(
      s.turns.map((t) => [t.index, t.fileCount, t.prompt]),
      [
        [3, 4, '三つ目の指示'],
        [1, 1, '最初の指示'],
      ],
    );
    // このセッションのコミット（件名で git log と突き合わせる）が無ければリポジトリの直近
    assert.equal(s.recent, true);
    assert.equal(s.commits[0].subject, 'init');
    assert.equal(s.commits[0].turnIndex, null);
    // キャッシュ（同じ参照の Promise の結果）
    assert.equal(await listDiffSources({ filePath, cwd: repo }), s);
  });

  it('一覧: JSONL が変わらなくても HEAD が動けば取り直す（ターミナルでのコミット）', async () => {
    const before = await listDiffSources({ filePath, cwd: repo });
    await writeFile(join(repo, 'other.txt'), 'x\n');
    await git(repo, 'add', 'other.txt');
    await git(repo, 'commit', '-qm', 'terminal commit');
    const after = await listDiffSources({ filePath, cwd: repo });
    assert.notEqual(after, before);
    assert.equal(after.recent, true);
    assert.equal(after.commits[0].subject, 'terminal commit');
  });

  it('一覧: このセッションのコミットはターン番号付きで新しい順', async () => {
    await writeFile(join(repo, 'src/a.js'), 'one\nTWO\nthree\n');
    await git(repo, 'commit', '-qam', 'first change');
    const s = await listDiffSources({ filePath, cwd: repo });
    assert.equal(s.recent, false);
    assert.equal(s.commits.length, 1);
    assert.equal(s.commits[0].subject, 'first change');
    assert.equal(s.commits[0].turnIndex, 1);
    assert.match(s.commits[0].hash, /^[0-9a-f]{7,}$/);
  });

  it('一覧: cwd が無ければコミットは空', async () => {
    const s = await listDiffSources({ filePath, cwd: null });
    assert.deepEqual(s.commits, []);
    assert.equal(s.recent, false);
  });
});

describe('readCommitDiff', () => {
  let repo;
  let rootHash;
  let editHash;
  let mergeHash;
  let envHash;

  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cb-commit-')));
    await initRepo(repo);
    await writeFile(join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'root');
    rootHash = (await git(repo, 'rev-parse', '--short', 'HEAD')).stdout.trim();
    await writeFile(join(repo, 'a.txt'), 'A\n');
    await git(repo, 'commit', '-qam', 'edit a');
    editHash = (await git(repo, 'rev-parse', '--short', 'HEAD')).stdout.trim();
    await git(repo, 'checkout', '-qb', 'side');
    await writeFile(join(repo, 'b.txt'), 'b\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'add b');
    await git(repo, 'checkout', '-q', 'main');
    await git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    mergeHash = (await git(repo, 'rev-parse', '--short', 'HEAD')).stdout.trim();
    await writeFile(join(repo, '.env'), 'NAME=value\n');
    await writeFile(join(repo, 'ok.txt'), 'ok\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'add env');
    envHash = (await git(repo, 'rev-parse', '--short', 'HEAD')).stdout.trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('普通のコミット', async () => {
    const r = await readCommitDiff({ cwd: repo, hash: editHash });
    assert.equal(r.merge, false);
    assert.equal(r.cwdPrefix, '');
    assert.deepEqual(
      r.files.map((f) => [f.path, f.additions, f.deletions]),
      [['a.txt', 1, 1]],
    );
  });

  it('root コミットは全行追加', async () => {
    const r = await readCommitDiff({ cwd: repo, hash: rootHash });
    assert.equal(r.files[0].status, 'added');
  });

  it('資格情報の置き場（.env）は中身を出さない', async () => {
    const r = await readCommitDiff({ cwd: repo, hash: envHash });
    const env = r.files.find((f) => f.path === '.env');
    assert.equal(env.sensitive, true);
    assert.equal(env.patch, '');
    assert.equal(env.additions, 0);
    const ok = r.files.find((f) => f.path === 'ok.txt');
    assert.equal(ok.sensitive, undefined);
    assert.match(ok.patch, /\+ok/);
  });

  it('マージコミットは 1 つ目の親との差分', async () => {
    const r = await readCommitDiff({ cwd: repo, hash: mergeHash });
    assert.equal(r.merge, true);
    assert.deepEqual(
      r.files.map((f) => [f.path, f.status]),
      [['b.txt', 'added']],
    );
  });

  it('ハッシュの形が違う・存在しない・リポジトリでない', async () => {
    await assert.rejects(readCommitDiff({ cwd: repo, hash: 'HEAD' }), /正しくありません/);
    await assert.rejects(readCommitDiff({ cwd: repo, hash: '--all' }), /正しくありません/);
    await assert.rejects(readCommitDiff({ cwd: repo, hash: 'deadbeefdeadbeef' }), /読めませんでした/);
    await assert.rejects(readCommitDiff({ cwd: tmpdir(), hash: editHash }), /git リポジトリ/);
  });
});

describe('readTurnDiff: 元に戻した・バイナリ', () => {
  it('同じ内容に戻したファイルは unchanged、NUL を含むものは binary', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'cb-turn2-')));
    try {
      const repo = join(base, 'repo');
      await mkdir(repo, { recursive: true });
      await initRepo(repo);
      const filePath = join(base, 's.jsonl');
      const a = join(repo, 'a.txt');
      const bin = join(repo, 'b.bin');
      const update = (content, originalFile, ts) =>
        result({ type: 'update', filePath: a, content, originalFile, structuredPatch: [] }, ts);
      await writeFile(
        filePath,
        jsonl([
          prompt('戻す', '2026-01-01T00:00:00Z'),
          update('x\n', 'o\n', '2026-01-01T00:00:01Z'),
          update('o\n', 'x\n', '2026-01-01T00:00:02Z'),
          result(
            { type: 'create', filePath: bin, content: 'a\0b', originalFile: null, structuredPatch: [] },
            '2026-01-01T00:00:03Z',
          ),
        ]),
      );
      const r = await readTurnDiff({ filePath, cwd: repo, index: 1 });
      assert.deepEqual(
        r.files.map((f) => [f.path, f.status, f.binary]),
        [
          ['a.txt', 'unchanged', false],
          ['b.bin', 'added', true],
        ],
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
