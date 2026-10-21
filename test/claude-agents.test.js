import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// child_process.execFile をモック（1回だけ設定）
const execFileCalls = [];
let execFileError = null;
let execFileStdout = '';

mock.module('child_process', {
  namedExports: {
    execFile: (file, args, options, cb) => {
      execFileCalls.push({ file, args, options });
      if (execFileError) {
        cb(execFileError);
      } else {
        cb(null, { stdout: execFileStdout, stderr: '' });
      }
    },
  },
});

// モック後に import
const { listClaudeAgents } = await import('../server/claude-agents.js');

describe('listClaudeAgents', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileError = null;
    execFileStdout = '';
  });

  it('claude agents --json をシェル非経由・timeout 付きで呼ぶ', async () => {
    execFileStdout = '[]';

    await listClaudeAgents();

    assert.equal(execFileCalls.length, 1);
    assert.equal(execFileCalls[0].file, 'claude');
    assert.deepEqual(execFileCalls[0].args, ['agents', '--json']);
    assert.equal(execFileCalls[0].options.timeout, 5000);
  });

  it('必要なフィールドだけを抽出する', async () => {
    execFileStdout = JSON.stringify([
      {
        pid: 123,
        cwd: '/home/user/project',
        kind: 'background',
        sessionId: 'sess-1',
        name: 'task a',
        status: 'running',
        token: 'secret',
        env: { HOME: '/home/user' },
      },
      { pid: 456, cwd: '/tmp', kind: 'background', sessionId: 'sess-2', name: 'task b', status: 'idle' },
    ]);

    const agents = await listClaudeAgents();

    assert.deepEqual(agents, [
      {
        pid: 123,
        cwd: '/home/user/project',
        kind: 'background',
        sessionId: 'sess-1',
        name: 'task a',
        status: 'running',
      },
      { pid: 456, cwd: '/tmp', kind: 'background', sessionId: 'sess-2', name: 'task b', status: 'idle' },
    ]);
  });

  it('欠けているフィールドは undefined のまま', async () => {
    execFileStdout = JSON.stringify([{ pid: 1 }]);

    const agents = await listClaudeAgents();

    assert.deepEqual(agents, [
      { pid: 1, cwd: undefined, kind: undefined, sessionId: undefined, name: undefined, status: undefined },
    ]);
  });

  it('配列でない JSON は []', async () => {
    execFileStdout = JSON.stringify({ agents: [] });

    assert.deepEqual(await listClaudeAgents(), []);
  });

  it('不正な JSON は []', async () => {
    execFileStdout = 'not json';

    assert.deepEqual(await listClaudeAgents(), []);
  });

  it('execFile のエラーは []', async () => {
    execFileError = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });

    assert.deepEqual(await listClaudeAgents(), []);
  });
});
