import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, appendFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  summarizeHead,
  summarizeTail,
  detectTurnState,
  endsWithQuestion,
  userPrompt,
  readSessionSummary,
  readSessionSummaryFor,
  readLastLines,
  readFirstLines,
  snippetText,
  findRelocatedCwd,
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

  it('skips messages from subagents and teammates, and collapses whitespace', () => {
    const lines = jsonl([
      userRecord(
        'Another Claude session sent a message:\n<teammate-message teammate_id="abc">\nレビューお願い\n</teammate-message>',
      ),
      userRecord('本当の\n  依頼'),
    ]).split('\n');
    assert.equal(summarizeHead(lines).firstUserMessage, '本当の 依頼');
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

  it('末尾の usage 付き assistant からコンテキスト使用量を取る', () => {
    const lines = jsonl([
      userRecord('依頼'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '古い返事' }], usage: { input_tokens: 1 } },
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: '新しい返事' }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 },
        },
      },
    ]).split('\n');
    const tail = summarizeTail(lines);
    assert.equal(tail.contextUsage.contextTokens, 100);
    assert.equal(tail.contextUsage.contextWindow, 200_000);
  });

  it('usage の無い末尾レコードは飛ばして直近の usage 付き assistant を使う', () => {
    const lines = jsonl([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '返事' }], usage: { input_tokens: 5 } },
      },
      // API エラー等で usage を持たない assistant
      { type: 'assistant', message: { content: [{ type: 'text', text: 'エラー' }] } },
      userRecord('次の依頼'),
    ]).split('\n');
    assert.equal(summarizeTail(lines).contextUsage.contextTokens, 5);
  });

  it('usage がどこにも無ければ null', () => {
    const lines = jsonl([userRecord('依頼')]).split('\n');
    assert.equal(summarizeTail(lines).contextUsage, null);
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

  it('prefers the latest /rename title over ai-title, wherever it appears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    // head (40 lines) にも tail にも入らない位置に置く
    const filler = Array.from({ length: 60 }, (_, i) => userRecord(`作業 ${i}`));
    const padding = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(140 * 1024) }] } };
    await writeFile(
      file,
      jsonl([
        { type: 'ai-title', aiTitle: 'とりあえず起動' },
        ...filler,
        { type: 'custom-title', customTitle: '古い名前', sessionId: 's' },
        { type: 'custom-title', customTitle: '  タイトル更新の改善  ', sessionId: 's' },
        padding,
        userRecord('最後の指示'),
      ]),
    );
    const summary = await readSessionSummary(file);
    assert.equal(summary.title, 'タイトル更新の改善');
  });

  it('falls back to ai-title when the custom title is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'ai-title', aiTitle: 'ホーム改修' },
        { type: 'custom-title', customTitle: '' },
        userRecord('依頼'),
      ]),
    );
    assert.equal((await readSessionSummary(file)).title, 'ホーム改修');
  });

  it('returns an empty summary for a missing file', async () => {
    const summary = await readSessionSummary(join(tmpdir(), 'cb-nope.jsonl'));
    assert.equal(summary.title, '');
    assert.equal(summary.lastAssistantMessage, '');
    assert.deepEqual(summary.artifacts, []);
  });
});

describe('summarizeTail relocatedCwd', () => {
  const worktreeState = (originalCwd) => ({
    type: 'worktree-state',
    worktreeSession: originalCwd
      ? { originalCwd, worktreePath: `${originalCwd}/.claude/worktrees/x`, worktreeBranch: 'x', originalBranch: 'main' }
      : null,
  });

  it('prefers the last relocated record', () => {
    const lines = jsonl([
      worktreeState('/repo-a'),
      userRecord('作業'),
      { type: 'relocated', relocatedCwd: '/repo-old' },
      { type: 'relocated', relocatedCwd: '/repo-b' },
      worktreeState(null),
    ]).split('\n');
    assert.equal(summarizeTail(lines).relocatedCwd, '/repo-b');
  });

  it('falls back to worktree-state originalCwd', () => {
    const lines = jsonl([worktreeState('/repo-a'), userRecord('作業'), worktreeState(null)]).split('\n');
    assert.equal(summarizeTail(lines).relocatedCwd, '/repo-a');
  });

  it('is empty without either record', () => {
    assert.equal(summarizeTail(jsonl([userRecord('作業')]).split('\n')).relocatedCwd, '');
  });
});

