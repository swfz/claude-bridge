import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRecentSessions } from '../server/claude-sessions.js';

const DAY = 24 * 60 * 60 * 1000;

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const userRecord = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

// projects ディレクトリを作り、各セッションの mtime を「N 日前」に設定する
async function makeProjects(entries) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-recent-'));
  for (const e of entries) {
    const projectPath = join(dir, e.projectDir);
    await mkdir(projectPath, { recursive: true });
    const file = join(projectPath, `${e.sessionId}.jsonl`);
    await writeFile(file, e.content ?? jsonl([userRecord('何かの依頼')]));
    const at = new Date(Date.now() - e.daysAgo * DAY);
    await utimes(file, at, at);
  }
  return dir;
}

describe('listRecentSessions', () => {
  it('returns only sessions updated within the given days, newest first', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-a', sessionId: 'recent', daysAgo: 0.5 },
      { projectDir: '-home-me-a', sessionId: 'mid', daysAgo: 2 },
      { projectDir: '-home-me-b', sessionId: 'old', daysAgo: 40 },
    ]);
    const result = await listRecentSessions({ days: 7, dir });
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['recent', 'mid'],
    );
  });

  it('prefers the cwd recorded in the JSONL over the project directory name', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-gh-claude-bridge',
        sessionId: 's1',
        daysAgo: 0,
        content: jsonl([{ type: 'user', cwd: '/home/me/gh/claude-bridge', message: { content: 'hi' } }]),
      },
    ]);
    const [session] = await listRecentSessions({ days: 7, dir });
    assert.equal(session.cwd, '/home/me/gh/claude-bridge');
    assert.equal(session.projectDir, '-home-me-gh-claude-bridge');
  });

  it('falls back to the project directory name when the JSONL has no cwd', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-work',
        sessionId: 's1',
        daysAgo: 0,
        content: jsonl([{ type: 'mode' }]),
      },
    ]);
    const [session] = await listRecentSessions({ days: 7, dir });
    assert.equal(session.cwd, '/home/me/work');
  });

  it('includes the summary fields used by the home cards', async () => {
    const dir = await makeProjects([
      {
        projectDir: '-home-me-a',
        sessionId: 's1',
        daysAgo: 0,
        content: jsonl([
          { type: 'ai-title', aiTitle: 'ホーム改修' },
          userRecord('ホーム画面を改修したい'),
          { type: 'assistant', message: { content: [{ type: 'text', text: 'やりました' }] } },
          userRecord('テストも足して'),
        ]),
      },
    ]);
    const [session] = await listRecentSessions({ days: 7, dir });
    assert.equal(session.title, 'ホーム改修');
    assert.equal(session.firstUserMessage, 'ホーム画面を改修したい');
    assert.equal(session.lastUserMessage, 'テストも足して');
    assert.equal(session.lastAssistantMessage, 'やりました');
  });

  it('includes starred sessions even outside the period', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-a', sessionId: 'recent', daysAgo: 1 },
      { projectDir: '-home-me-b', sessionId: 'starred-old', daysAgo: 100 },
      { projectDir: '-home-me-b', sessionId: 'plain-old', daysAgo: 100 },
    ]);
    const result = await listRecentSessions({
      days: 7,
      dir,
      includeSessionIds: ['starred-old'],
    });
    assert.deepEqual(result.map((s) => s.sessionId).sort(), ['recent', 'starred-old']);
  });

  it('keeps starred sessions even when the limit is reached', async () => {
    const dir = await makeProjects([
      ...Array.from({ length: 3 }, (_, i) => ({
        projectDir: '-home-me-a',
        sessionId: `s${i}`,
        daysAgo: i * 0.1,
      })),
      { projectDir: '-home-me-b', sessionId: 'starred-old', daysAgo: 200 },
    ]);
    const result = await listRecentSessions({
      days: 7,
      limit: 1,
      dir,
      includeSessionIds: ['starred-old'],
    });
    assert.ok(result.some((s) => s.sessionId === 'starred-old'));
    assert.equal(result.length, 2);
  });

  it('honors the limit', async () => {
    const dir = await makeProjects(
      Array.from({ length: 5 }, (_, i) => ({
        projectDir: '-home-me-a',
        sessionId: `s${i}`,
        daysAgo: i * 0.1,
      })),
    );
    assert.equal((await listRecentSessions({ days: 7, limit: 2, dir })).length, 2);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listRecentSessions({
      days: 7,
      dir: join(tmpdir(), 'cb-recent-does-not-exist'),
    });
    assert.deepEqual(result, []);
  });
});
