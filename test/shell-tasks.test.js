import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm, chmod, utimes, readdir, readlink } from 'fs/promises';
import { statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listShellTasks, readShellTaskOutput, clearShellTasksCache, shellTasksDir } from '../server/shell-tasks.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_DIR = '-home-user-proj';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// Bash の tool_use（assistant 側）
const bashUse = (id, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
});

// tool_result（user 側）。text にバックグラウンドの出力先パスを載せられる
const toolResult = (toolUseId, text = 'done') => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
});

// テストが作った一時ディレクトリだけを後で消す
const createdDirs = [];
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    // chmod 0 にしたファイルも消せるよう、ディレクトリ側の権限だけで rm する
    await rm(dir, { recursive: true, force: true });
  }
});

// rootDir/<projectDir>/<sessionId>/tasks/ と projectsDir/<projectDir>/<sessionId>.jsonl を用意する
async function setupProject({ parentRecords = [] } = {}) {
  const rootDir = await makeTmp('shell-tasks-root-');
  const projectsDir = await makeTmp('shell-tasks-projects-');
  const tasksDir = shellTasksDir({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, rootDir });
  await mkdir(tasksDir, { recursive: true });
  await mkdir(join(projectsDir, PROJECT_DIR), { recursive: true });
  const parentJsonl = join(projectsDir, PROJECT_DIR, `${SESSION_ID}.jsonl`);
  await writeFile(parentJsonl, jsonl(parentRecords));
  return {
    rootDir,
    projectsDir,
    tasksDir,
    parentJsonl,
    target: { projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, rootDir, projectsDir },
  };
}

async function writeOutput(tasksDir, taskId, content) {
  await writeFile(join(tasksDir, `${taskId}.output`), content);
}

// テスト間で JSONL の読み足しキャッシュ（オフセット）を持ち越さない
beforeEach(() => clearShellTasksCache());