describe('readSessionSummary relocatedCwd', () => {
  const write = async (records) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-'));
    const file = join(dir, 's.jsonl');
    await writeFile(file, jsonl(records));
    return file;
  };

  it('carries the relocated cwd', async () => {
    const file = await write([
      userRecord('作業', { cwd: '/repo/.claude/worktrees/x' }),
      { type: 'relocated', relocatedCwd: '/repo' },
      { type: 'worktree-state', worktreeSession: null },
    ]);
    const summary = await readSessionSummary(file);
    assert.equal(summary.cwd, '/repo/.claude/worktrees/x');
    assert.equal(summary.relocatedCwd, '/repo');
  });

  it('uses worktree-state originalCwd when there is no relocated record', async () => {
    const file = await write([
      userRecord('作業'),
      { type: 'worktree-state', worktreeSession: { originalCwd: '/repo', worktreePath: '/repo/.claude/worktrees/x' } },
    ]);
    assert.equal((await readSessionSummary(file)).relocatedCwd, '/repo');
  });

  it('is empty for a plain session and a missing file', async () => {
    assert.equal((await readSessionSummary(await write([userRecord('作業')]))).relocatedCwd, '');
    assert.equal((await readSessionSummary(join(tmpdir(), 'cb-nope.jsonl'))).relocatedCwd, '');
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

describe('detectTurnState', () => {
  const prompt = (text = 'お願い') => ({ type: 'user', message: { role: 'user', content: text } });
  const toolUse = () => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
  });
  const toolResult = () => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  const text = (t = '終わりました') => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: t }] },
  });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1 };
  const noise = [
    { type: 'last-prompt', lastPrompt: 'x' },
    { type: 'system', subtype: 'away_summary', content: 'x' },
  ];

  it("is 'ended' when the last turn closed with turn_duration (trailing metadata is ignored)", () => {
    assert.equal(detectTurnState([prompt(), toolUse(), toolResult(), text(), turnEnd, ...noise]), 'ended');
  });

  it('ignores the auto-compact summary as a prompt', () => {
    const compact = { ...prompt('This session is being continued ...'), isCompactSummary: true };
    assert.equal(detectTurnState([prompt(), text(), turnEnd, compact]), 'ended');
    assert.equal(userPrompt(compact), '');
  });

  it("is 'ended' for a text reply without turn_duration (older transcripts)", () => {
    assert.equal(detectTurnState([prompt(), text()]), 'ended');
  });

  it("is 'midway' when it stopped while running a tool", () => {
    assert.equal(detectTurnState([prompt(), toolUse()]), 'midway');
    assert.equal(detectTurnState([prompt(), toolUse(), toolResult()]), 'midway');
  });

  it("is 'error' when the last reply is an API error, even with turn_duration after it", () => {
    const apiError = { ...text('API Error: 529 Overloaded.'), isApiErrorMessage: true };
    assert.equal(detectTurnState([prompt(), apiError, turnEnd]), 'error');
    assert.equal(detectTurnState([prompt(), text('API Error: 500')]), 'error');
  });

  it("is 'interrupted' when the user interrupted", () => {
    const interrupt = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    };
    assert.equal(detectTurnState([prompt(), toolUse(), interrupt]), 'interrupted');
  });

  it("is 'prompt' when the last instruction got no reply", () => {
    assert.equal(detectTurnState([prompt(), text(), turnEnd, prompt('次これ')]), 'prompt');
  });

  it('skips meta and command records when looking for the last prompt', () => {
    const meta = { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } };
    const command = prompt('<local-command-stdout>ok</local-command-stdout>');
    assert.equal(detectTurnState([prompt(), text(), turnEnd, meta, command]), 'ended');
  });

  it('is null when there is nothing to judge', () => {
    assert.equal(detectTurnState([]), null);
    assert.equal(detectTurnState(noise), null);
  });
});

describe('summarizeTail awaySummary / turnState', () => {
  it('takes the latest away_summary without the recap footer', () => {
    const lines = [
      { type: 'system', subtype: 'away_summary', content: '古い要約', timestamp: '2026-10-01T00:00:00Z' },
      {
        type: 'system',
        subtype: 'away_summary',
        content: '設計中です。次は方針を決めてください。 (disable recaps in /config)',
        timestamp: '2026-10-02T00:00:00Z',
      },
    ].map((r) => JSON.stringify(r));
    const tail = summarizeTail(lines);
    assert.deepEqual(tail.awaySummary, {
      text: '設計中です。次は方針を決めてください。',
      timestamp: '2026-10-02T00:00:00Z',
    });
    assert.equal(tail.turnState, null);
  });

  it('is null when there is no away_summary', () => {
    assert.equal(summarizeTail([]).awaySummary, null);
  });
});

