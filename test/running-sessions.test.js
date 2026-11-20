import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ps はモックする（本物のプロセス一覧は読まない）。git / gh（やり残し判定）も呼ばれたら失敗させる
const execCalls = [];
let psResult = { err: null, stdout: '' };
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => (typeof opts === 'function' ? opts : cb)(new Error(`not allowed: ${cmd}`)),
  exec: (cmd, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    execCalls.push(cmd);
    // ps 以外（やり残し判定の git）は失敗させる
    if (!cmd.startsWith('ps ')) done(new Error(`not allowed: ${cmd}`));
    else if (psResult.err) done(psResult.err);
    else done(null, { stdout: psResult.stdout, stderr: '' });
  },
}));

const {
  parsePaneId,
  normalizeRunningSession,
  listRunningSessions,
  mapPaneIdsToPids,
  findLiveSessionsByPaneIds,
  readLivePids,
} = await import('../server/running-sessions.js');

describe('parsePaneId', () => {
  it('extracts the pane id from a tmux field', () => {
    assert.equal(parsePaneId('0:@5.%7'), '%7');
    assert.equal(parsePaneId('work:@12.%103'), '%103');
  });

  it('returns null for missing or malformed values', () => {
    assert.equal(parsePaneId(undefined), null);
    assert.equal(parsePaneId(null), null);
    assert.equal(parsePaneId(''), null);
    assert.equal(parsePaneId('0:@5.pane'), null);
    assert.equal(parsePaneId(123), null);
  });

  it('does not extract shell metacharacters', () => {
    // シェルに渡る値なので %<数字> 以外は必ず捨てる
    assert.equal(parsePaneId('0:@5.%7; rm -rf /'), null);
  });
});

describe('normalizeRunningSession', () => {
  const meta = {
    pid: 19425,
    sessionId: 'd41561d4-9e6a-454b-b406-3e7a739f1caa',
    cwd: '/Users/x/gh/claude-bridge',
    name: 'claude-bridge-76',
    status: 'busy',
    kind: 'interactive',
    version: '2.1.231',
    tmux: '0:@5.%7',
    startedAt: 1000,
    updatedAt: 2000,
  };

  it('keeps the fields the home view needs', () => {
    assert.deepEqual(normalizeRunningSession(meta), {
      pid: 19425,
      sessionId: 'd41561d4-9e6a-454b-b406-3e7a739f1caa',
      cwd: '/Users/x/gh/claude-bridge',
      name: 'claude-bridge-76',
      status: 'busy',
      waitingFor: null,
      kind: 'interactive',
      version: '2.1.231',
      tmuxTarget: '0:@5.%7',
      paneId: '%7',
      startedAt: 1000,
      updatedAt: 2000,
    });
  });

  it('keeps waitingFor so the home view can tell a session is waiting for an answer', () => {
    assert.equal(normalizeRunningSession({ ...meta, waitingFor: 'permission prompt' }).waitingFor, 'permission prompt');
  });

  it('falls back to statusUpdatedAt then startedAt for updatedAt', () => {
    assert.equal(
      normalizeRunningSession({
        ...meta,
        updatedAt: undefined,
        statusUpdatedAt: 1500,
      }).updatedAt,
      1500,
    );
    // どちらも無ければ起動時刻
    assert.equal(normalizeRunningSession({ ...meta, updatedAt: undefined }).updatedAt, 1000);
    assert.equal(normalizeRunningSession({ pid: 1, sessionId: 'a' }).updatedAt, null);
  });

  it('returns null when the session cannot be identified', () => {
    assert.equal(normalizeRunningSession(null), null);
    assert.equal(normalizeRunningSession({ sessionId: 'abc' }), null);
    assert.equal(normalizeRunningSession({ pid: 1 }), null);
    assert.equal(normalizeRunningSession({ pid: 'x', sessionId: 'abc' }), null);
  });

  it('tolerates a session without tmux info', () => {
    const r = normalizeRunningSession({ pid: 1, sessionId: 'a' });
    assert.equal(r.tmuxTarget, null);
    assert.equal(r.paneId, null);
    assert.equal(r.name, null);
  });
});

