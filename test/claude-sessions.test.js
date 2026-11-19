import { describe, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, mkdir, utimes, rm, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseHistoryLines,
  projectRootOf,
  listRecentDirs,
  readSessionEntrypoint,
  clearEntrypointCache,
  findClaudeSessions,
  SESSION_ID_QUERY_RE,
} from '../server/claude-sessions.js';

const DAY = 24 * 60 * 60 * 1000;
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// テストで作ったディレクトリだけを後始末する
const created = [];
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// projects ディレクトリに {projectDir, sessionId, content, mtime} のセッションを置く
async function makeProjects(entries) {
  const dir = await makeTmp('cb-sessions-');
  for (const e of entries) {
    await mkdir(join(dir, e.projectDir), { recursive: true });
    const file = join(dir, e.projectDir, e.fileName ?? `${e.sessionId}.jsonl`);
    await writeFile(file, e.content ?? '');
    if (e.mtime != null) await utimes(file, new Date(e.mtime), new Date(e.mtime));
  }
  return dir;
}

const TASK_TEXT =
  '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<summary>テスト完了</summary>\n</task-notification>';

describe('parseHistoryLines', () => {
  it('人の発言は timestamp、無ければ updatedAt、どちらも無ければ空文字を時刻にする', () => {
    const messages = parseHistoryLines(
      jsonl([
        { type: 'user', uuid: 'u1', timestamp: 'T1', updatedAt: 'U1', message: { content: 'a' } },
        { type: 'user', uuid: 'u2', updatedAt: 'U2', message: { content: 'b' } },
        { type: 'user', uuid: 'u3', message: { content: 'c' } },
      ]),
    );
    assert.deepEqual(messages, [
      { role: 'human', content: 'a', uuid: 'u1', timestamp: 'T1' },
      { role: 'human', content: 'b', uuid: 'u2', timestamp: 'U2' },
      { role: 'human', content: 'c', uuid: 'u3', timestamp: '' },
    ]);
  });

  it('Artifact の公開・ツール結果の印・WebFetch の結果も時刻を同じ順で決める', () => {
    const url = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001';
    const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
    const messages = parseHistoryLines(
      jsonl([
        {
          type: 'user',
          uuid: 'p1',
          message: toolResult('toolu_1'),
          toolUseResult: { url, path: '/r.html', title: 'R' },
        },
        {
          type: 'user',
          uuid: 'p2',
          updatedAt: 'U2',
          message: toolResult('toolu_2'),
          toolUseResult: { url, path: '/r.html', title: 'R' },
        },
        {
          type: 'user',
          uuid: 'f1',
          message: toolResult('toolu_3'),
          toolUseResult: { url: 'https://example.com/', code: 200, result: '# Example\n本文' },
        },
      ]),
    );
    assert.deepEqual(messages, [
      { role: 'artifact', content: 'R', url, title: 'R', path: '/r.html', uuid: 'p1', timestamp: '' },
      { role: 'toolresult', content: '', results: [{ id: 'toolu_1' }], uuid: 'p1', timestamp: '' },
      { role: 'artifact', content: 'R', url, title: 'R', path: '/r.html', uuid: 'p2', timestamp: 'U2' },
      { role: 'toolresult', content: '', results: [{ id: 'toolu_2' }], uuid: 'p2', timestamp: 'U2' },
      { role: 'toolresult', content: '', results: [{ id: 'toolu_3' }], uuid: 'f1', timestamp: '' },
      {
        role: 'webfetch',
        content: 'Example',
        url: 'https://example.com/',
        title: 'Example',
        code: 200,
        uuid: 'f1',
        timestamp: '',
      },
    ]);
  });

  it('assistant の thinking・本文・ツール呼び出しを分けて出し、何も無い応答は出さない', () => {
    const messages = parseHistoryLines(
      jsonl([
        {
          type: 'assistant',
          uuid: 'k1',
          timestamp: 'T1',
          message: { content: [{ type: 'thinking', thinking: '考え1' }] },
        },
        {
          type: 'assistant',
          uuid: 'k2',
          updatedAt: 'U2',
          message: { content: [{ type: 'thinking', thinking: '考え2' }] },
        },
        { type: 'assistant', uuid: 'k3', message: { content: [{ type: 'thinking', thinking: '考え3' }] } },
        { type: 'assistant', uuid: 'e1', message: { content: [] } },
        { type: 'assistant', uuid: 'a1', timestamp: 'T4', message: { content: [{ type: 'text', text: '本文だけ' }] } },
        {
          type: 'assistant',
          uuid: 'a2',
          updatedAt: 'U5',
          message: {
            model: 'claude-sonnet-4',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
          },
        },
        { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: '時刻なし' }] } },
      ]),
    );
    assert.deepEqual(messages, [
      { role: 'thinking', content: '考え1', uuid: 'k1', timestamp: 'T1' },
      { role: 'thinking', content: '考え2', uuid: 'k2', timestamp: 'U2' },
      { role: 'thinking', content: '考え3', uuid: 'k3', timestamp: '' },
      {
        role: 'assistant',
        content: '本文だけ',
        toolUses: undefined,
        contextUsage: undefined,
        uuid: 'a1',
        timestamp: 'T4',
      },
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 't1', name: 'Read', input: { file_path: '/x' }, summary: '/x' }],
        contextUsage: {
          inputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          contextTokens: 10,
          contextWindow: 200000,
          model: 'claude-sonnet-4',
        },
        uuid: 'a2',
        timestamp: 'U5',
      },
      {
        role: 'assistant',
        content: '時刻なし',
        toolUses: undefined,
        contextUsage: undefined,
        uuid: 'a3',
        timestamp: '',
      },
    ]);
  });

  it('フックの失敗だけを attachment から拾う', () => {
    const messages = parseHistoryLines(
      jsonl([
        {
          type: 'attachment',
          uuid: 'h1',
          timestamp: 'T1',
          attachment: { type: 'hook_non_blocking_error', hookName: 'Stop', stderr: 'boom' },
        },
        { type: 'attachment', uuid: 'h2', attachment: { type: 'file', path: '/x' } },
      ]),
    );
    assert.deepEqual(messages, [
      {
        uuid: 'h1',
        timestamp: 'T1',
        role: 'hookerror',
        content: 'boom',
        hook: { name: 'Stop', exitCode: null, command: '', detail: 'boom' },
      },
    ]);
  });

  it('queue-operation は本文のある enqueue だけを人の発言にする', () => {
    const messages = parseHistoryLines(
      jsonl([
        { type: 'queue-operation', operation: 'enqueue', uuid: 'q1', timestamp: 'T1', content: '積んだ指示' },
        { type: 'queue-operation', operation: 'enqueue', uuid: 'q2', updatedAt: 'U2', content: '時刻なし' },
        { type: 'queue-operation', operation: 'remove', uuid: 'q3', content: '取り消し' },
        { type: 'queue-operation', operation: 'enqueue', uuid: 'q4', content: '' },
        { type: 'system', operation: 'enqueue', uuid: 'q5', content: '別の種類' },
        { type: 'system', uuid: 's1', message: { content: [{ type: 'text', text: 'system の本文' }] } },
      ]),
    );
    assert.deepEqual(messages, [
      { role: 'human', content: '積んだ指示', uuid: 'q1', timestamp: 'T1' },
      // queue-operation は updatedAt を見ない
      { role: 'human', content: '時刻なし', uuid: 'q2', timestamp: '' },
    ]);
  });

  it('enqueue されたタスク通知を 1 件だけ出し、後から来る同じ本文の user レコードは捨てる', () => {
    const messages = parseHistoryLines(
      jsonl([
        { type: 'queue-operation', operation: 'enqueue', uuid: 'q1', timestamp: 'T1', content: TASK_TEXT },
        { type: 'user', uuid: 'u1', timestamp: 'T2', message: { content: TASK_TEXT } },
        { type: 'user', uuid: 'u2', timestamp: 'T3', message: { content: '次の指示' } },
      ]),
    );
    assert.deepEqual(
      messages.map((m) => [m.role, m.content, m.uuid]),
      [
        ['task', 'テスト完了', 'q1'],
        ['human', '次の指示', 'u2'],
      ],
    );
  });

  it('enqueue されていないタスク通知の user レコードはタスク通知として出す', () => {
    const messages = parseHistoryLines(
      jsonl([{ type: 'user', uuid: 'u1', timestamp: 'T1', message: { content: TASK_TEXT } }]),
    );
    assert.deepEqual(
      messages.map((m) => [m.role, m.content, m.uuid, m.timestamp]),
      [['task', 'テスト完了', 'u1', 'T1']],
    );
  });

  it('空行と壊れた行は飛ばして続きを読む', () => {
    const messages = parseHistoryLines(
      ['', '   ', '{broken', JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'a' } })].join('\n'),
    );
    assert.deepEqual(
      messages.map((m) => m.content),
      ['a'],
    );
  });
});