describe('listShellTasks', () => {
  it('returns an empty array when there is no tasks directory', async () => {
    const rootDir = await makeTmp('shell-tasks-root-');
    const projectsDir = await makeTmp('shell-tasks-projects-');
    assert.deepEqual(
      await listShellTasks({ projectDir: PROJECT_DIR, claudeSessionId: SESSION_ID, rootDir, projectsDir }),
      [],
    );
  });

  it('rejects an invalid claudeSessionId', async () => {
    const { rootDir, projectsDir } = await setupProject();
    for (const claudeSessionId of ['../escape', 'a/b', '']) {
      assert.deepEqual(await listShellTasks({ projectDir: PROJECT_DIR, claudeSessionId, rootDir, projectsDir }), []);
    }
  });

  it('reports running while there is no exit footer', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'aaa111', 'building...\ncompiling foo.js\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, 'aaa111');
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[0].exitCode, null);
    assert.equal(tasks[0].preview, 'compiling foo.js');
    assert.equal(tasks[0].background, false);
    assert.ok(tasks[0].size > 0);
    assert.ok(tasks[0].updatedAt);
    assert.ok(tasks[0].startedAt);
  });

  it('reads the exit code from the footer and keeps it out of the preview', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'ok1', 'all good\n\n[exited with code 0]\n');
    await writeOutput(tasksDir, 'ng1', 'boom\n\n[exited with code 2]\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.ok1.status, 'exited');
    assert.equal(byId.ok1.exitCode, 0);
    assert.equal(byId.ok1.preview, 'all good');
    assert.equal(byId.ng1.status, 'exited');
    assert.equal(byId.ng1.exitCode, 2);
    assert.equal(byId.ng1.preview, 'boom');
  });

  it('ignores files that are not .output', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'real', 'hi\n');
    await writeFile(join(tasksDir, 'notes.txt'), 'ignore me');
    await writeFile(join(tasksDir, 'real.output.bak'), 'ignore me too');

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => t.taskId),
      ['real'],
    );
  });

  it('skips symlinks (background subagents link tasks/<agentId>.output to their JSONL)', async () => {
    const { tasksDir, projectsDir, target } = await setupProject();
    await writeOutput(tasksDir, 'bash1', 'ok\n[exited with code 0]\n');
    const agentJsonl = join(projectsDir, 'agent-abc.jsonl');
    await writeFile(agentJsonl, jsonl([{ type: 'assistant', isSidechain: true }]));
    await symlink(agentJsonl, join(tasksDir, 'abc.output'));

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => t.taskId),
      ['bash1'],
    );
  });

  it('puts running tasks before exited ones', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'done1', 'x\n[exited with code 0]\n');
    await writeOutput(tasksDir, 'live1', 'y\n');

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => t.taskId),
      ['live1', 'done1'],
    );
  });

  it('labels a background task from the output path in its tool_result', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        bashUse('toolu_bg', { description: '開発サーバーを起動', command: 'npm run dev', run_in_background: true }),
        toolResult(
          'toolu_bg',
          'Command running in background with ID: bg9i2x. Output is being written to: /tmp/claude-1000/-p/s/tasks/bg9i2x.output',
        ),
      ],
    });
    await writeOutput(tasksDir, 'bg9i2x', 'listening on 3000\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].taskId, 'bg9i2x');
    assert.equal(tasks[0].background, true);
    assert.equal(tasks[0].label, '開発サーバーを起動');
  });

  it('keeps the background label when a later non-Bash tool_result mentions the output path', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        bashUse('toolu_bg', { description: '長い処理', command: 'make all', run_in_background: true }),
        toolResult(
          'toolu_bg',
          'Command running in background with ID: bgkeep. Output is being written to: /tmp/claude-1000/-p/s/tasks/bgkeep.output',
        ),
        // 後からブラウザ操作やファイル読みの結果が同じパスを含んでも対応表を上書きしない
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/x' } }],
          },
        },
        toolResult('toolu_read', 'saw /tmp/claude-1000/-p/s/tasks/bgkeep.output in the page'),
        // Bash でも定型文が無い tool_result（ls の結果など）は対応づけに使わない
        bashUse('toolu_ls', { description: '一覧', command: 'ls' }),
        toolResult('toolu_ls', '/tmp/claude-1000/-p/s/tasks/bgkeep.output\n'),
      ],
    });
    await writeOutput(tasksDir, 'bgkeep', 'working\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].label, '長い処理');
    assert.equal(tasks[0].background, true);
  });

  it('labels a foreground task from the oldest unfinished Bash tool_use', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        // 完了済みなので候補から外れる
        bashUse('toolu_done', { description: '終わったやつ', command: 'ls' }),
        toolResult('toolu_done'),
        // Bash 以外は候補にしない
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a.js' } }],
          },
        },
        bashUse('toolu_fg', { description: 'テストを実行', command: 'npm test' }),
      ],
    });
    await writeOutput(tasksDir, 'fg1', 'running tests\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].background, false);
    assert.equal(tasks[0].label, 'テストを実行');
  });

  it('falls back to the command when the Bash tool_use has no description', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [bashUse('toolu_nodesc', { command: 'sleep 100' })],
    });
    await writeOutput(tasksDir, 'fg2', 'zzz\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].label, 'sleep 100');
  });

  it('leaves the extra file without a label when there are more files than candidates', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [bashUse('toolu_one', { description: '一本だけ', command: 'a' })],
    });
    // startedAt の昇順で対応づけるので、先に作った方にラベルが付く
    await writeOutput(tasksDir, 'first', 'a\n');
    await new Promise((r) => setTimeout(r, 12));
    await writeOutput(tasksDir, 'second', 'b\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.first.label, '一本だけ');
    assert.equal(byId.second.label, null);
  });

  it('picks up records appended after the first call (incremental scan)', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject({
      parentRecords: [{ type: 'assistant', message: { role: 'assistant', content: '作業中' } }],
    });
    await writeOutput(tasksDir, 'later1', 'waiting\n');

    const first = await listShellTasks(target);
    assert.equal(first[0].label, null);

    await appendFile(parentJsonl, jsonl([bashUse('toolu_late', { description: 'あとから来た', command: 'x' })]));

    const second = await listShellTasks(target);
    assert.equal(second[0].label, 'あとから来た');
  });
});