describe('endsWithQuestion', () => {
  it('is true when the reply ends with a question mark (after decorations)', () => {
    assert.equal(endsWithQuestion('どちらの方針で進めますか？'), true);
    assert.equal(endsWithQuestion('Should I continue?'), true);
    assert.equal(endsWithQuestion('**A と B のどちらにしますか？**'), true);
    assert.equal(endsWithQuestion('次は「API を先に作る？」'), true);
    assert.equal(endsWithQuestion('案は 2 つあります（`a` と `b`）。どれを採用しますか? \n\n'), true);
  });

  it('is true for Japanese phrases that ask for a reply without a question mark', () => {
    assert.equal(endsWithQuestion('どちらにするか決めてください。'), true);
    assert.equal(endsWithQuestion('A か B を選んでください'), true);
    assert.equal(endsWithQuestion('対象のブランチを指定してください！'), true);
    assert.equal(endsWithQuestion('この方針でよろしいですか。'), true);
    assert.equal(endsWithQuestion('先に移行しておきましょうか'), true);
    assert.equal(endsWithQuestion('この設計で問題ないでしょうか。'), true);
    assert.equal(endsWithQuestion('続けますか'), true);
  });

  it('is false for statements and closing pleasantries', () => {
    assert.equal(endsWithQuestion('修正してテストも通しました。'), false);
    assert.equal(endsWithQuestion('必要なら言ってください。'), false);
    assert.equal(endsWithQuestion('何かあればお知らせください'), false);
    assert.equal(endsWithQuestion('Done.'), false);
  });

  it('is false for empty input', () => {
    assert.equal(endsWithQuestion(''), false);
    assert.equal(endsWithQuestion('   '), false);
    assert.equal(endsWithQuestion(undefined), false);
  });
});

describe('summarizeTail lastAssistantQuestion', () => {
  const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  it('is true when the latest reply ends with a question', () => {
    const tail = summarizeTail(jsonl([userRecord('相談'), assistantText('A と B のどちらにしますか？')]).split('\n'));
    assert.equal(tail.lastAssistantQuestion, true);
  });

  it('is false when the latest reply is a statement even if an older one asked', () => {
    const tail = summarizeTail(
      jsonl([
        userRecord('相談'),
        assistantText('どうしますか？'),
        userRecord('A で'),
        assistantText('A で実装しました。'),
      ]).split('\n'),
    );
    assert.equal(tail.lastAssistantQuestion, false);
  });

  it('looks at the full reply, not the snippet cut for the card', () => {
    const long = `${'説明'.repeat(200)}\n\nこの方針で進めてよいですか？`;
    const tail = summarizeTail(jsonl([userRecord('相談'), assistantText(long)]).split('\n'));
    assert.equal(tail.lastAssistantQuestion, true);
  });

  it('skips tool_use-only replies to find the latest text', () => {
    const tail = summarizeTail(
      jsonl([
        userRecord('相談'),
        assistantText('どちらにしますか？'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      ]).split('\n'),
    );
    assert.equal(tail.lastAssistantQuestion, true);
  });

  it('is false without any assistant reply', () => {
    assert.equal(summarizeTail(jsonl([userRecord('依頼')]).split('\n')).lastAssistantQuestion, false);
  });
});

// ---- ここから下はミューテーションテストで見つかった穴を埋めるもの ----

const createdDirs = [];
async function tmpJsonl(content, name = 's.jsonl') {
  const dir = await mkdtemp(join(tmpdir(), 'cb-summary-mut-'));
  createdDirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}
afterEach(async () => {
  while (createdDirs.length > 0) await rm(createdDirs.pop(), { recursive: true, force: true });
});

const assistantRecord = (content, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra,
});

describe('readFirstLines', () => {
  it('maxLines 行目を読み終えた時点で読み込みを止める（1 行が読み込みの塊 64KB より長い場合）', async () => {
    // 注意: 読み込みの塊（64KB）に収まっている行は rl.close() の後も 'line' が届くので、
    // 短い行のファイルでは maxLines を超えて返る（既知の挙動）。ここでは 1 行 100KB にして、
    // 行数で止めていることだけを確かめる
    const lines = ['a', 'b', 'c', 'd'].map((ch) => JSON.stringify({ type: ch, pad: ch.repeat(100 * 1024) }));
    const file = await tmpJsonl(lines.join('\n') + '\n');
    const read = await readFirstLines(file, 2);
    assert.deepEqual(read, lines.slice(0, 2));
  });

  it('存在しないファイルは空配列', async () => {
    assert.deepEqual(await readFirstLines(join(tmpdir(), 'cb-nope-first.jsonl'), 5), []);
  });

  it('マルチバイト文字を壊さずに読む', async () => {
    const line = JSON.stringify({ text: 'あいうえお'.repeat(20000) });
    const file = await tmpJsonl(line + '\n');
    assert.deepEqual(await readFirstLines(file, 1), [line]);
  });
});