describe('projectRootOf', () => {
  it('文字列でない cwd は候補にしない', () => {
    assert.equal(projectRootOf(123), null);
    assert.equal(projectRootOf(null), null);
  });

  it('/tmp/claude-<uid> 直下のスクラッチパッドだけを除き、似た名前のパスは残す', () => {
    assert.equal(projectRootOf('/tmp/claude-1000'), null);
    assert.equal(projectRootOf('/tmp/claude-1000/x'), null);
    assert.equal(projectRootOf('/tmp/claude-1000x'), '/tmp/claude-1000x');
    assert.equal(projectRootOf('/home/me/tmp/claude-1000/x'), '/home/me/tmp/claude-1000/x');
  });

  it('ルート直下の .claude/worktrees は畳まない', () => {
    assert.equal(projectRootOf('/.claude/worktrees/x'), '/.claude/worktrees/x');
  });
});

describe('listRecentDirs', () => {
  const NOW = Date.UTC(2026, 0, 31, 0, 0, 0);
  const userAt = (cwd) => ({ type: 'user', cwd, message: { content: 'hi' } });

  it('期間の境界ちょうどに更新されたセッションも含め、それより古いものは含めない', async () => {
    const a = await makeTmp('cb-dir-a');
    const b = await makeTmp('cb-dir-b');
    const dir = await makeProjects([
      { projectDir: 'p', sessionId: 'edge', content: jsonl([userAt(a)]), mtime: NOW - DAY },
      { projectDir: 'p', sessionId: 'old', content: jsonl([userAt(b)]), mtime: NOW - DAY - 1000 },
    ]);
    const result = await listRecentDirs({ days: 1, dir, now: NOW });
    assert.deepEqual(
      result.map((e) => e.cwd),
      [a],
    );
  });

  it('limit で件数を切る', async () => {
    const a = await makeTmp('cb-dir-a');
    const b = await makeTmp('cb-dir-b');
    const dir = await makeProjects([
      { projectDir: 'p', sessionId: 's1', content: jsonl([userAt(a)]), mtime: NOW - 1000 },
      { projectDir: 'p', sessionId: 's2', content: jsonl([userAt(b)]), mtime: NOW - 2000 },
    ]);
    const result = await listRecentDirs({ dir, now: NOW, limit: 1 });
    assert.deepEqual(
      result.map((e) => e.cwd),
      [a],
    );
  });

  it('worktree に入ったセッションは worktree-state の元の cwd を、最初に書かれたものを使う', async () => {
    const orig = await makeTmp('cb-dir-orig');
    const second = await makeTmp('cb-dir-second');
    const moved = await makeTmp('cb-dir-moved');
    const dir = await makeProjects([
      {
        projectDir: 'p',
        sessionId: 's1',
        mtime: NOW - 1000,
        content: jsonl([
          // worktreeSession 以外に originalCwd を持つレコードは手がかりにしない
          { type: 'user', cwd: moved, meta: { originalCwd: '/nowhere' }, message: { content: 'hi' } },
          { type: 'worktree-state', worktreeSession: { originalCwd: orig } },
          { type: 'worktree-state', worktreeSession: { originalCwd: second } },
        ]),
      },
    ]);
    const result = await listRecentDirs({ dir, now: NOW });
    assert.deepEqual(result, [{ cwd: orig, lastUsedAt: new Date(NOW - 1000).toISOString(), count: 1 }]);
  });

  it('originalCwd が文字列でなければ JSONL の cwd を使う', async () => {
    const a = await makeTmp('cb-dir-a');
    const dir = await makeProjects([
      {
        projectDir: 'p',
        sessionId: 's1',
        mtime: NOW - 1000,
        content: jsonl([userAt(a), { type: 'worktree-state', worktreeSession: { originalCwd: 123 } }]),
      },
    ]);
    const result = await listRecentDirs({ dir, now: NOW });
    assert.deepEqual(
      result.map((e) => e.cwd),
      [a],
    );
  });

  it('開始時の cwd は一度読んだら覚えておき、ファイルが書き換わっても変えない', async () => {
    const a = await makeTmp('cb-dir-a');
    const b = await makeTmp('cb-dir-b');
    const dir = await makeProjects([
      { projectDir: 'p', sessionId: 's1', content: jsonl([userAt(a)]), mtime: NOW - 1000 },
    ]);
    const file = join(dir, 'p', 's1.jsonl');
    assert.deepEqual(
      (await listRecentDirs({ dir, now: NOW })).map((e) => e.cwd),
      [a],
    );
    await writeFile(file, jsonl([userAt(b)]));
    await utimes(file, new Date(NOW - 1000), new Date(NOW - 1000));
    assert.deepEqual(
      (await listRecentDirs({ dir, now: NOW })).map((e) => e.cwd),
      [a],
    );
  });

  it('cwd が読めなかったセッションは覚えず、後から書かれた cwd を使う', async () => {
    const a = await makeTmp('cb-dir-a');
    const dir = await makeProjects([
      { projectDir: 'p', sessionId: 's1', content: jsonl([{ type: 'mode' }]), mtime: NOW - 1000 },
    ]);
    const file = join(dir, 'p', 's1.jsonl');
    // projectDir 名 'p' からの復元は相対パスなので候補にならない
    assert.deepEqual(await listRecentDirs({ dir, now: NOW }), []);
    await appendFile(file, jsonl([userAt(a)]));
    await utimes(file, new Date(NOW - 1000), new Date(NOW - 1000));
    assert.deepEqual(
      (await listRecentDirs({ dir, now: NOW })).map((e) => e.cwd),
      [a],
    );
  });
});

