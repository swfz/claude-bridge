import { describe, it, beforeEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// SESSIONS_DIR / CLAUDE_PROJECTS_DIR は import 時に環境変数から決まるので、import より前に tmpdir へ向ける
const dirs = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const root = mkdtempSync(join(tmpdir(), 'cb-session-meta-'));
  const sessions = join(root, 'sessions');
  const projects = join(root, 'projects');
  process.env.CLAUDE_BRIDGE_SESSIONS_DIR = sessions;
  process.env.CLAUDE_BRIDGE_PROJECTS_DIR = projects;
  return { root, sessions, projects };
});

// ps はモックする（本物のプロセス一覧は読まない）
const execCalls = [];
let psResult = { err: null, stdout: '' };
vi.mock('child_process', () => ({
  exec: (cmd, cb) => {
    execCalls.push(cmd);
    if (psResult.err) cb(psResult.err);
    else cb(null, { stdout: psResult.stdout, stderr: '' });
  },
}));

const { findClaudePid, enrichPanesWithSessionMeta, readStatusByPid, SESSIONS_DIR } =
  await import('../server/claude-session-meta.js');

function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeMeta(pid, meta) {
  writeFileSync(join(dirs.sessions, `${pid}.json`), JSON.stringify({ pid, ...meta }));
}