describe('readLastLines (境界)', () => {
  it('末尾 maxBytes だけを読み、それより前の行は返さない', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ type: 'x', i }));
    const content = jsonl(records);
    const file = await tmpJsonl(content);
    const lastTwo = jsonl(records.slice(-2));
    // 最後の 2 行 + 2 文字（直前の行の末尾が欠けた行として捨てられる）
    const lines = await readLastLines(file, Buffer.byteLength(content), Buffer.byteLength(lastTwo) + 2);
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).i),
      [48, 49],
    );
  });

  it('読み込みの塊をまたぐマルチバイト文字の行も壊さずつなぐ', async () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ i, text: 'あ'.repeat(3000 + i) }));
    const content = jsonl(records);
    const file = await tmpJsonl(content);
    const lines = await readLastLines(file, Buffer.byteLength(content), 1024 * 1024);
    assert.deepEqual(lines, content.split('\n').filter(Boolean));
  });

  it('存在しないファイルは空配列', async () => {
    assert.deepEqual(await readLastLines(join(tmpdir(), 'cb-nope-last.jsonl'), 100), []);
  });
});

describe('snippetText', () => {
  it('タグを空白に置き換え、連続する空白を 1 つに均して前後を落とす', () => {
    assert.equal(snippetText('  <teammate-message id="x">中身</teammate-message>\n\n  続き  '), '中身 続き');
    assert.equal(snippetText('a<b>c'), 'a c');
  });
});

describe('userPrompt', () => {
  it('人が打った user の本文だけを返す', () => {
    assert.equal(userPrompt(userRecord('  普通の\n指示  ')), '普通の 指示');
    assert.equal(userPrompt({ type: 'assistant', message: { content: [{ type: 'text', text: '応答' }] } }), '');
    assert.equal(userPrompt(userRecord('meta', { isMeta: true })), '');
    assert.equal(userPrompt(userRecord('要約', { isCompactSummary: true })), '');
    assert.equal(userPrompt(userRecord('<command-name>/x</command-name>')), '');
    assert.equal(userPrompt(userRecord('Another Claude session sent a message: 報告')), '');
    assert.equal(userPrompt(userRecord('   ')), '');
  });
});

describe('summarizeHead (境界)', () => {
  it('ai-title・ブランチ・cwd は最初に現れたものを使う', () => {
    const lines = jsonl([
      { type: 'ai-title', aiTitle: '最初のタイトル' },
      { type: 'ai-title', aiTitle: '後のタイトル' },
      userRecord('依頼', { gitBranch: 'feature/a', cwd: '/repo/a' }),
      userRecord('次の依頼', { gitBranch: 'feature/b', cwd: '/repo/b' }),
    ]).split('\n');
    const head = summarizeHead(lines);
    assert.equal(head.title, '最初のタイトル');
    assert.equal(head.firstUserMessage, '依頼');
    assert.equal(head.gitBranch, 'feature/a');
    assert.equal(head.cwd, '/repo/a');
  });

  it('文字列でない cwd は使わない', () => {
    const lines = jsonl([userRecord('依頼', { cwd: 42 }), { type: 'mode', cwd: '/repo/ok' }]).split('\n');
    assert.equal(summarizeHead(lines).cwd, '/repo/ok');
  });

  it('指示が無ければ最初の last-prompt を冒頭の依頼・タイトルにする', () => {
    const lines = jsonl([
      { type: 'last-prompt', lastPrompt: '  前回の\n指示  ' },
      { type: 'last-prompt', lastPrompt: '別の指示' },
    ]).split('\n');
    assert.deepEqual(summarizeHead(lines), {
      title: '前回の 指示',
      firstUserMessage: '前回の 指示',
      gitBranch: '',
      cwd: '',
    });
  });

  it('空の ai-title・last-prompt は飛ばす', () => {
    const lines = jsonl([
      { type: 'ai-title', aiTitle: '' },
      { type: 'last-prompt', lastPrompt: '' },
      { type: 'ai-title', aiTitle: '中身のあるタイトル' },
      { type: 'last-prompt', lastPrompt: '中身のある指示' },
    ]).split('\n');
    const head = summarizeHead(lines);
    assert.equal(head.title, '中身のあるタイトル');
    assert.equal(head.firstUserMessage, '中身のある指示');
  });

  it('タイトルは 100 文字、冒頭の依頼は 180 文字で切る', () => {
    const lines = jsonl([{ type: 'ai-title', aiTitle: 'た'.repeat(150) }, userRecord('い'.repeat(300))]).split('\n');
    const head = summarizeHead(lines);
    assert.equal(head.title, 'た'.repeat(100));
    assert.equal(head.firstUserMessage, 'い'.repeat(180));
  });

  it('ai-title のタグ・改行は均してタイトルにする', () => {
    const lines = jsonl([{ type: 'ai-title', aiTitle: '<b>強調</b>\n  タイトル' }]).split('\n');
    assert.equal(summarizeHead(lines).title, '強調 タイトル');
  });
});