describe('readShellTaskOutput', () => {
  it('strips ANSI escapes and the exit footer', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(
      tasksDir,
      'ansi1',
      '\u001b[32mPASS\u001b[0m tests\n\u001b]0;title\u0007done\n[exited with code 0]\n',
    );

    const out = await readShellTaskOutput({ ...target, taskId: 'ansi1' });
    assert.equal(out.status, 'exited');
    assert.equal(out.exitCode, 0);
    assert.equal(out.truncated, false);
    assert.equal(out.text, 'PASS tests\ndone\n');
  });

  it('reports running and keeps the body when there is no footer', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'live2', 'step 1\nstep 2\n');

    const out = await readShellTaskOutput({ ...target, taskId: 'live2' });
    assert.equal(out.status, 'running');
    assert.equal(out.exitCode, null);
    assert.equal(out.text, 'step 1\nstep 2\n');
  });

  it('returns only the tail when the file is larger than maxBytes', async () => {
    const { tasksDir, target } = await setupProject();
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await writeOutput(tasksDir, 'big1', body);

    const out = await readShellTaskOutput({ ...target, taskId: 'big1', maxBytes: 200 });
    assert.equal(out.truncated, true);
    assert.ok(out.size > 200);
    assert.ok(out.text.length <= 200);
    assert.ok(out.text.endsWith('line 199\n'));
    // 先頭の壊れた行は捨てるので、必ず行頭から始まる
    assert.ok(/^line \d+\n/.test(out.text));
  });

  it('returns null for a taskId that could escape the tasks directory', async () => {
    const { target } = await setupProject();
    for (const taskId of ['../../etc/passwd', 'a/b', 'a.b', '']) {
      assert.equal(await readShellTaskOutput({ ...target, taskId }), null);
    }
  });

  it('returns null for a symlinked output file', async () => {
    const { tasksDir, projectsDir, target } = await setupProject();
    const agentJsonl = join(projectsDir, 'agent-abc.jsonl');
    await writeFile(agentJsonl, jsonl([{ type: 'assistant', isSidechain: true }]));
    await symlink(agentJsonl, join(tasksDir, 'abc.output'));

    assert.equal(await readShellTaskOutput({ ...target, taskId: 'abc' }), null);
  });

  it('returns null when the output file does not exist', async () => {
    const { target } = await setupProject();
    assert.equal(await readShellTaskOutput({ ...target, taskId: 'nope' }), null);
  });
});

