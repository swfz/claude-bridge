import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'fs/promises';
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

// rootDir/<projectDir>/<sessionId>/tasks/ と projectsDir/<projectDir>/<sessionId>.jsonl を用意する
async function setupProject({ parentRecords = [] } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'shell-tasks-root-'));
  const projectsDir = await mkdtemp(join(tmpdir(), 'shell-tasks-projects-'));
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
    const rootDir = await mkdtemp(join(tmpdir(), 'shell-tasks-root-'));
    const projectsDir = await mkdtemp(join(tmpdir(), 'shell-tasks-projects-'));
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

  it('returns null when the output file does not exist', async () => {
    const { target } = await setupProject();
    assert.equal(await readShellTaskOutput({ ...target, taskId: 'nope' }), null);
  });
});