describe('summarizeTail (境界)', () => {
  it('各項目を別々のレコードから拾う（どれか 1 つで探索を打ち切らない）', () => {
    const lines = jsonl([
      userRecord('古い依頼'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '前の応答ですか？' }],
          usage: { input_tokens: 3 },
        },
      },
      userRecord('最後の依頼'),
      assistantRecord([{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
      { type: 'system', subtype: 'informational', timestamp: '2026-10-05T00:00:00.000Z' },
    ]).split('\n');
    const tail = summarizeTail(lines);
    assert.equal(tail.lastTimestamp, '2026-10-05T00:00:00.000Z');
    assert.equal(tail.lastUserMessage, '最後の依頼');
    // tool_use だけの直近の応答は本文が空なので、その前の本文のある応答を使う
    assert.equal(tail.lastAssistantMessage, '前の応答ですか？');
    assert.equal(tail.lastAssistantQuestion, true);
    assert.equal(tail.contextUsage.contextTokens, 3);
  });

  it('直近の依頼と応答は 180 文字で切る', () => {
    const lines = jsonl([
      userRecord('依'.repeat(200)),
      assistantRecord([{ type: 'text', text: '応'.repeat(200) }]),
    ]).split('\n');
    const tail = summarizeTail(lines);
    assert.equal(tail.lastUserMessage, '依'.repeat(180));
    assert.equal(tail.lastAssistantMessage, '応'.repeat(180));
  });

  it('空の入力では全項目が既定値', () => {
    assert.deepEqual(summarizeTail([]), {
      relocatedCwd: '',
      lastUserMessage: '',
      lastAssistantMessage: '',
      lastAssistantQuestion: false,
      lastTimestamp: '',
      contextUsage: null,
      turnState: null,
      awaySummary: null,
    });
  });

  it('away_summary は直近の 1 件だけを見て、中身が空なら古いものに戻らない', () => {
    const lines = [
      { type: 'system', subtype: 'away_summary', content: '古い要約', timestamp: 't1' },
      { type: 'system', subtype: 'away_summary', content: '  (disable recaps in /config)  ' },
    ].map((r) => JSON.stringify(r));
    assert.equal(summarizeTail(lines).awaySummary, null);
  });

  it('away_summary の content が文字列でなければ飛ばし、timestamp が無ければ空文字', () => {
    const lines = [
      { type: 'system', subtype: 'away_summary', content: '有効な要約' },
      { type: 'system', subtype: 'away_summary', content: { text: 'x' }, timestamp: 't2' },
      { type: 'user', subtype: 'away_summary', content: 'user の要約' },
    ].map((r) => JSON.stringify(r));
    assert.deepEqual(summarizeTail(lines).awaySummary, { text: '有効な要約', timestamp: '' });
  });

  it('away_summary は 300 文字で切り、末尾以外の (disable recaps in /config) は残す', () => {
    const long = '要'.repeat(400);
    assert.equal(
      summarizeTail([JSON.stringify({ type: 'system', subtype: 'away_summary', content: long })]).awaySummary.text,
      '要'.repeat(300),
    );
    const middle = summarizeTail([
      JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'A (disable recaps in /config) B' }),
    ]).awaySummary.text;
    assert.equal(middle, 'A (disable recaps in /config) B');
  });
});

describe('endsWithQuestion (境界)', () => {
  it('末尾の句点・感嘆符を剥がしてから言い回しを見る', () => {
    assert.equal(endsWithQuestion('進めますか.'), true);
    assert.equal(endsWithQuestion('進めますか！'), true);
    assert.equal(endsWithQuestion('進めますか．'), true);
    assert.equal(endsWithQuestion('進めますか!'), true);
    assert.equal(endsWithQuestion('**進めますか**。'), true);
  });

  it('疑問符の後ろの句点は剥がさない（疑問符で終わる判定は装飾だけ剥がす）', () => {
    assert.equal(endsWithQuestion('これでいい?。'), false);
  });

  it('疑問符の後ろの強調・コード・括弧は剥がす', () => {
    assert.equal(endsWithQuestion('どれ?*'), true);
    assert.equal(endsWithQuestion('どれ?_'), true);
    assert.equal(endsWithQuestion('どれ?`'), true);
    assert.equal(endsWithQuestion('（どれ？）'), true);
    assert.equal(endsWithQuestion('(どれ?)'), true);
    assert.equal(endsWithQuestion('[どれ?]'), true);
  });

  it('タグだけの本文は質問ではない', () => {
    assert.equal(endsWithQuestion('<b></b>'), false);
  });

  it('各言い回しで終わる文を質問とみなす', () => {
    for (const s of [
      '決めてください',
      '選んでください',
      '指定してください',
      'どちらにしますか',
      'どうしますか',
      'どれにしますか',
      'これでよいですか',
      'これでいいですか',
      'よろしいですか',
      'でしょうか',
      'ますか',
      '進めましょうか',
    ]) {
      assert.equal(endsWithQuestion(`前置き。${s}`), true, s);
    }
  });

  it('言い回しが文の途中にあるだけなら質問ではない', () => {
    assert.equal(endsWithQuestion('どうしますか、と聞かれたので実装しました'), false);
  });
});