// /proc/self/fd を見て、指定ファイルを開いたままの fd を返す（/proc が無い環境では null）
async function openFdsTo(filePath) {
  let fds;
  try {
    fds = await readdir('/proc/self/fd');
  } catch {
    return null;
  }
  const hits = [];
  for (const fd of fds) {
    try {
      if ((await readlink(join('/proc/self/fd', fd))) === filePath) hits.push(fd);
    } catch {
      // 列挙中に閉じた fd は無視する
    }
  }
  return hits;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('shellTasksDir / SHELL_TASKS_ROOT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('places the output files under <root>/<projectDir>/<sessionId>/tasks', () => {
    assert.equal(
      shellTasksDir({ projectDir: 'proj', claudeSessionId: 'sess', rootDir: '/r' }),
      join('/r', 'proj', 'sess', 'tasks'),
    );
  });

  it('uses CLAUDE_BRIDGE_SHELL_TASKS_ROOT when it is set', async () => {
    vi.stubEnv('CLAUDE_BRIDGE_SHELL_TASKS_ROOT', '/custom/root');
    vi.resetModules();
    const mod = await import('../server/shell-tasks.js');
    assert.equal(mod.SHELL_TASKS_ROOT, '/custom/root');
    assert.equal(mod.shellTasksDir({ projectDir: 'p', claudeSessionId: 's' }), join('/custom/root', 'p', 's', 'tasks'));
  });

  it.skipIf(typeof process.getuid !== 'function')(
    'defaults to <os.tmpdir()>/claude-<uid> when the env is unset',
    async () => {
      vi.stubEnv('CLAUDE_BRIDGE_SHELL_TASKS_ROOT', '');
      vi.resetModules();
      const mod = await import('../server/shell-tasks.js');
      assert.equal(mod.SHELL_TASKS_ROOT, join(tmpdir(), `claude-${process.getuid()}`));
    },
  );

  it('falls back to claude-0 when process.getuid is not available (Windows)', async () => {
    vi.stubEnv('CLAUDE_BRIDGE_SHELL_TASKS_ROOT', '');
    const original = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
    try {
      vi.resetModules();
      const mod = await import('../server/shell-tasks.js');
      assert.equal(mod.SHELL_TASKS_ROOT, join(tmpdir(), 'claude-0'));
    } finally {
      if (original) Object.defineProperty(process, 'getuid', original);
      else delete process.getuid;
    }
  });
});