function writeJsonl(cwd, sessionId, lines) {
  const dir = join(dirs.projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n'));
}

afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

describe('findClaudePid', () => {
  // tmux pane_pid (シェル) の子孫を辿って claude プロセスPID を探す。
  // childrenOf: ppid -> [pid...] / metaByPid: claude セッションを持つ pid の集合
  it('finds claude pid as a direct child of the shell', () => {
    const childrenOf = new Map([[100, [200]]]);
    const metaByPid = new Map([[200, { name: '規模感' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), 200);
  });

  it('finds claude pid deeper in the process tree', () => {
    const childrenOf = new Map([
      [100, [150]],
      [150, [300]],
    ]);
    const metaByPid = new Map([[300, { name: 'EOL' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), 300);
  });

  it('returns null when no descendant is a claude session', () => {
    const childrenOf = new Map([[100, [200, 201]]]);
    const metaByPid = new Map([[999, { name: '別ペイン' }]]);
    assert.equal(findClaudePid(100, childrenOf, metaByPid), null);
  });

  it('returns null for a leaf shell with no children', () => {
    assert.equal(findClaudePid(100, new Map(), new Map([[1, {}]])), null);
  });

  it('does not match the shell pid itself', () => {
    // シェルPID 自体が meta を持っていても、子孫だけを対象にする
    const metaByPid = new Map([[100, { name: 'shell' }]]);
    assert.equal(findClaudePid(100, new Map(), metaByPid), null);
  });

  it('terminates on cyclic process relationships', () => {
    // 循環があっても無限ループしない
    const childrenOf = new Map([
      [100, [200]],
      [200, [100]],
    ]);
    assert.equal(findClaudePid(100, childrenOf, new Map()), null);
  });
});

describe('SESSIONS_DIR', () => {
  it('CLAUDE_BRIDGE_SESSIONS_DIR で差し替えられる', () => {
    assert.equal(SESSIONS_DIR, dirs.sessions);
  });

  it('環境変数が無ければ ~/.claude/sessions を指す（パスを組み立てるだけで読まない）', async () => {
    const saved = process.env.CLAUDE_BRIDGE_SESSIONS_DIR;
    delete process.env.CLAUDE_BRIDGE_SESSIONS_DIR;
    try {
      vi.resetModules();
      const fresh = await import('../server/claude-session-meta.js');
      assert.equal(fresh.SESSIONS_DIR, join(homedir(), '.claude', 'sessions'));
    } finally {
      process.env.CLAUDE_BRIDGE_SESSIONS_DIR = saved;
      vi.resetModules();
    }
  });
});

describe('enrichPanesWithSessionMeta', () => {
  beforeEach(() => {
    resetDir(dirs.sessions);
    resetDir(dirs.projects);
    execCalls.length = 0;
    psResult = { err: null, stdout: '' };
  });

  const pane = (panePid, extra = {}) => ({ paneId: '%1', panePid: String(panePid), cwd: '/home/u/proj', ...extra });

  it('ペインが無ければ ps も読まずにそのまま返す', async () => {
    const panes = [];
    assert.equal(await enrichPanesWithSessionMeta(panes), panes);
    assert.equal(execCalls.length, 0);
  });

  it('シェルの子孫の claude からセッションメタを付ける', async () => {
    writeMeta(200, { sessionId: 'sid-1', name: '規模感', status: 'waiting', waitingFor: 'input needed', cwd: '/x' });
    psResult.stdout = ['  100     1', '  150   100', '  200   150', ''].join('\n');

    const [p] = await enrichPanesWithSessionMeta([pane(100, { target: '0:1.1' })]);

    assert.equal(execCalls[0], 'ps -eo pid=,ppid=');
    assert.deepEqual(p, {
      paneId: '%1',
      panePid: '100',
      cwd: '/home/u/proj',
      target: '0:1.1',
      claudePid: 200,
      claudeSessionId: 'sid-1',
      sessionName: '規模感',
      status: 'waiting',
      waitingFor: 'input needed',
      slug: null,
    });
  });

  it('claude が見つからないペインは null で埋める', async () => {
    writeMeta(999, { sessionId: 'other', name: 'x' });
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, null);
    assert.equal(p.claudeSessionId, null);
    assert.equal(p.sessionName, null);
    assert.equal(p.status, null);
    assert.equal(p.waitingFor, null);
    assert.equal(p.slug, null);
  });

  it('メタに無い項目は null にする', async () => {
    writeMeta(200, { name: 'n' });
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, 200);
    assert.equal(p.claudeSessionId, null);
    assert.equal(p.status, null);
    assert.equal(p.waitingFor, null);
  });

  it('ps が使えなければ紐づけない', async () => {
    writeMeta(200, { sessionId: 'sid-1', name: 'n' });
    psResult = { err: new Error('ps: not found'), stdout: '' };

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, null);
  });

  it('ps の形の崩れた行は読み飛ばす', async () => {
    writeMeta(200, { sessionId: 'sid-1', name: 'n' });
    psResult.stdout = ['PID PPID', '200 100 extra', 'abc 100', '200 100'].join('\n');

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, 200);
  });

  it('同じ親の子を全部辿る', async () => {
    writeMeta(300, { sessionId: 'sid-3', name: 'n' });
    psResult.stdout = ['201 100', '300 100'].join('\n');

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, 300);
  });

  it('.json 以外・壊れたファイル・pid の無いメタは無視する', async () => {
    writeFileSync(join(dirs.sessions, '200.txt'), JSON.stringify({ pid: 200, sessionId: 'txt', name: 'n' }));
    writeFileSync(join(dirs.sessions, '201.json'), '{broken');
    writeFileSync(join(dirs.sessions, '202.json'), JSON.stringify({ sessionId: 'nopid', name: 'n' }));
    writeFileSync(join(dirs.sessions, '203.json'), 'null');
    writeMeta(204, { sessionId: 'ok', name: 'n' });
    psResult.stdout = ['200 100', '201 100', '202 100', '203 100', '204 100'].join('\n');

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, 204);
    assert.equal(p.claudeSessionId, 'ok');
  });

  it('セッションディレクトリが無ければ紐づけない', async () => {
    rmSync(dirs.sessions, { recursive: true, force: true });
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.claudePid, null);
  });

  it('name の無いセッションは JSONL の slug を付ける（壊れた行・空行は飛ばす）', async () => {
    writeMeta(200, { sessionId: 'sid-1', cwd: '/home/u/repo' });
    writeJsonl('/home/u/repo', 'sid-1', [
      JSON.stringify({ type: 'user' }),
      '',
      '{broken',
      JSON.stringify({ slug: 'happy-cat' }),
      JSON.stringify({ slug: 'later' }),
    ]);
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.slug, 'happy-cat');
    assert.equal(p.sessionName, null);
  });

  it('メタに cwd が無ければペインの cwd から JSONL を探す', async () => {
    writeMeta(200, { sessionId: 'sid-1' });
    writeJsonl('/home/u/proj', 'sid-1', [JSON.stringify({ slug: 'from-pane-cwd' })]);
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.slug, 'from-pane-cwd');
  });

  it('name があれば slug は引かない', async () => {
    writeMeta(200, { sessionId: 'sid-1', name: 'named', cwd: '/home/u/repo' });
    writeJsonl('/home/u/repo', 'sid-1', [JSON.stringify({ slug: 'unused' })]);
    psResult.stdout = '200 100\n';

    const [p] = await enrichPanesWithSessionMeta([pane(100)]);

    assert.equal(p.slug, null);
  });

  it('JSONL が無い・slug が無い・sessionId が無いときは slug なし', async () => {
    writeMeta(200, { sessionId: 'missing', cwd: '/home/u/repo' });
    writeMeta(201, { sessionId: 'noslug', cwd: '/home/u/repo' });
    writeMeta(202, { cwd: '/home/u/repo' });
    writeJsonl('/home/u/repo', 'noslug', [JSON.stringify({ type: 'user' })]);
    writeJsonl('/home/u/repo', 'undefined', [JSON.stringify({ slug: 'wrong' })]);
    psResult.stdout = ['200 100', '201 101', '202 102'].join('\n');

    const panes = await enrichPanesWithSessionMeta([pane(100), pane(101), pane(102)]);

    assert.deepEqual(
      panes.map((p) => [p.claudePid, p.slug]),
      [
        [200, null],
        [201, null],
        [202, null],
      ],
    );
  });

  it('cwd がどこにも無ければ slug は引かない', async () => {
    writeMeta(200, { sessionId: 'sid-1' });
    psResult.stdout = '200 100\n';
    // cwd が空文字のときに組み立てられるパス（projects/<空>/sid-1.jsonl）に置いても読まない
    writeFileSync(join(dirs.projects, 'sid-1.jsonl'), JSON.stringify({ slug: 'wrong' }));

    const [p] = await enrichPanesWithSessionMeta([pane(100, { cwd: '' })]);

    assert.equal(p.slug, null);
    assert.ok(readdirSync(dirs.projects).includes('sid-1.jsonl'));
  });
});