describe('listRunningSessions', () => {
  async function makeDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  it('returns only sessions whose process is alive, newest first', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', updatedAt: 100 }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 300 }),
      '3.json': JSON.stringify({ pid: 3, sessionId: 'c', updatedAt: 200 }),
    });
    const result = await listRunningSessions({
      dir,
      livePids: new Set([1, 2]),
    });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['b', 'a'],
    );
  });

  it('skips broken json and non-json files', async () => {
    const dir = await makeDir({
      '1.json': '{ this is not json',
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 1 }),
      '3.key': 'secret',
    });
    const result = await listRunningSessions({ dir, livePids: new Set([1, 2]) });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['b'],
    );
  });

  it('keeps every session when liveness cannot be determined', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', updatedAt: 1 }),
    });
    const result = await listRunningSessions({ dir, livePids: null });
    assert.equal(result.length, 1);
  });

  it('adds the projectDir (for the session detail panel) and the completion state', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', cwd: '/Users/x/gh/claude-bridge', updatedAt: 1 }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 2 }),
    });
    const projectsDir = await mkdtemp(join(tmpdir(), 'cb-projects-'));
    const result = await listRunningSessions({ dir, livePids: new Set([1, 2]), projectsDir });
    const byId = Object.fromEntries(result.map((r) => [r.sessionId, r]));
    assert.equal(byId.a.projectDir, '-Users-x-gh-claude-bridge');
    // JSONL がまだ無くても判定は「編集なし」で返る
    assert.equal(byId.a.completion.git, 'none');
    // cwd が無ければ JSONL を指せないので付けない
    assert.equal(byId.b.projectDir, null);
    assert.equal(byId.b.completion, null);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listRunningSessions({
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: new Set(),
    });
    assert.deepEqual(result, []);
  });
});

describe('mapPaneIdsToPids', () => {
  async function makeDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  it('resolves a pid from a matching, alive paneId', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([1]) });
    assert.deepEqual(Array.from(result.entries()), [['%5', 1]]);
  });

  it('ignores candidates whose pid is not alive', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([]) });
    assert.equal(result.size, 0);
  });

  it('picks the candidate with the newest updatedAt when a paneId is reused', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({
        pid: 1,
        sessionId: 'old',
        tmux: '0:@1.%5',
        updatedAt: 100,
      }),
      '2.json': JSON.stringify({
        pid: 2,
        sessionId: 'new',
        tmux: '0:@1.%5',
        updatedAt: 200,
      }),
    });
    const result = await mapPaneIdsToPids(['%5'], {
      dir,
      livePids: new Set([1, 2]),
    });
    assert.equal(result.get('%5'), 2);
  });

  it('returns an empty map without reading the directory when paneIds is empty', async () => {
    const result = await mapPaneIdsToPids([], {
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: new Set(),
    });
    assert.equal(result.size, 0);
  });

  it('ignores broken json files', async () => {
    const dir = await makeDir({
      '1.json': '{ this is not json',
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', tmux: '0:@1.%5' }),
    });
    const result = await mapPaneIdsToPids(['%5'], { dir, livePids: new Set([2]) });
    assert.equal(result.get('%5'), 2);
  });
});

describe('findLiveSessionsByPaneIds', () => {
  it('returns the newest live session meta (with sessionId) per paneId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    await writeFile(
      join(dir, '1.json'),
      JSON.stringify({ pid: 1, sessionId: 'dead', tmux: '0:@1.%5', updatedAt: 300 }),
    );
    await writeFile(
      join(dir, '2.json'),
      JSON.stringify({ pid: 2, sessionId: 'live', tmux: '0:@1.%5', updatedAt: 100 }),
    );
    await writeFile(join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'other', tmux: '0:@1.%6' }));

    const result = await findLiveSessionsByPaneIds(['%5'], { dir, livePids: new Set([2, 3]) });

    assert.deepEqual(Array.from(result.keys()), ['%5']);
    assert.equal(result.get('%5').sessionId, 'live');
    assert.equal(result.get('%5').pid, 2);
  });

  it('returns an empty map when the directory is missing', async () => {
    const result = await findLiveSessionsByPaneIds(['%5'], {
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: new Set([1]),
    });
    assert.equal(result.size, 0);
  });
});

