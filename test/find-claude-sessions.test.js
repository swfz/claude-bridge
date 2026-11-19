import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findClaudeSessions } from '../server/claude-sessions.js';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

async function makeProjects(entries) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-find-'));
  for (const e of entries) {
    await mkdir(join(dir, e.projectDir), { recursive: true });
    await writeFile(join(dir, e.projectDir, `${e.sessionId}.jsonl`), e.content ?? '');
  }
  return dir;
}

describe('findClaudeSessions', () => {
  it('finds sessions by id prefix (case-insensitive) and uses cwd written in the JSONL', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-claude-bridge',
        sessionId: 'abcd1234-0000-4000-8000-000000000000',
        content: jsonl([
          {
            type: 'user',
            cwd: '/home/me/claude-bridge',
            message: { role: 'user', content: [{ type: 'text', text: '依頼です' }] },
          },
        ]),
      },
      { projectDir: '-home-me-other', sessionId: 'ffff0000-0000-4000-8000-000000000000' },
    ]);
    const result = await findClaudeSessions('ABCD12', { dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].sessionId, 'abcd1234-0000-4000-8000-000000000000');
    assert.equal(result[0].projectDir, '-home-me-claude-bridge');
    assert.equal(result[0].cwd, '/home/me/claude-bridge');
    assert.equal(result[0].firstUserMessage, '依頼です');
  });

  it('falls back to the cwd restored from projectDir when the JSONL has none', async () => {
    const dir = await makeProjects([{ projectDir: '-home-me-x', sessionId: 'abcd9999' }]);
    const [hit] = await findClaudeSessions('abcd9999', { dir });
    assert.equal(hit.cwd, '/home/me/x');
  });

  it('ignores short or unsafe queries', async () => {
    const dir = await makeProjects([{ projectDir: '-home-me-x', sessionId: 'abcd9999' }]);
    assert.deepEqual(await findClaudeSessions('abc', { dir }), []);
    assert.deepEqual(await findClaudeSessions('../abcd', { dir }), []);
    assert.deepEqual(await findClaudeSessions(undefined, { dir }), []);
  });
});
