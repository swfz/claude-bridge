import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRecentSessions, readSessionEntrypoint } from '../server/claude-sessions.js';

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

  it('filters by the given session ids instead of the mtime when a period is selected', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-a', sessionId: 'in-period', daysAgo: 100 },
      { projectDir: '-home-me-a', sessionId: 'recent-but-out', daysAgo: 0.5 },
    ]);
    const result = await listRecentSessions({
      days: 7,
      dir,
      sessionIds: new Set(['in-period']),
    });
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['in-period'],
    );
  });

  it('still pins starred sessions when filtering by session ids', async () => {
    const dir = await makeProjects([
      { projectDir: '-home-me-a', sessionId: 'in-period', daysAgo: 100 },
      { projectDir: '-home-me-b', sessionId: 'starred-out', daysAgo: 300 },
    ]);
    const result = await listRecentSessions({
      days: 7,
      dir,
      sessionIds: new Set(['in-period']),
      includeSessionIds: ['starred-out'],
    });
    assert.deepEqual(result.map((s) => s.sessionId).sort(), ['in-period', 'starred-out']);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listRecentSessions({
      days: 7,
      dir: join(tmpdir(), 'cb-recent-does-not-exist'),
    });
    assert.deepEqual(result, []);
  });

  describe('claude -p (entrypoint: sdk-cli) sessions', () => {
    const headless = (text) =>
      jsonl([
        { type: 'session-owner', sessionId: 'x' },
        { type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: text } },
      ]);
    const interactive = (text) =>
      jsonl([{ type: 'user', entrypoint: 'cli', message: { role: 'user', content: text } }]);

    it('excludes headless sessions before applying the limit when includeHeadless is false', async () => {
      const dir = await makeProjects([
        { projectDir: '-home-me-a', sessionId: 'p1', daysAgo: 0.1, content: headless('定期実行') },
        { projectDir: '-home-me-a', sessionId: 'p2', daysAgo: 0.2, content: headless('定期実行') },
        { projectDir: '-home-me-b', sessionId: 'i1', daysAgo: 0.3, content: interactive('対話') },
        { projectDir: '-home-me-b', sessionId: 'i2', daysAgo: 0.4, content: interactive('対話') },
      ]);
      const excluded = await listRecentSessions({ days: 7, dir, limit: 2, includeHeadless: false });
      assert.deepEqual(
        excluded.map((s) => s.sessionId),
        ['i1', 'i2'],
      );
      const included = await listRecentSessions({ days: 7, dir, limit: 2 });
      assert.deepEqual(
        included.map((s) => s.sessionId),
        ['p1', 'p2'],
      );
    });

    it('keeps starred headless sessions even when excluding', async () => {
      const dir = await makeProjects([
        { projectDir: '-home-me-a', sessionId: 'p1', daysAgo: 0.1, content: headless('定期実行') },
        { projectDir: '-home-me-b', sessionId: 'i1', daysAgo: 0.3, content: interactive('対話') },
      ]);
      const result = await listRecentSessions({ days: 7, dir, includeHeadless: false, includeSessionIds: ['p1'] });
      assert.deepEqual(
        result.map((s) => s.sessionId),
        ['p1', 'i1'],
      );
    });

    it('treats sessions without an entrypoint as interactive', async () => {
      const dir = await makeProjects([{ projectDir: '-home-me-a', sessionId: 'old', daysAgo: 0.1 }]);
      const result = await listRecentSessions({ days: 7, dir, includeHeadless: false });
      assert.deepEqual(
        result.map((s) => s.sessionId),
        ['old'],
      );
      assert.equal(await readSessionEntrypoint(join(dir, '-home-me-a', 'old.jsonl')), null);
    });
  });
});