describe('listShellTasks (edge cases)', () => {
  it('skips output files whose taskId has characters outside [A-Za-z0-9_-]', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'a.b', 'dotted\n');
    await writeOutput(tasksDir, 'good', 'ok\n');

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => t.taskId),
      ['good'],
    );
  });

  it('rejects a claudeSessionId with a dot even if such a directory exists', async () => {
    const { rootDir, projectsDir } = await setupProject();
    const dir = shellTasksDir({ projectDir: PROJECT_DIR, claudeSessionId: 'a.b', rootDir });
    await mkdir(dir, { recursive: true });
    await writeOutput(dir, 'x1', 'hi\n');
    assert.deepEqual(
      await listShellTasks({ projectDir: PROJECT_DIR, claudeSessionId: 'a.b', rootDir, projectsDir }),
      [],
    );
  });

  it('rejects an empty projectDir even if <root>/<sessionId>/tasks exists', async () => {
    const { rootDir, projectsDir } = await setupProject();
    const dir = join(rootDir, SESSION_ID, 'tasks');
    await mkdir(dir, { recursive: true });
    await writeOutput(dir, 'x1', 'hi\n');
    assert.deepEqual(await listShellTasks({ projectDir: '', claudeSessionId: SESSION_ID, rootDir, projectsDir }), []);
  });

  it('returns an empty array (not throwing) for non-string targets', async () => {
    const { rootDir, projectsDir } = await setupProject();
    assert.deepEqual(await listShellTasks({ claudeSessionId: SESSION_ID, rootDir, projectsDir }), []);
    assert.deepEqual(await listShellTasks({ projectDir: PROJECT_DIR, claudeSessionId: 123, rootDir, projectsDir }), []);
    assert.deepEqual(await listShellTasks(), []);
  });

  it('only treats a whole line "[exited with code N]" as the exit footer', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'prefixed', 'echo [exited with code 1]\n');
    await writeOutput(tasksDir, 'suffixed', '[exited with code 1] not really\n');

    const tasks = await listShellTasks(target);
    assert.deepEqual(tasks.map((t) => [t.taskId, t.status, t.exitCode]).sort(), [
      ['prefixed', 'running', null],
      ['suffixed', 'running', null],
    ]);
  });

  it('reads multi-digit exit codes and a footer with surrounding whitespace', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'killed', 'boom\n[exited with code 137]  \n   \n');
    await writeOutput(tasksDir, 'onlyfooter', '[exited with code 3]\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.killed.status, 'exited');
    assert.equal(byId.killed.exitCode, 137);
    assert.equal(byId.killed.preview, 'boom');
    assert.equal(byId.onlyfooter.status, 'exited');
    assert.equal(byId.onlyfooter.exitCode, 3);
    assert.equal(byId.onlyfooter.preview, '');
  });

  it('reports an empty output file as running with an empty preview', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'empty', '');

    const tasks = await listShellTasks(target);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[0].exitCode, null);
    assert.equal(tasks[0].preview, '');
    assert.equal(tasks[0].size, 0);
  });

  it('trims the preview line and cuts it at 120 characters', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'indented', '    indented line   \n');
    await writeOutput(tasksDir, 'long', 'x'.repeat(300) + '\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.indented.preview, 'indented line');
    assert.equal(byId.long.preview, 'x'.repeat(120));
  });

  it('does not show the partial first line of a large file as the preview', async () => {
    const { tasksDir, target } = await setupProject();
    // 末尾 4KB の中に改行が 1 つしか無い＝読んだ範囲の 1 行目は途中から始まる壊れた行
    await writeOutput(tasksDir, 'huge', 'A'.repeat(6000) + '\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].preview, '');
    assert.equal(tasks[0].size, 6001);
  });

  it.skipIf(isRoot)('reports an unreadable output file as running instead of failing', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'locked', 'secret\n[exited with code 0]\n');
    await chmod(join(tasksDir, 'locked.output'), 0o000);

    const tasks = await listShellTasks(target);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, 'locked');
    assert.equal(tasks[0].status, 'running');
    assert.equal(tasks[0].exitCode, null);
    assert.equal(tasks[0].preview, '');
  });

  it('does not keep the output file open after listing', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'fdcheck', 'hello\n');
    await listShellTasks(target);
    const hits = await openFdsTo(join(tasksDir, 'fdcheck.output'));
    if (hits !== null) assert.deepEqual(hits, []);
  });

  it('does not keep the parent JSONL open after scanning it', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject({
      parentRecords: [bashUse('toolu_fd', { description: 'fd', command: 'x' })],
    });
    await writeOutput(tasksDir, 'fd1', 'a\n');
    await listShellTasks(target);
    const hits = await openFdsTo(parentJsonl);
    if (hits !== null) assert.deepEqual(hits, []);
  });

  it('records startedAt from the birth time and updatedAt from the last write', async () => {
    const { tasksDir, target } = await setupProject();
    const file = join(tasksDir, 'grow.output');
    await writeFile(file, 'first\n');
    // birthtime の取れないファイルシステムでは確かめようがない
    if (!(statSync(file).birthtimeMs > 0)) return;
    await sleep(30);
    await appendFile(file, 'second\n');

    const [task] = await listShellTasks(target);
    assert.ok(task.startedAt < task.updatedAt, `${task.startedAt} < ${task.updatedAt}`);
    assert.equal(task.startedAt, statSync(file).birthtime.toISOString());
  });

  it('orders running tasks by start (newest first) and exited tasks by last update (newest first)', async () => {
    const { tasksDir, target } = await setupProject();
    // 作成順: r1 → e1 → r2 → e2 → r3 → e3（r* は実行中、e* は終了済み）
    for (const id of ['r1', 'e1', 'r2', 'e2', 'r3', 'e3']) {
      await writeOutput(tasksDir, id, id.startsWith('e') ? `${id}\n[exited with code 0]\n` : `${id}\n`);
      await sleep(15);
    }
    // 更新時刻は作成順とずらす（実行中は開始順、終了済みは更新順で並ぶことを見分けるため）
    const base = Date.now() / 1000;
    for (const [id, offset] of [
      ['r1', 300],
      ['r2', 200],
      ['r3', 100],
      ['e1', 100],
      ['e2', 300],
      ['e3', 200],
    ]) {
      await utimes(join(tasksDir, `${id}.output`), base, base + offset);
    }

    const tasks = await listShellTasks(target);
    if (statSync(join(tasksDir, 'r1.output')).birthtimeMs > 0) {
      assert.deepEqual(
        tasks.map((t) => t.taskId),
        ['r3', 'r2', 'r1', 'e2', 'e3', 'e1'],
      );
    } else {
      assert.deepEqual(tasks.map((t) => t.taskId).slice(3), ['e2', 'e3', 'e1']);
    }
  });

  it('puts a running task before an exited one regardless of file names', async () => {
    for (const [running, exited] of [
      ['pp', 'qq'],
      ['qq', 'pp'],
    ]) {
      const { tasksDir, target } = await setupProject();
      await writeOutput(tasksDir, running, 'still going\n');
      await writeOutput(tasksDir, exited, 'done\n[exited with code 0]\n');
      const tasks = await listShellTasks(target);
      assert.deepEqual(
        tasks.map((t) => t.taskId),
        [running, exited],
      );
    }
  });

  it('labels multiple foreground tasks in start order against the Bash tool_uses in JSONL order', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        bashUse('toolu_1', { description: '一番目', command: 'a' }),
        bashUse('toolu_2', { description: '二番目', command: 'b' }),
        bashUse('toolu_3', { description: '三番目', command: 'c' }),
      ],
    });
    // 名前の順と開始順をずらす（readdir の順に頼らない）
    for (const id of ['zz', 'mm', 'aa']) {
      await writeOutput(tasksDir, id, `${id}\n`);
      await sleep(15);
    }

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t.label]));
    assert.deepEqual(byId, { zz: '一番目', mm: '二番目', aa: '三番目' });
  });

  it('does not give a label to an exited foreground task', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [bashUse('toolu_open', { description: 'まだ終わっていない', command: 'x' })],
    });
    await writeOutput(tasksDir, 'old', 'x\n[exited with code 0]\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].label, null);
  });

  it('labels only background tasks when no foreground task is running', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        bashUse('toolu_bg', { description: '裏', command: 'serve', run_in_background: true }),
        toolResult('toolu_bg', 'Command running in background with ID: bgonly. Output is being written to: x'),
        bashUse('toolu_pending', { description: 'ファイルの無い前景', command: 'y' }),
      ],
    });
    await writeOutput(tasksDir, 'bgonly', 'up\n');

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => [t.taskId, t.background, t.label]),
      [['bgonly', true, '裏']],
    );
  });

  it('cuts a description-less command label at 120 characters and leaves it null without a command', async () => {
    const longCommand = 'echo ' + 'y'.repeat(200);
    const { tasksDir, target } = await setupProject({
      parentRecords: [bashUse('toolu_long', { command: longCommand }), bashUse('toolu_empty', {})],
    });
    await writeOutput(tasksDir, 'f1', 'a\n');
    await sleep(15);
    await writeOutput(tasksDir, 'f2', 'b\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t.label]));
    assert.equal(byId.f1, longCommand.slice(0, 120));
    assert.equal(byId.f2, null);
  });

  it('reads the background task ID from a tool_result whose content is an array of blocks', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        bashUse('toolu_arr', { description: '配列の結果', command: 'serve', run_in_background: true }),
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_arr',
                content: [
                  null,
                  // text 以外のブロックや、文字列でない text は読まない
                  { type: 'image', text: 'Command running in background with ID: decoy' },
                  { type: 'text', text: 123 },
                  { type: 'text', text: ['Command running in background with ID: decoy'] },
                  { type: 'text', text: 'Command running in background with ID: bgarr' },
                  { type: 'text', text: 'more' },
                ],
              },
            ],
          },
        },
      ],
    });
    await writeOutput(tasksDir, 'bgarr', 'up\n');
    await writeOutput(tasksDir, 'decoy', 'up\n');

    const tasks = await listShellTasks(target);
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, [t.background, t.label]]));
    assert.deepEqual(byId.bgarr, [true, '配列の結果']);
    assert.equal(byId.decoy[0], false);
  });

  it('ignores the background marker in a tool_result for a non-Bash tool', async () => {
    const { tasksDir, target } = await setupProject({
      parentRecords: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/x' } }],
          },
        },
        toolResult('toolu_read', 'Command running in background with ID: notbash'),
      ],
    });
    await writeOutput(tasksDir, 'notbash', 'x\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].background, false);
    assert.equal(tasks[0].label, null);
  });

  it('tolerates odd records in the parent JSONL', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject();
    const lines = [
      // パースできない行・message の無い行・content がオブジェクトの行・null ブロック
      '{"type":"tool_use", broken',
      JSON.stringify({ type: 'tool_use' }),
      JSON.stringify({ type: 'assistant', message: { content: { type: 'tool_use' } } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            null,
            // tool_use 以外の種類のブロックは、名前が Bash でも候補にしない
            { type: 'server_tool_use', id: 'srv_1', name: 'Bash', input: { description: '偽物' } },
            { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { description: '本物' } },
          ],
        },
      }),
      JSON.stringify(bashUse('toolu_odd1', { description: '終わった1', command: 'a' })),
      JSON.stringify(bashUse('toolu_odd2', { description: '終わった2', command: 'b' })),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            // tool_result 以外のブロックは、tool_use_id を持っていても完了の印にしない
            { type: 'web_search_tool_result', tool_use_id: 'toolu_ok', content: [] },
            // content が文字列でも配列でもない tool_result
            { type: 'tool_result', tool_use_id: 'toolu_odd1' },
            { type: 'tool_result', tool_use_id: 'toolu_odd2', content: { text: 'x' } },
          ],
        },
      }),
    ];
    await writeFile(parentJsonl, lines.join('\n') + '\n');
    await writeOutput(tasksDir, 'fgodd', 'x\n');

    const tasks = await listShellTasks(target);
    assert.equal(tasks[0].label, '本物');
  });

  it('lists tasks without labels when the parent JSONL does not exist', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject();
    await rm(parentJsonl);
    await writeOutput(tasksDir, 'nojsonl', 'x\n');

    const tasks = await listShellTasks(target);
    assert.deepEqual(
      tasks.map((t) => [t.taskId, t.label]),
      [['nojsonl', null]],
    );
  });

  it('keeps already-read labels while the parent JSONL is temporarily unreadable', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject({
      parentRecords: [bashUse('toolu_keep', { description: '読み済み', command: 'x' })],
    });
    await writeOutput(tasksDir, 'keep1', 'x\n');
    assert.equal((await listShellTasks(target))[0].label, '読み済み');

    await rm(parentJsonl);
    assert.equal((await listShellTasks(target))[0].label, '読み済み');
  });

  it('re-reads the parent JSONL from the start when it has shrunk', async () => {
    const longDescription = '古いファイルのコマンド（長めの説明で縮んだと分かるように）';
    const { tasksDir, parentJsonl, target } = await setupProject({
      parentRecords: [bashUse('toolu_old', { description: longDescription, command: 'x' })],
    });
    await writeOutput(tasksDir, 'shrink1', 'x\n');
    assert.equal((await listShellTasks(target))[0].label, longDescription);

    await writeFile(parentJsonl, jsonl([bashUse('toolu_new', { description: '新しい', command: 'y' })]));
    assert.equal((await listShellTasks(target))[0].label, '新しい');
  });

  it('forgets what it read after clearShellTasksCache()', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject({
      parentRecords: [bashUse('toolu_a', { description: '前', command: 'x' })],
    });
    await writeOutput(tasksDir, 'clear1', 'x\n');
    assert.equal((await listShellTasks(target))[0].label, '前');

    // 追記ではなく中身ごと差し替えて大きくする。キャッシュを捨てれば先頭から読み直す
    const replaced = '差し替え後のコマンド。前より長い説明';
    await writeFile(parentJsonl, jsonl([bashUse('toolu_b', { description: replaced, command: 'yyyyyyyyyyyy' })]));
    clearShellTasksCache();
    assert.equal((await listShellTasks(target))[0].label, replaced);
  });

  it('ignores a trailing line that is still being written', async () => {
    const { tasksDir, parentJsonl, target } = await setupProject();
    await writeFile(parentJsonl, JSON.stringify(bashUse('toolu_partial', { description: '書きかけ', command: 'x' })));
    await writeOutput(tasksDir, 'part1', 'x\n');
    assert.equal((await listShellTasks(target))[0].label, null);

    await appendFile(parentJsonl, '\n');
    assert.equal((await listShellTasks(target))[0].label, '書きかけ');
  });
});

