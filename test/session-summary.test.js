import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  summarizeHead,
  summarizeTail,
  readSessionSummary,
  readSessionSummaryFor,
  readLastLines,
} from '../server/session-summary.js';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const userRecord = (text, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra,
});

describe('summarizeHead', () => {
  it('prefers ai-title and picks up the first user prompt and branch', () => {
    const lines = jsonl([
      { type: 'mode' },
      { type: 'last-prompt', lastPrompt: 'ホーム画面を改修したい' },
      { type: 'ai-title', aiTitle: 'ホーム画面の改修' },
      userRecord('ホーム画面を改修したい', { gitBranch: 'main' }),
    ]).split('\n');
    const head = summarizeHead(lines);
    assert.equal(head.title, 'ホーム画面の改修');
    assert.equal(head.firstUserMessage, 'ホーム画面を改修したい');
    assert.equal(head.gitBranch, 'main');
  });

  it('falls back to the first user prompt when there is no ai-title', () => {
    const lines = jsonl([userRecord('テストを書いて')]).split('\n');
    assert.equal(summarizeHead(lines).title, 'テストを書いて');
  });

  it('ignores tool results, meta records and broken lines', () => {
    const lines = [
      '{ broken',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      JSON.stringify(userRecord('<command-name>/clear</command-name>')),
      JSON.stringify(userRecord('本当の依頼', { isMeta: false })),
      JSON.stringify(userRecord('これは無視される')),
    ];
    const head = summarizeHead(lines);
    assert.equal(head.firstUserMessage, '本当の依頼');
  });

  it('strips injected tags and collapses whitespace', () => {
    const lines = jsonl([
      userRecord(
        'Another Claude session sent a message:\n<teammate-message teammate_id="abc">\nレビューお願い\n</teammate-message>',
      ),
    ]).split('\n');
    assert.equal(summarizeHead(lines).firstUserMessage, 'Another Claude session sent a message: レビューお願い');
  });

  it('picks up the cwd written in the JSONL', () => {
    const lines = jsonl([userRecord('依頼', { cwd: '/home/me/gh/claude-bridge' })]).split('\n');
    assert.equal(summarizeHead(lines).cwd, '/home/me/gh/claude-bridge');
  });

  it('returns empty strings for an empty session', () => {
    assert.deepEqual(summarizeHead([]), {
      title: '',
      firstUserMessage: '',
      gitBranch: '',
      cwd: '',
    });
  });
});

describe('summarizeTail', () => {
  it('takes the newest user prompt and assistant reply', () => {
    const lines = jsonl([
      userRecord('最初の依頼'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '古い返事' }] },
      },
      userRecord('最後の依頼', { timestamp: '2026-08-17T05:00:00.000Z' }),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '新しい返事' }] },
        timestamp: '2026-08-17T05:01:00.000Z',
      },
    ]).split('\n');
    const tail = summarizeTail(lines);
    assert.equal(tail.lastUserMessage, '最後の依頼');
    assert.equal(tail.lastAssistantMessage, '新しい返事');
    assert.equal(tail.lastTimestamp, '2026-08-17T05:01:00.000Z');
  });
});

describe('readLastLines', () => {
  it('drops the partial first line when reading from the middle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-tail-'));
    const file = join(dir, 'a.jsonl');
    const content = jsonl([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    await writeFile(file, content);
    const lines = await readLastLines(file, content.length, 20);
    assert.ok(lines.length < 3);
    assert.ok(lines.every((l) => l.startsWith('{')));
  });

  it('keeps every line when the whole file fits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-tail-'));
    const file = join(dir, 'a.jsonl');
    const content = jsonl([{ type: 'a' }, { type: 'b' }]);
    await writeFile(file, content);
    assert.equal((await readLastLines(file, content.length)).length, 2);
  });
});

describe('readSessionSummary', () => {
  it('combines head and tail of a real file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'ai-title', aiTitle: 'ホーム改修' },
        userRecord('ホーム画面を改修したい', { gitBranch: 'main' }),
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '実装しました' }] },
        },
        userRecord('テストも足して'),
      ]),
    );
    const summary = await readSessionSummary(file);
    assert.equal(summary.title, 'ホーム改修');
    assert.equal(summary.firstUserMessage, 'ホーム画面を改修したい');
    assert.equal(summary.lastUserMessage, 'テストも足して');
    assert.equal(summary.lastAssistantMessage, '実装しました');
    assert.equal(summary.gitBranch, 'main');
  });

  it('hides the last prompt when it is the same as the first one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    await writeFile(file, jsonl([userRecord('一度だけの依頼')]));
    const summary = await readSessionSummary(file);
    assert.equal(summary.firstUserMessage, '一度だけの依頼');
    assert.equal(summary.lastUserMessage, '');
  });

  it('collects the artifacts published in the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'ai-title', aiTitle: 'レポート公開' },
        userRecord('レポートを公開して'),
        {
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'Published' }] },
          toolUseResult: {
            url: 'https://claude.ai/code/artifact/abc',
            path: '/tmp/report.html',
            title: '集計レポート',
          },
          timestamp: '2026-08-17T05:00:00.000Z',
        },
      ]),
    );
    const summary = await readSessionSummary(file);
    assert.deepEqual(summary.artifacts, [
      {
        url: 'https://claude.ai/code/artifact/abc',
        path: '/tmp/report.html',
        title: '集計レポート',
        timestamp: '2026-08-17T05:00:00.000Z',
      },
    ]);
  });

  it('returns an empty summary for a missing file', async () => {
    const summary = await readSessionSummary(join(tmpdir(), 'cb-nope.jsonl'));
    assert.equal(summary.title, '');
    assert.equal(summary.lastAssistantMessage, '');
    assert.deepEqual(summary.artifacts, []);
  });
});

describe('readSessionSummaryFor', () => {
  it('resolves the JSONL path from cwd and sessionId', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'cb-projects-'));
    await mkdir(join(projects, '-home-me-work'));
    await writeFile(join(projects, '-home-me-work', 'sid-1.jsonl'), jsonl([{ type: 'ai-title', aiTitle: '作業中' }]));
    const summary = await readSessionSummaryFor('/home/me/work', 'sid-1', projects);
    assert.equal(summary.title, '作業中');
  });

  it('returns an empty summary without cwd or sessionId', async () => {
    assert.equal((await readSessionSummaryFor('', 'sid', '/tmp')).title, '');
    assert.equal((await readSessionSummaryFor('/home/me', null, '/tmp')).title, '');
  });
});