describe('readSessionEntrypoint', () => {
  it('見つかった entrypoint を覚えておき、clearEntrypointCache で読み直す', async () => {
    const dir = await makeTmp('cb-entry-');
    const file = join(dir, 's.jsonl');
    await writeFile(file, jsonl([{ type: 'user', entrypoint: 'sdk-cli' }]));
    assert.equal(await readSessionEntrypoint(file), 'sdk-cli');
    await writeFile(file, jsonl([{ type: 'user', entrypoint: 'cli' }]));
    assert.equal(await readSessionEntrypoint(file), 'sdk-cli');
    clearEntrypointCache();
    assert.equal(await readSessionEntrypoint(file), 'cli');
  });

  it('読めないパスなら null を返す', async () => {
    assert.equal(await readSessionEntrypoint(undefined), null);
  });

  it('文字列でない entrypoint は飛ばして次の行を見る', async () => {
    const dir = await makeTmp('cb-entry-');
    const file = join(dir, 's.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'x', entrypoint: null },
        { type: 'user', entrypoint: 'sdk-cli' },
      ]),
    );
    assert.equal(await readSessionEntrypoint(file), 'sdk-cli');
  });
});

describe('findClaudeSessions', () => {
  it('ID に使える文字だけの 4〜64 文字を受け付ける', () => {
    assert.equal(SESSION_ID_QUERY_RE.test('abcd'), true);
    assert.equal(SESSION_ID_QUERY_RE.test('../abcd'), false);
    assert.equal(SESSION_ID_QUERY_RE.test('abcd/..'), false);
    assert.equal(SESSION_ID_QUERY_RE.test('a'.repeat(65)), false);
  });

  it('projects ディレクトリが無ければ空を返す', async () => {
    assert.deepEqual(await findClaudeSessions('abcd', { dir: join(tmpdir(), 'cb-find-does-not-exist') }), []);
  });

  it('前後の空白を除いて探し、.jsonl 以外のファイルは対象にしない', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-x', sessionId: 'abcd1111' },
      { projectDir: '-home-me-x', fileName: 'abcd2222.txt' },
    ]);
    const result = await findClaudeSessions('  abcd  ', { dir });
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['abcd1111'],
    );
  });

  it('limit 件までしか返さない', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-x', sessionId: 'abcd1111' },
      { projectDir: '-home-me-x', sessionId: 'abcd2222' },
      { projectDir: '-home-me-x', sessionId: 'abcd3333' },
    ]);
    assert.equal((await findClaudeSessions('abcd', { dir, limit: 2 })).length, 2);
  });

  // root は 0o000 のディレクトリも読めるので確かめられない
  it.skipIf(process.getuid?.() === 0)('読めないプロジェクトディレクトリは飛ばして他を探す', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-locked', sessionId: 'abcd1111' },
      { projectDir: '-home-me-open', sessionId: 'abcd2222' },
    ]);
    await chmod(join(dir, '-home-me-locked'), 0o000);
    try {
      const result = await findClaudeSessions('abcd', { dir });
      assert.deepEqual(
        result.map((s) => s.sessionId),
        ['abcd2222'],
      );
    } finally {
      await chmod(join(dir, '-home-me-locked'), 0o700);
    }
  });

  it('冒頭の依頼はタグ注入を飛ばした最初の人の指示にする', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-x',
        sessionId: 'abcd1111',
        content: jsonl([
          { type: 'user', message: { content: '<local-command-caveat>注入</local-command-caveat>' } },
          { type: 'user', message: { content: '本当の依頼' } },
        ]),
      },
    ]);
    const [hit] = await findClaudeSessions('abcd1111', { dir });
    assert.equal(hit.firstUserMessage, '本当の依頼');
  });

  it('人の指示が無ければ最初の user レコードの本文、それも無ければ空文字にする', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-x',
        sessionId: 'abcd1111',
        content: jsonl([
          { type: 'mode' },
          { type: 'user', message: { content: '<local-command-caveat>注入</local-command-caveat>' } },
        ]),
      },
      { projectDir: '-home-me-x', sessionId: 'abcd2222', content: jsonl([{ type: 'mode' }]) },
    ]);
    const hits = await findClaudeSessions('abcd', { dir });
    const byId = Object.fromEntries(hits.map((h) => [h.sessionId, h.firstUserMessage]));
    assert.deepEqual(byId, {
      abcd1111: '<local-command-caveat>注入</local-command-caveat>',
      abcd2222: '',
    });
  });
});