describe('detectTurnState (境界)', () => {
  const prompt = (text = 'お願い') => ({ type: 'user', message: { role: 'user', content: text } });
  const toolUse = () => assistantRecord([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]);
  const toolResult = () => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1 };

  it('turn_duration の後なら tool_use の応答・tool_result でも ended', () => {
    assert.equal(detectTurnState([prompt(), toolUse(), turnEnd]), 'ended');
    assert.equal(detectTurnState([prompt(), toolUse(), toolResult(), turnEnd]), 'ended');
  });

  it('turn_duration 以外の system レコードはターンの終わりとみなさない', () => {
    assert.equal(detectTurnState([prompt(), toolUse(), { type: 'system', subtype: 'away_summary' }]), 'midway');
    assert.equal(detectTurnState([prompt(), { type: 'system', subtype: 'informational' }]), 'prompt');
  });

  it('turn_duration だけなら ended', () => {
    assert.equal(detectTurnState([turnEnd]), 'ended');
  });

  it('本文が文字列の中断も interrupted、meta の中断文は無視する', () => {
    assert.equal(
      detectTurnState([prompt(), toolUse(), prompt('[Request interrupted by user for tool use]')]),
      'interrupted',
    );
    const metaInterrupt = { ...prompt('[Request interrupted by user]'), isMeta: true };
    assert.equal(detectTurnState([prompt(), toolUse(), metaInterrupt]), 'midway');
  });

  it('content が配列でない assistant は tool_use を持たないものとして ended', () => {
    assert.equal(
      detectTurnState([prompt(), { type: 'assistant', message: { role: 'assistant', content: 'text' } }]),
      'ended',
    );
  });

  it('isApiErrorMessage が付いていれば本文に関わらず error', () => {
    assert.equal(detectTurnState([prompt(), { ...toolUse(), isApiErrorMessage: true }]), 'error');
  });

  it('API Error を途中に含むだけの応答は error にしない', () => {
    assert.equal(
      detectTurnState([prompt(), assistantRecord([{ type: 'text', text: 'ログに API Error が出ていました' }])]),
      'ended',
    );
  });
});

describe('findRelocatedCwd', () => {
  it('空・文字列でない relocatedCwd は飛ばして前の relocated を使う', () => {
    assert.equal(
      findRelocatedCwd([
        { type: 'relocated', relocatedCwd: '/repo-ok' },
        { type: 'relocated', relocatedCwd: '' },
        { type: 'relocated', relocatedCwd: 42 },
      ]),
      '/repo-ok',
    );
  });

  it('relocated 以外のレコードの relocatedCwd は見ない', () => {
    assert.equal(findRelocatedCwd([{ type: 'user', relocatedCwd: '/nope' }]), '');
  });

  it('worktree-state は最後の有効な originalCwd を使い、他の type は見ない', () => {
    assert.equal(
      findRelocatedCwd([
        { type: 'worktree-state', worktreeSession: { originalCwd: '/repo-old' } },
        { type: 'worktree-state', worktreeSession: { originalCwd: '/repo-new' } },
        { type: 'worktree-state', worktreeSession: { originalCwd: '' } },
        { type: 'other', worktreeSession: { originalCwd: '/nope' } },
      ]),
      '/repo-new',
    );
  });
});