describe('readStatusByPid', () => {
  beforeEach(() => resetDir(dirs.sessions));

  it('pid が無ければファイルを読まずに null を返す', async () => {
    writeFileSync(join(dirs.sessions, 'null.json'), JSON.stringify({ status: 'busy' }));
    writeFileSync(join(dirs.sessions, 'undefined.json'), JSON.stringify({ status: 'busy' }));
    assert.deepEqual(await readStatusByPid(null), { status: null, waitingFor: null });
    assert.deepEqual(await readStatusByPid(undefined), { status: null, waitingFor: null });
  });

  it('ステータスファイルから status と waitingFor を読む', async () => {
    writeMeta(42, { status: 'waiting', waitingFor: 'permission prompt' });
    assert.deepEqual(await readStatusByPid(42), { status: 'waiting', waitingFor: 'permission prompt' });
  });

  it('無い項目は null にする', async () => {
    writeMeta(42, {});
    assert.deepEqual(await readStatusByPid(42), { status: null, waitingFor: null });
  });

  it('ファイルが無い・壊れていれば null', async () => {
    writeFileSync(join(dirs.sessions, '43.json'), '{broken');
    assert.deepEqual(await readStatusByPid(41), { status: null, waitingFor: null });
    assert.deepEqual(await readStatusByPid(43), { status: null, waitingFor: null });
  });
});