describe('readShellTaskOutput (edge cases)', () => {
  it('returns null for a dotted taskId even when such a file exists', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'a.b', 'dotted\n');
    assert.equal(await readShellTaskOutput({ ...target, taskId: 'a.b' }), null);
  });

  it('returns null for a non-string taskId even when a matching file exists', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, '123', 'numbers\n');
    assert.equal(await readShellTaskOutput({ ...target, taskId: 123 }), null);
  });

  it('returns null for an invalid target even when the file exists there', async () => {
    const { rootDir } = await setupProject();
    const dotted = shellTasksDir({ projectDir: PROJECT_DIR, claudeSessionId: 'a.b', rootDir });
    await mkdir(dotted, { recursive: true });
    await writeOutput(dotted, 't1', 'x\n');
    assert.equal(
      await readShellTaskOutput({ projectDir: PROJECT_DIR, claudeSessionId: 'a.b', rootDir, taskId: 't1' }),
      null,
    );

    const noProject = join(rootDir, SESSION_ID, 'tasks');
    await mkdir(noProject, { recursive: true });
    await writeOutput(noProject, 't2', 'x\n');
    assert.equal(
      await readShellTaskOutput({ projectDir: '', claudeSessionId: SESSION_ID, rootDir, taskId: 't2' }),
      null,
    );
    assert.equal(await readShellTaskOutput({ claudeSessionId: SESSION_ID, rootDir, taskId: 't2' }), null);
  });

  it('returns an empty, non-truncated body for an empty file', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'empty2', '');
    assert.deepEqual(await readShellTaskOutput({ ...target, taskId: 'empty2' }), {
      taskId: 'empty2',
      status: 'running',
      exitCode: null,
      text: '',
      truncated: false,
      size: 0,
    });
  });

  it('keeps the line that starts right at the cut when the tail begins with a newline', async () => {
    const { tasksDir, target } = await setupProject();
    // 9 バイト中の末尾 5 バイト = "\nbbb\n"（切れ目がちょうど改行）
    await writeOutput(tasksDir, 'cut1', 'aaaa\nbbb\n');
    const out = await readShellTaskOutput({ ...target, taskId: 'cut1', maxBytes: 5 });
    assert.equal(out.truncated, true);
    assert.equal(out.text, 'bbb\n');
  });

  it('returns an empty body when the tail has no complete line', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'cut2', 'z'.repeat(50));
    const out = await readShellTaskOutput({ ...target, taskId: 'cut2', maxBytes: 10 });
    assert.equal(out.truncated, true);
    assert.equal(out.text, '');
  });

  it.skipIf(isRoot)('returns null when the output file cannot be read', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'locked2', 'secret\n');
    await chmod(join(tasksDir, 'locked2.output'), 0o000);
    assert.equal(await readShellTaskOutput({ ...target, taskId: 'locked2' }), null);
  });

  it('does not keep the output file open after reading it', async () => {
    const { tasksDir, target } = await setupProject();
    await writeOutput(tasksDir, 'fdread', 'hello\n');
    await readShellTaskOutput({ ...target, taskId: 'fdread' });
    const hits = await openFdsTo(join(tasksDir, 'fdread.output'));
    if (hits !== null) assert.deepEqual(hits, []);
  });
});