describe('readSessionSummary (キャッシュと既定値)', () => {
  const EMPTY = {
    title: '',
    firstUserMessage: '',
    gitBranch: '',
    cwd: '',
    relocatedCwd: '',
    lastUserMessage: '',
    lastAssistantMessage: '',
    lastAssistantQuestion: false,
    lastTimestamp: '',
    contextUsage: null,
    turnState: null,
    awaySummary: null,
    artifacts: [],
  };

  it('読めないファイルは全項目が既定値のサマリを返す', async () => {
    assert.deepEqual(await readSessionSummary(join(tmpdir(), 'cb-nope-summary.jsonl')), EMPTY);
    const projects = join(tmpdir(), 'cb-nope-projects');
    assert.deepEqual(await readSessionSummaryFor('', 'sid', projects), EMPTY);
    assert.deepEqual(await readSessionSummaryFor('/home/me', '', projects), EMPTY);
  });

  it('mtime が変わらなければキャッシュを返し、変われば読み直す', async () => {
    const file = await tmpJsonl(jsonl([userRecord('最初の依頼')]));
    const mtime = new Date('2026-10-01T00:00:00.000Z');
    await utimes(file, mtime, mtime);
    const first = await readSessionSummary(file);
    assert.equal(await readSessionSummary(file), first);

    await appendFile(file, jsonl([userRecord('追加の依頼')]));
    // mtime を戻すとキャッシュのまま
    await utimes(file, mtime, mtime);
    assert.equal((await readSessionSummary(file)).lastUserMessage, '');

    const later = new Date(mtime.getTime() + 5000);
    await utimes(file, later, later);
    assert.equal((await readSessionSummary(file)).lastUserMessage, '追加の依頼');
  });

  it('先頭に指示もタイトルも無ければ、直近の指示をタイトルにする', async () => {
    // 先頭の読み込み（読み込みの塊 1 つ分）には入らない位置に指示を置く
    const padding = Array.from({ length: 45 }, (_, i) => ({ type: 'progress', i, pad: 'p'.repeat(10 * 1024) }));
    const file = await tmpJsonl(jsonl([...padding, userRecord('た'.repeat(150))]));
    const summary = await readSessionSummary(file);
    assert.equal(summary.firstUserMessage, '');
    assert.equal(summary.title, 'た'.repeat(100));
    assert.equal(summary.lastUserMessage, 'た'.repeat(150));
  });

  it('/rename のタイトルは均して 100 文字で切る', async () => {
    const file = await tmpJsonl(
      jsonl([{ type: 'custom-title', customTitle: `<b>名前</b>\n${'長'.repeat(150)}` }, userRecord('依頼')]),
    );
    assert.equal((await readSessionSummary(file)).title, `名前 ${'長'.repeat(97)}`);
  });

  it('直近の依頼が冒頭と違えばそのまま出す', async () => {
    const file = await tmpJsonl(jsonl([userRecord('最初'), userRecord('最後')]));
    const summary = await readSessionSummary(file);
    assert.equal(summary.firstUserMessage, '最初');
    assert.equal(summary.lastUserMessage, '最後');
  });
});

describe('userPrompt・detectTurnState (前後の空白)', () => {
  it('前に空白があってもタグ注入・他セッションからの送信は指示にしない', () => {
    assert.equal(userPrompt(userRecord('  <command-name>/x</command-name>')), '');
    assert.equal(userPrompt(userRecord('\nAnother Claude session sent a message: 報告')), '');
  });

  it('前に空白のある API Error・中断も見分ける', () => {
    const prompt = { type: 'user', message: { role: 'user', content: 'お願い' } };
    assert.equal(detectTurnState([prompt, assistantRecord([{ type: 'text', text: '  API Error: 500' }])]), 'error');
    assert.equal(
      detectTurnState([
        prompt,
        { type: 'user', message: { role: 'user', content: '  [Request interrupted by user]' } },
      ]),
      'interrupted',
    );
  });
});

describe('detectTurnState (レコードの種類)', () => {
  const prompt = (text = 'お願い') => ({ type: 'user', message: { role: 'user', content: text } });
  const toolResult = () => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1 };

  it('本文と tool_use の両方を持つ応答で止まっていれば midway', () => {
    const reply = assistantRecord([
      { type: 'text', text: '読みます' },
      { type: 'tool_use', id: 't', name: 'Read', input: {} },
    ]);
    assert.equal(detectTurnState([prompt(), reply]), 'midway');
  });

  it('指示の直後の tool_result で止まっていれば midway（その前の指示までは遡らない）', () => {
    assert.equal(detectTurnState([prompt(), toolResult()]), 'midway');
  });

  it('turn_duration の後の指示は ended', () => {
    assert.equal(detectTurnState([prompt(), turnEnd]), 'ended');
  });

  it('user・assistant・system 以外のレコードは判定に使わない', () => {
    const progress = { type: 'progress', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } };
    const reply = assistantRecord([{ type: 'text', text: '終わりました' }]);
    assert.equal(detectTurnState([prompt(), reply, progress]), 'ended');
    const attachment = { type: 'attachment', message: { role: 'user', content: '[Request interrupted by user]' } };
    assert.equal(detectTurnState([prompt(), reply, attachment]), 'ended');
  });
});