// CLAUDE_PROJECTS_DIR は import 時に決まるので、環境変数を tmpdir に向けてから読み込み直す
describe('CLAUDE_PROJECTS_DIR 配下を読む関数', () => {
  let projectsDir;
  let mod;
  const saved = process.env.CLAUDE_BRIDGE_PROJECTS_DIR;

  beforeAll(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'cb-projects-'));
    process.env.CLAUDE_BRIDGE_PROJECTS_DIR = projectsDir;
    vi.resetModules();
    mod = await import('../server/claude-sessions.js');
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.CLAUDE_BRIDGE_PROJECTS_DIR;
    else process.env.CLAUDE_BRIDGE_PROJECTS_DIR = saved;
    vi.resetModules();
    await rm(projectsDir, { recursive: true, force: true });
  });

  it('listClaudeSessions は新しい順に limit 件まで、冒頭の依頼付きで返す', async () => {
    await mkdir(join(projectsDir, '-home-me-a'), { recursive: true });
    const write = async (id, content, mtime) => {
      const file = join(projectsDir, '-home-me-a', `${id}.jsonl`);
      await writeFile(file, content);
      await utimes(file, new Date(mtime), new Date(mtime));
    };
    await write('s-old', jsonl([{ type: 'user', message: { content: '古い依頼' } }]), Date.now() - 3 * DAY);
    await write(
      's-new',
      jsonl([{ type: 'mode' }, { type: 'user', message: { content: '新しい依頼' } }]),
      Date.now() - DAY,
    );
    await write('s-mid', jsonl([{ type: 'mode' }]), Date.now() - 2 * DAY);

    const sessions = await mod.listClaudeSessions({ limit: 2 });
    assert.deepEqual(
      sessions.map(({ sessionId, projectDir, cwd, firstUserMessage }) => ({
        sessionId,
        projectDir,
        cwd,
        firstUserMessage,
      })),
      [
        { sessionId: 's-new', projectDir: '-home-me-a', cwd: '/home/me/a', firstUserMessage: '新しい依頼' },
        { sessionId: 's-mid', projectDir: '-home-me-a', cwd: '/home/me/a', firstUserMessage: '' },
      ],
    );
    assert.equal(typeof sessions[0].size, 'number');
    assert.equal(sessions[0].updatedAt, new Date(sessions[0].updatedAt).toISOString());
  });

  it('loadSessionHistory はセッション ID のファイルを読み、無ければ空を返す', async () => {
    await mkdir(join(projectsDir, '-home-me-b'), { recursive: true });
    await writeFile(
      join(projectsDir, '-home-me-b', 'hist.jsonl'),
      jsonl([{ type: 'user', uuid: 'u1', message: { content: 'こんにちは' } }]),
    );
    assert.deepEqual(await mod.loadSessionHistory('hist', '-home-me-b'), [
      { role: 'human', content: 'こんにちは', uuid: 'u1', timestamp: '' },
    ]);
    assert.deepEqual(await mod.loadSessionHistory('nothing', '-home-me-b'), []);
  });
});