describe('readLivePids', () => {
  beforeEach(() => {
    execCalls.length = 0;
    psResult = { err: null, stdout: '' };
  });

  it('ps の pid 列を数値の集合にする（数値でない行は捨てる）', async () => {
    psResult.stdout = '    1\n  234\n  PID\n 5.5\n';
    const pids = await readLivePids();
    assert.equal(execCalls[0], 'ps -eo pid=');
    assert.deepEqual(
      [...pids].sort((a, b) => a - b),
      [1, 234],
    );
  });

  it('ps が使えなければ null（生存判定なし）', async () => {
    psResult = { err: new Error('ps: not found'), stdout: '' };
    assert.equal(await readLivePids(), null);
  });
});

describe('生存判定を省略したとき', () => {
  const created = [];
  const makeDir = async (files) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    created.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  };

  beforeEach(() => {
    execCalls.length = 0;
    psResult = { err: null, stdout: '' };
  });
  afterEach(async () => {
    while (created.length) await rm(created.pop(), { recursive: true, force: true });
  });

  it('listRunningSessions は ps で生きている pid に絞る', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', updatedAt: 1 }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'b', updatedAt: 2 }),
    });
    const projectsDir = await makeDir({});
    psResult.stdout = '  2\n';
    const result = await listRunningSessions({ dir, projectsDir });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['b'],
    );
  });

  it('findLiveSessionsByPaneIds は ps で生きている pid に絞り、ps が使えなければ全部を候補にする', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'dead', tmux: '0:@1.%5', updatedAt: 300 }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'live', tmux: '0:@1.%5', updatedAt: 100 }),
    });
    psResult.stdout = '2\n';
    assert.equal((await findLiveSessionsByPaneIds(['%5'], { dir })).get('%5').sessionId, 'live');

    psResult = { err: new Error('ps: not found'), stdout: '' };
    assert.equal((await findLiveSessionsByPaneIds(['%5'], { dir })).get('%5').sessionId, 'dead');
  });

  it('paneIds が空なら ps も呼ばない', async () => {
    const result = await mapPaneIdsToPids([]);
    assert.equal(result.size, 0);
    assert.equal(execCalls.length, 0);
  });

  it('findLiveSessionsByPaneIds は livePids: null を渡すと生存判定をしない', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'a', tmux: '0:@1.%5' }),
    });
    const result = await findLiveSessionsByPaneIds(['%5'], { dir, livePids: null });
    assert.equal(result.get('%5').sessionId, 'a');
    assert.equal(execCalls.length, 0);
  });
});

describe('findLiveSessionsByPaneIds: 候補の選び方', () => {
  const created = [];
  const makeDir = async (files) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    created.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  };
  afterEach(async () => {
    while (created.length) await rm(created.pop(), { recursive: true, force: true });
  });

  it('updatedAt の無い候補より、ある候補を採る（どちらの順で読んでも）', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'no-time', tmux: '0:@1.%5' }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'timed', tmux: '0:@1.%5', updatedAt: 5 }),
      '3.json': JSON.stringify({ pid: 3, sessionId: 'timed2', tmux: '0:@1.%6', updatedAt: 5 }),
      '4.json': JSON.stringify({ pid: 4, sessionId: 'no-time2', tmux: '0:@1.%6' }),
    });
    const result = await findLiveSessionsByPaneIds(['%5', '%6'], { dir, livePids: new Set([1, 2, 3, 4]) });
    assert.equal(result.get('%5').sessionId, 'timed');
    assert.equal(result.get('%6').sessionId, 'timed2');
  });

  it('tmux 情報の無いセッション・対象外のペインは含めない', async () => {
    const dir = await makeDir({
      '1.json': JSON.stringify({ pid: 1, sessionId: 'no-tmux' }),
      '2.json': JSON.stringify({ pid: 2, sessionId: 'other', tmux: '0:@1.%9' }),
    });
    const result = await findLiveSessionsByPaneIds(['%5'], { dir, livePids: new Set([1, 2]) });
    assert.equal(result.size, 0);
  });
});