describe('summarizeHead・summarizeTail・findRelocatedCwd (種類と型の確認)', () => {
  it('ai-title・last-prompt 以外のレコードの aiTitle・lastPrompt は見ない', () => {
    const lines = jsonl([
      { type: 'mode', aiTitle: '偽のタイトル', lastPrompt: '偽の指示' },
      { type: 'last-prompt', lastPrompt: '本当の指示' },
    ]).split('\n');
    const head = summarizeHead(lines);
    assert.equal(head.title, '本当の指示');
    assert.equal(head.firstUserMessage, '本当の指示');
  });

  it('文字列でない originalCwd は飛ばす', () => {
    assert.equal(
      findRelocatedCwd([
        { type: 'worktree-state', worktreeSession: { originalCwd: '/repo' } },
        { type: 'worktree-state', worktreeSession: { originalCwd: 42 } },
      ]),
      '/repo',
    );
  });

  it('空白だけの応答は質問判定に使わず、その前の本文で見る', () => {
    const lines = jsonl([
      userRecord('相談'),
      assistantRecord([{ type: 'text', text: 'どうしますか？' }]),
      assistantRecord([{ type: 'text', text: '   ' }]),
    ]).split('\n');
    assert.equal(summarizeTail(lines).lastAssistantQuestion, true);
  });

  it('away_summary 以外の system レコードの content は要約にしない', () => {
    const lines = [
      { type: 'system', subtype: 'away_summary', content: '本当の要約' },
      { type: 'system', subtype: 'informational', content: '別の system' },
    ].map((r) => JSON.stringify(r));
    assert.equal(summarizeTail(lines).awaySummary.text, '本当の要約');
  });

  it('直近の応答に時刻と usage があっても、それより前の依頼まで遡る', () => {
    const lines = jsonl([
      userRecord('依頼', { timestamp: '2026-10-05T00:00:00.000Z' }),
      {
        type: 'assistant',
        timestamp: '2026-10-05T00:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '応答' }], usage: { input_tokens: 7 } },
      },
    ]).split('\n');
    const tail = summarizeTail(lines);
    assert.equal(tail.lastUserMessage, '依頼');
    assert.equal(tail.lastAssistantMessage, '応答');
    assert.equal(tail.contextUsage.contextTokens, 7);
  });

  it('タグだけの直近の応答は抜粋にならないので、その前の応答まで遡る', () => {
    const lines = jsonl([
      assistantRecord([{ type: 'text', text: '古い応答' }]),
      userRecord('依頼', { timestamp: '2026-10-05T00:00:00.000Z' }),
      {
        type: 'assistant',
        timestamp: '2026-10-05T00:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '<b></b>' }], usage: { input_tokens: 7 } },
      },
    ]).split('\n');
    assert.equal(summarizeTail(lines).lastAssistantMessage, '古い応答');
  });
});

describe('readSessionSummaryFor (引数の確認)', () => {
  it('cwd・sessionId のどちらかが空なら、そのパスにファイルがあっても読まない', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'cb-projects-'));
    createdDirs.push(projects);
    // cwd が空なら <projects>/<sessionId>.jsonl、sessionId が空なら <projects>/-home-me/.jsonl に解決される
    await writeFile(join(projects, 'sid.jsonl'), jsonl([{ type: 'ai-title', aiTitle: '読まれてはいけない' }]));
    await mkdir(join(projects, '-home-me'));
    await writeFile(join(projects, '-home-me', '.jsonl'), jsonl([{ type: 'ai-title', aiTitle: '読まれてはいけない' }]));
    assert.equal((await readSessionSummaryFor('', 'sid', projects)).title, '');
    assert.equal((await readSessionSummaryFor('/home/me', '', projects)).title, '');
  });
});

describe('readSessionSummary (キャッシュの上限)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('500 件を超えて読むと一度キャッシュを捨てる', async () => {
    vi.resetModules();
    const mod = await import('../server/session-summary.js');
    const dir = await mkdtemp(join(tmpdir(), 'cb-summary-cache-'));
    createdDirs.push(dir);
    const fixed = new Date('2026-10-01T00:00:00.000Z');
    const target = join(dir, 'target.jsonl');
    await writeFile(target, jsonl([userRecord('指示A')]));
    await utimes(target, fixed, fixed);
    assert.equal((await mod.readSessionSummary(target)).title, '指示A');
    // 同じサイズ・同じ mtime で書き換える（キャッシュが残っていれば古い内容が返る）
    await writeFile(target, jsonl([userRecord('指示B')]));
    await utimes(target, fixed, fixed);

    const others = [];
    for (let i = 0; i < 500; i++) {
      const file = join(dir, `s${i}.jsonl`);
      await writeFile(file, jsonl([userRecord(`作業 ${i}`)]));
      others.push(file);
    }
    // target を含めて 500 件まではキャッシュに残る
    for (const file of others.slice(0, 499)) await mod.readSessionSummary(file);
    assert.equal((await mod.readSessionSummary(target)).title, '指示A');
    // 501 件目を足すときに捨てる
    await mod.readSessionSummary(others[499]);
    assert.equal((await mod.readSessionSummary(target)).title, '指示B');
  });
});