describe('normalizeRunningSession: 既定値', () => {
  it('無い項目は空文字か null にする', () => {
    assert.deepEqual(normalizeRunningSession({ pid: '7', sessionId: 's', tmux: 42 }), {
      pid: 7,
      sessionId: 's',
      cwd: '',
      name: null,
      status: null,
      waitingFor: null,
      kind: null,
      version: null,
      tmuxTarget: null,
      paneId: null,
      startedAt: null,
      updatedAt: null,
    });
  });

  it('オブジェクトでなければ null', () => {
    assert.equal(normalizeRunningSession('x'), null);
    assert.equal(normalizeRunningSession(1.5), null);
    assert.equal(normalizeRunningSession({ pid: 1.5, sessionId: 's' }), null);
  });
});

describe('listRunningSessions: カードの中身', () => {
  const created = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sessions-'));
    created.push(dir);
    return dir;
  };
  afterEach(async () => {
    while (created.length) await rm(created.pop(), { recursive: true, force: true });
  });

  it('JSONL のタイトルを添え、cwd はセッションメタの値を保つ', async () => {
    const dir = await makeDir();
    const projectsDir = await makeDir();
    const cwd = '/home/u/my.repo';
    await writeFile(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'sid-a', cwd, updatedAt: 1 }));
    const projectDir = '-home-u-my-repo';
    await mkdir(join(projectsDir, projectDir));
    await writeFile(
      join(projectsDir, projectDir, 'sid-a.jsonl'),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'テストのタイトル' }),
        JSON.stringify({ type: 'user', cwd: '/elsewhere', message: { role: 'user', content: 'やって' } }),
      ].join('\n') + '\n',
    );

    const [r] = await listRunningSessions({ dir, livePids: new Set([1]), projectsDir });

    assert.equal(r.title, 'テストのタイトル');
    assert.equal(r.cwd, cwd);
    assert.equal(r.projectDir, projectDir);
    assert.equal(r.pid, 1);
  });

  it('やり残し判定はそのセッションの JSONL（<sessionId>.jsonl）を見る', async () => {
    const dir = await makeDir();
    const projectsDir = await makeDir();
    const cwd = '/home/u/edited';
    await writeFile(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'sid-e', cwd, updatedAt: 1 }));
    await mkdir(join(projectsDir, '-home-u-edited'));
    await writeFile(
      join(projectsDir, '-home-u-edited', 'sid-e.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/u/edited/a.js' } }] },
      }) + '\n',
    );

    const [r] = await listRunningSessions({ dir, livePids: new Set([1]), projectsDir });

    assert.equal(r.completion.edited, 1);
    // git は使えない（モックで失敗させている）ので確認できず
    assert.equal(r.completion.git, 'unknown');
  });

  it('生存判定ができずディレクトリも無ければ空', async () => {
    const result = await listRunningSessions({
      dir: join(tmpdir(), 'cb-sessions-does-not-exist'),
      livePids: null,
    });
    assert.deepEqual(result, []);
  });

  it('.json 以外のファイルは中身が正しくても読まない', async () => {
    const dir = await makeDir();
    const projectsDir = await makeDir();
    await writeFile(join(dir, '1.txt'), JSON.stringify({ pid: 1, sessionId: 'txt', updatedAt: 1 }));
    await writeFile(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'json', updatedAt: 1 }));
    const result = await listRunningSessions({ dir, livePids: null, projectsDir });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['json'],
    );
  });

  it('updatedAt の新しい順に並べる（無いものは 0 扱い）', async () => {
    const dir = await makeDir();
    const projectsDir = await makeDir();
    const metas = [
      { pid: 1, sessionId: 'mid', updatedAt: 50 },
      { pid: 2, sessionId: 'none' },
      { pid: 3, sessionId: 'new', updatedAt: 100 },
      { pid: 4, sessionId: 'old', updatedAt: 10 },
    ];
    for (const m of metas) await writeFile(join(dir, `${m.pid}.json`), JSON.stringify(m));
    const result = await listRunningSessions({ dir, livePids: null, projectsDir });
    assert.deepEqual(
      result.map((r) => r.sessionId),
      ['new', 'mid', 'old', 'none'],
    );
  });

  it('updatedAt の無いセッションは最後に並べる', async () => {
    const dir = await makeDir();
    const projectsDir = await makeDir();
    await writeFile(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'none' }));
    await writeFile(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'timed', updatedAt: 5 }));
    await writeFile(join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'none2' }));

    const result = await listRunningSessions({ dir, livePids: new Set([1, 2, 3]), projectsDir });

    assert.equal(result[0].sessionId, 'timed');
  });
});
