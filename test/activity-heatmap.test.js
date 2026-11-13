import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, appendFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_CALL_MS,
  SLOT_MS,
  accumulateBusy,
  adjustAutoTools,
  allocateApprovedTools,
  emptyBusyState,
  getActivityCalendar,
  getActivityHeatmap,
  listActiveSessionIds,
  noteCostState,
  resetActivityHeatmapState,
  settleStaleBusy,
  warmActivityCache,
} from '../server/activity-heatmap.js';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ローカルタイムの YYYY-MM-DD（集計側と同じ切り方）
const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ローカルのその日の正午を ISO で（日付境界をまたがない時刻を選ぶ）
const noonIso = (daysAgo, now) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

const prompt = (ts, text = 'やって') => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const toolResult = (ts) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
});

const reply = (ts, usage) => ({
  type: 'assistant',
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text: 'はい' }], usage },
});

const usage = (input, output, create = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
});

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'cb-heatmap-'));
  const dir = join(root, 'projects');
  await mkdir(dir, { recursive: true });
  return { root, dir, cacheFile: join(root, 'cache.json') };
}

const findDay = (result, date) => result.days.find((d) => d.date === date);

describe('getActivityHeatmap', () => {
  beforeEach(() => resetActivityHeatmapState());

  it('counts user prompts and assistant replies per local day', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const yesterday = noonIso(1, now);
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(
      join(dir, '-home-me-a', 's1.jsonl'),
      jsonl([prompt(today), reply(today, usage(1, 2)), reply(today, usage(3, 4)), prompt(yesterday)]),
    );

    const result = await getActivityHeatmap({ days: 30, dir, cacheFile, now });
    const t = findDay(result, dateKey(new Date(now)));
    assert.equal(t.prompts, 1);
    assert.equal(t.replies, 2);
    assert.equal(t.messages, 3);
    const y = findDay(result, dateKey(new Date(now - 86400000)));
    assert.equal(y.messages, 1);
  });

  it('ignores tool_result records (they are not something the user typed)', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([prompt(today), toolResult(today), toolResult(today)]));

    const result = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(result, dateKey(new Date(now))).prompts, 1);
  });

  it('sums every token bucket', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([reply(today, usage(10, 20, 30, 40))]));

    const day = findDay(await getActivityHeatmap({ days: 7, dir, cacheFile, now }), dateKey(new Date(now)));
    assert.deepEqual(
      {
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheCreationTokens: day.cacheCreationTokens,
        cacheReadTokens: day.cacheReadTokens,
        tokens: day.tokens,
      },
      { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, tokens: 100 },
    );
  });

  it('counts the usage of one API response only once even when it spans several lines', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    // 1 回の応答が thinking / text / tool_use の 3 行に分かれ、各行に同じ usage がコピーされる。
    // 間に tool_result（user）や attachment が挟まっても同じ応答として扱う
    const same = (content) => ({
      ...reply(today, usage(10, 20, 30, 40)),
      message: { ...reply(today).message, id: 'msg_1', content, usage: usage(10, 20, 30, 40) },
      requestId: 'req_1',
    });
    const other = {
      ...reply(today, usage(1, 2, 3, 4)),
      message: { ...reply(today).message, id: 'msg_2', usage: usage(1, 2, 3, 4) },
      requestId: 'req_2',
    };
    await writeFile(
      join(dir, '-home-me-a', 's1.jsonl'),
      jsonl([
        same([{ type: 'thinking', thinking: '…' }]),
        same([{ type: 'text', text: 'はい' }]),
        same([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]),
        toolResult(today),
        { type: 'attachment', timestamp: today },
        same([{ type: 'tool_use', id: 'y', name: 'Read', input: {} }]),
        other,
      ]),
    );

    const day = findDay(await getActivityHeatmap({ days: 7, dir, cacheFile, now }), dateKey(new Date(now)));
    // 応答数は行ごと（従来どおり）、トークンは応答ごと
    assert.equal(day.replies, 5);
    assert.deepEqual(
      { input: day.inputTokens, output: day.outputTokens, create: day.cacheCreationTokens, read: day.cacheReadTokens },
      { input: 11, output: 22, create: 33, read: 44 },
    );
  });

  it('does not double count a response whose lines straddle an incremental scan', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    const line = {
      ...reply(today, usage(10, 20)),
      message: { ...reply(today).message, id: 'msg_1', usage: usage(10, 20) },
      requestId: 'req_1',
    };
    await writeFile(file, jsonl([line]));
    const first = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(first, dateKey(new Date(now))).tokens, 30);

    // 同じ応答の続きの行が後から書き足されても、キャッシュが前回のキーを覚えているので足さない
    resetActivityHeatmapState();
    await appendFile(file, jsonl([line]));
    const second = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(second, dateKey(new Date(now))).replies, 2);
    assert.equal(findDay(second, dateKey(new Date(now))).tokens, 30);
  });

  it('keeps summing every line when records carry no message.id (old format)', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([reply(today, usage(1, 1)), reply(today, usage(1, 1))]));

    const day = findDay(await getActivityHeatmap({ days: 7, dir, cacheFile, now }), dateKey(new Date(now)));
    assert.equal(day.tokens, 4);
  });

  it('includes subagent transcripts', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const subDir = join(dir, '-home-me-a', 's1', 'subagents');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([reply(today, usage(1, 1))]));
    await writeFile(join(subDir, 'agent-abc.jsonl'), jsonl([reply(today, usage(5, 5))]));

    const day = findDay(await getActivityHeatmap({ days: 7, dir, cacheFile, now }), dateKey(new Date(now)));
    assert.equal(day.replies, 2);
    assert.equal(day.tokens, 12);
  });

  it('picks up appended lines without recounting the whole file', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(file, jsonl([reply(today, usage(1, 1))]));

    const first = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(first, dateKey(new Date(now))).replies, 1);
    assert.equal(first.scannedFiles, 1);

    resetActivityHeatmapState();
    await appendFile(file, jsonl([reply(today, usage(2, 2))]));
    const second = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(second, dateKey(new Date(now))).replies, 2);
    assert.equal(findDay(second, dateKey(new Date(now))).tokens, 6);

    // 追記の無いラウンドではファイルを読み直さない
    resetActivityHeatmapState();
    const third = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(third.scannedFiles, 0);
    assert.equal(findDay(third, dateKey(new Date(now))).replies, 2);
  });

  it('does not count a half-written trailing line twice', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    const complete = JSON.stringify(reply(today, usage(1, 1))) + '\n';
    const partial = JSON.stringify(reply(today, usage(9, 9)));
    await writeFile(file, complete + partial.slice(0, 20));

    const first = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(first, dateKey(new Date(now))).replies, 1);

    // 書きかけの行が完成したら、その 1 行分だけ増える
    resetActivityHeatmapState();
    await writeFile(file, complete + partial + '\n');
    const second = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(second, dateKey(new Date(now))).replies, 2);
    assert.equal(findDay(second, dateKey(new Date(now))).tokens, 20);
  });

  it('rescans from the start when a file shrinks', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    const today = noonIso(0, now);
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(file, jsonl([reply(today, usage(1, 1)), reply(today, usage(1, 1))]));
    await getActivityHeatmap({ days: 7, dir, cacheFile, now });

    resetActivityHeatmapState();
    await writeFile(file, jsonl([reply(today, usage(5, 5))]));
    const result = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(findDay(result, dateKey(new Date(now))).replies, 1);
    assert.equal(findDay(result, dateKey(new Date(now))).tokens, 10);
  });

  it('drops days outside the requested window but keeps every day inside it', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(
      join(dir, '-home-me-a', 's1.jsonl'),
      jsonl([reply(noonIso(2, now), usage(1, 1)), reply(noonIso(100, now), usage(1, 1))]),
    );

    const result = await getActivityHeatmap({ days: 7, dir, cacheFile, now });
    assert.equal(result.days.length, 7);
    assert.equal(result.total.replies, 1);
    assert.equal(result.total.activeDays, 1);
    // 活動のない日も升目として残る
    assert.equal(findDay(result, dateKey(new Date(now))).messages, 0);
  });

  it('returns an all-zero range when there are no sessions', async () => {
    const { dir, cacheFile } = await makeEnv();
    const result = await getActivityHeatmap({ days: 14, dir, cacheFile });
    assert.equal(result.days.length, 14);
    assert.equal(result.total.messages, 0);
    assert.equal(result.total.tokens, 0);
  });
});

describe('listActiveSessionIds', () => {
  beforeEach(() => resetActivityHeatmapState());

  it('returns only the sessions that were active inside the period', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await mkdir(join(dir, '-home-me-b'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'today.jsonl'), jsonl([prompt(noonIso(0, now))]));
    await writeFile(join(dir, '-home-me-b', 'old.jsonl'), jsonl([prompt(noonIso(10, now))]));

    const today = dateKey(new Date(now));
    const ids = await listActiveSessionIds({ from: today, to: today, dir, cacheFile });
    assert.deepEqual([...ids], ['today']);
  });

  it('attributes subagent activity to the parent session', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    await mkdir(join(dir, '-home-me-a', 'parent', 'subagents'), { recursive: true });
    await writeFile(
      join(dir, '-home-me-a', 'parent', 'subagents', 'agent-abc.jsonl'),
      jsonl([prompt(noonIso(0, now))]),
    );

    const today = dateKey(new Date(now));
    const ids = await listActiveSessionIds({ from: today, to: today, dir, cacheFile });
    assert.deepEqual([...ids], ['parent']);
  });

  it('includes a session that was active on any day of the period', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    // 期間の外（今日）にも活動があるが、期間内（3 日前）の活動で拾われる
    await writeFile(
      join(dir, '-home-me-a', 'spanning.jsonl'),
      jsonl([prompt(noonIso(3, now)), prompt(noonIso(0, now))]),
    );

    const from = dateKey(new Date(now - 4 * 86400000));
    const to = dateKey(new Date(now - 2 * 86400000));
    const ids = await listActiveSessionIds({ from, to, dir, cacheFile });
    assert.deepEqual([...ids], ['spanning']);
  });

  it('returns an empty set when nothing happened in the period', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = Date.now();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([prompt(noonIso(0, now))]));

    const past = dateKey(new Date(now - 30 * 86400000));
    const ids = await listActiveSessionIds({ from: past, to: past, dir, cacheFile });
    assert.equal(ids.size, 0);
  });
});

describe('getActivityCalendar', () => {
  beforeEach(() => resetActivityHeatmapState());

  // 枠の境界ちょうどの時刻（ISO）。テストを TZ に依存させないため UTC の枠で組み立てる
  const BASE = Math.floor(Date.UTC(2026, 9, 1, 3, 0) / SLOT_MS) * SLOT_MS;
  const at = (minutes) => new Date(BASE + minutes * 60000).toISOString();
  const toolUse = (ts, ...names) => ({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: names.map((name) => ({ type: 'tool_use', name, input: {} })) },
  });
  const range = { fromMs: BASE - 60 * 60000, toMs: BASE + 24 * 60 * 60000 };

  it('aggregates prompts, replies and tool kinds into 10-minute slots', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(
      join(dir, '-home-me-a', 's1.jsonl'),
      jsonl([
        { type: 'ai-title', aiTitle: 'カレンダー', cwd: '/home/me/a' },
        { ...prompt(at(1)), cwd: '/home/me/a' },
        toolUse(at(2), 'Read', 'Grep'),
        toolUse(at(3), 'Edit'),
        toolResult(at(4)),
        reply(at(25), usage(1, 1)),
      ]),
    );

    const result = await getActivityCalendar({ ...range, dir, cacheFile });
    assert.equal(result.slotMs, SLOT_MS);
    assert.equal(result.sessions.length, 1);
    const [session] = result.sessions;
    assert.equal(session.sessionId, 's1');
    assert.equal(session.projectDir, '-home-me-a');
    assert.equal(session.cwd, '/home/me/a');
    assert.equal(session.title, 'カレンダー');
    const base = BASE / SLOT_MS;
    // 6 列目は AI 稼働 ms（7 列目は自動ツール ms、8 列目は人の許可回数、9 列目は未検証ツール ms）。id の無い tool_use は結果と結べないので推論だけ:
    // 1→2 分・2→3 分（直前の別応答の時刻が下限）・4→25 分（上限 10 分で 4→14 分）を枠に按分
    assert.deepEqual(session.slots, [
      [base, 1, 2, 2, 1, 480000, 0, 0, 0],
      [base + 1, 0, 0, 0, 0, 240000, 0, 0, 0],
      [base + 2, 0, 1, 0, 0, 0, 0, 0, 0],
    ]); // 指示した時刻は分単位（at(1) = BASE の 1 分後）
    assert.equal(result.minuteMs, 60000);
    assert.deepEqual(session.prompts, [[BASE / 60000 + 1, 1]]);
  });

  it('marks only human prompts by minute, counting several in the same minute', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    const text = (ts, content) => ({ type: 'user', timestamp: ts, message: { role: 'user', content } });
    await writeFile(
      join(dir, '-home-me-a', 's1.jsonl'),
      jsonl([
        text(at(5), 'お願い'),
        text(new Date(BASE + 5 * 60000 + 30000).toISOString(), 'もう 1 つ'), // 同じ 5 分目
        text(at(7), '<command-message>ship</command-message>\n<command-name>/ship</command-name>'),
        text(at(8), '<task-notification>done</task-notification>'),
        text(at(9), '[Request interrupted by user]'),
        { ...text(at(10), 'meta'), isMeta: true },
        toolResult(at(11)),
      ]),
    );

    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    const minute = BASE / 60000;
    assert.deepEqual(sessions[0].prompts, [
      [minute + 5, 2],
      [minute + 7, 1],
    ]);
  });

  it('does not mark the tasks a parent handed to its subagents', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a', 'parent', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'parent.jsonl'), jsonl([prompt(at(1))]));
    await writeFile(join(dir, '-home-me-a', 'parent', 'subagents', 'agent-x.jsonl'), jsonl([prompt(at(3), '調べて')]));

    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    assert.deepEqual(sessions[0].prompts, [[BASE / 60000 + 1, 1]]);
  });

  it('only returns prompts inside the requested range', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([prompt(at(0)), prompt(at(15))]));

    const { sessions } = await getActivityCalendar({ fromMs: BASE, toMs: BASE + SLOT_MS, dir, cacheFile });
    assert.deepEqual(sessions[0].prompts, [[BASE / 60000, 1]]);
  });

  it('merges subagent slots into the parent session', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a', 'parent', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'parent.jsonl'), jsonl([prompt(at(1))]));
    await writeFile(
      join(dir, '-home-me-a', 'parent', 'subagents', 'agent-x.jsonl'),
      jsonl([toolUse(at(2), 'Read'), toolUse(at(15), 'Write')]),
    );

    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    assert.equal(sessions.length, 1);
    const base = BASE / SLOT_MS;
    // サブエージェントの稼働（2→15 分の応答、上限 10 分で 2→12 分）も親に足す
    assert.deepEqual(sessions[0].slots, [
      [base, 1, 1, 1, 0, 480000, 0, 0, 0],
      [base + 1, 0, 1, 0, 1, 120000, 0, 0, 0],
    ]);
  });

  it('only returns slots inside the requested range', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'in.jsonl'), jsonl([prompt(at(0)), prompt(at(60 * 30))]));
    await writeFile(join(dir, '-home-me-a', 'out.jsonl'), jsonl([prompt(at(-60 * 5))]));

    const { sessions } = await getActivityCalendar({ fromMs: BASE, toMs: BASE + SLOT_MS, dir, cacheFile });
    assert.deepEqual(
      sessions.map((s) => [s.sessionId, s.slots.length]),
      [['in', 1]],
    );
  });

  it('keeps subagent-only activity even when the main transcript is missing', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a', 'gone', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'gone', 'subagents', 'agent-x.jsonl'), jsonl([prompt(at(0))]));

    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, '');
    assert.equal(sessions[0].cwd, '');
  });

  it('adds appended activity on the next call', async () => {
    const { dir, cacheFile } = await makeEnv();
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(file, jsonl([prompt(at(0))]));
    await getActivityCalendar({ ...range, dir, cacheFile });

    resetActivityHeatmapState();
    await appendFile(file, jsonl([prompt(at(5)), prompt(at(40))]));
    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    const base = BASE / SLOT_MS;
    assert.deepEqual(
      sessions[0].slots.map((s) => [s[0], s[1]]),
      [
        [base, 2],
        [base + 4, 1],
      ],
    );
  });
});

describe('AI busy time (accumulateBusy)', () => {
  beforeEach(() => resetActivityHeatmapState());

  const BASE = Math.floor(Date.UTC(2026, 9, 1, 3, 0) / SLOT_MS) * SLOT_MS;
  const sec = (s) => new Date(BASE + s * 1000).toISOString();
  const human = (s) => ({ type: 'user', timestamp: sec(s), message: { content: [{ type: 'text', text: 'やって' }] } });
  // 1 回の応答の 1 ブロック（requestId が同じ行は同じ応答）
  const block = (s, requestId, content = [{ type: 'text', text: 'はい' }]) => ({
    type: 'assistant',
    timestamp: sec(s),
    requestId,
    message: { id: `msg-${requestId}`, content },
  });
  const use = (id, name) => ({ type: 'tool_use', id, name, input: {} });
  const result = (s, ids, toolUseResult) => ({
    type: 'user',
    timestamp: sec(s),
    message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
    ...(toolUseResult ? { toolUseResult } : {}),
  });

  // 応答の終わりはその後のレコードが来るまで確定せず、ツールの時間は確定まで保留されるので、末尾に人の指示を足して閉じる
  const closed = (records) => [...records, human(1e6)];
  const totalBusy = (records) => {
    const state = emptyBusyState();
    const slots = {};
    for (const record of closed(records)) accumulateBusy(record, state, slots);
    return Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);
  };

  it('counts one API response once even when it is split into several lines', () => {
    // 指示 0s → 応答 r1 が 3 行（5s, 8s, 10s）→ 推論は 0〜10s の 10 秒
    assert.equal(totalBusy([human(0), block(5, 'r1'), block(8, 'r1'), block(10, 'r1')]), 10000);
  });

  it('uses the previous response as the lower bound when two responses are back to back', () => {
    // r1: 0〜4s、r2 は直前が assistant（4s）なので 4〜9s
    assert.equal(totalBusy([human(0), block(4, 'r1'), block(9, 'r2')]), 9000);
  });

  it('adds parallel tool calls separately (not wall clock)', () => {
    const records = [
      human(0),
      block(2, 'r1', [use('a', 'Bash')]),
      block(2, 'r1', [use('b', 'Bash')]),
      result(12, ['a']),
      result(22, ['b']),
    ];
    // 推論 2 秒 + Bash a 10 秒 + Bash b 20 秒
    assert.equal(totalBusy(records), 2000 + 10000 + 20000);
  });

  it('prefers toolUseResult.durationMs over the timestamp difference', () => {
    const records = [human(0), block(2, 'r1', [use('a', 'Bash')]), result(62, ['a'], { durationMs: 7000 })];
    assert.equal(totalBusy(records), 2000 + 7000);
  });

  it('caps one inference at 10 minutes, but not tools at scan time', () => {
    assert.equal(totalBusy([human(0), block(3600, 'r1')]), MAX_CALL_MS);
    // ツールは走査時は上限なし（未検証の分は集計時に実測で縮めるか、実測が無ければ上限を当てる）
    const records = [human(0), block(1, 'r1', [use('a', 'Bash')]), result(1 + 3600, ['a'])];
    assert.equal(totalBusy(records), 1000 + 3600 * 1000);
  });

  it('does not count waiting for an answer to AskUserQuestion / ExitPlanMode', () => {
    const records = [
      human(0),
      block(2, 'r1', [use('q', 'AskUserQuestion')]),
      result(2000, ['q']),
      block(2005, 'r2', [use('p', 'ExitPlanMode')]),
      result(2300, ['p']),
    ];
    // 推論 2 秒 + 結果の後の推論 5 秒だけ
    assert.equal(totalBusy(records), 7000);
  });

  const decided = (record, source) => ({ ...record, permissionDecision: { decision: 'accept', source } });
  const longBash = (resultRecord) => [human(0), block(1, 'r1', [use('a', 'Bash')]), resultRecord];
  const HOUR = 3600;

  it('counts the whole tool run without a cap when the permission was decided by config', () => {
    assert.equal(totalBusy(longBash(decided(result(1 + HOUR, ['a']), 'config'))), 1000 + HOUR * 1000);
  });

  it('skips a tool run that a human allowed or rejected (user_*)', () => {
    assert.equal(totalBusy(longBash(decided(result(1 + 30, ['a']), 'user_temporary'))), 1000);
    assert.equal(totalBusy(longBash(decided(result(1 + 30, ['a']), 'user_reject'))), 1000);
  });

  it('applies the record-level decision to every tool_result in the record', () => {
    const records = [
      human(0),
      block(1, 'r1', [use('a', 'Bash')]),
      block(1, 'r1', [use('b', 'Bash')]),
      decided(result(1 + HOUR, ['a', 'b']), 'config'),
    ];
    assert.equal(totalBusy(records), 1000 + 2 * HOUR * 1000);
  });

  it('records automatic tools (unverified and config) as shrinkable, but not measured ones', () => {
    const state = emptyBusyState();
    const slots = {};
    for (const r of closed(longBash(result(1 + HOUR, ['a'])))) accumulateBusy(r, state, slots);
    assert.deepEqual(state.autoTools, [[BASE + 1000, BASE + (1 + HOUR) * 1000, 1]]); // 未検証
    const sum = (col) => Object.values(slots).reduce((total, cell) => total + cell[col], 0);
    assert.equal(sum(4), 1000 + HOUR * 1000);
    assert.equal(sum(7), HOUR * 1000);
    // config（10/8 以降の自動許可）も縮める対象（未検証の印は 0）。durationMs のある呼び出しは実測なので対象外
    const decidedState = emptyBusyState();
    for (const r of closed(longBash(decided(result(1 + HOUR, ['a']), 'config')))) accumulateBusy(r, decidedState, {});
    const reportedState = emptyBusyState();
    for (const r of closed(longBash(result(1 + HOUR, ['a'], { durationMs: 5000 })))) {
      accumulateBusy(r, reportedState, {});
    }
    assert.deepEqual(decidedState.autoTools, [[BASE + 1000, BASE + (1 + HOUR) * 1000, 0]]);
    assert.deepEqual(reportedState.autoTools, []);
  });

  it('skips a tool run the human rejected (old records without a decision)', () => {
    const rejected = {
      type: 'user',
      timestamp: sec(1 + 30),
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            is_error: true,
            content: [{ type: 'text', text: "The user doesn't want to proceed with this tool use." }],
          },
        ],
      },
    };
    assert.equal(totalBusy(longBash(rejected)), 1000);
  });

  it('does not cap toolUseResult.durationMs', () => {
    assert.equal(totalBusy(longBash(result(1 + 2 * HOUR, ['a'], { durationMs: HOUR * 1000 }))), 1000 + HOUR * 1000);
  });

  it('reports the uncapped and user-skipped time to stats', () => {
    const state = emptyBusyState();
    const stats = { uncappedMs: 0, userSkippedMs: 0 };
    const records = [
      ...longBash(decided(result(1 + HOUR, ['a']), 'config')),
      block(HOUR + 2, 'r2', [use('b', 'Bash')]),
      decided(result(HOUR + 32, ['b']), 'user_temporary'),
    ];
    for (const r of records) accumulateBusy(r, state, {}, stats);
    assert.deepEqual(stats, { uncappedMs: HOUR * 1000 - MAX_CALL_MS, userSkippedMs: 30000 });
  });

  it('spreads a long call over every 10-minute slot it spans', () => {
    const state = emptyBusyState();
    const slots = {};
    // 5 分目から 9 分間の Bash → 5 分ぶん + 4 分ぶん
    for (const r of closed([human(300), block(300, 'r1', [use('a', 'Bash')]), result(300 + 540, ['a'])])) {
      accumulateBusy(r, state, slots);
    }
    const base = BASE / SLOT_MS;
    assert.deepEqual(
      Object.entries(slots).map(([k, cell]) => [Number(k) - base, cell[4]]),
      [
        [0, 300000],
        [1, 240000],
      ],
    );
  });

  it('gives the same result when the incremental scan is cut anywhere', async () => {
    const records = [
      human(0),
      block(3, 'r1'),
      block(7, 'r1', [use('a', 'Bash'), use('q', 'AskUserQuestion')]),
      block(9, 'r1', [use('b', 'Read')]),
      result(30, ['a']),
      result(500, ['q']),
      result(31, ['b'], { durationMs: 4000 }),
      block(700, 'r2'),
      block(1400, 'r2'),
      human(5000),
      block(5100, 'r3'),
      // 未検証ツールの区間も走査の切れ目をまたいで引き継ぎ、集計時に cost-state で縮める
      block(5200, 'r4', [use('c', 'Bash')]),
      result(5200 + 1800, ['c']),
      block(7100, 'r5', [use('d', 'Bash')]),
      result(7100 + 1800, ['d']),
      block(8950, 'r6', [use('e', 'Bash')]),
      decided(result(8950 + 1800, ['e']), 'config'),
      // 人の許可ツールと cost-state（配分）も切れ目をまたいで同じになる
      block(10800, 'r7', [use('f', 'Bash')]),
      decided(result(10800 + 30, ['f']), 'user_temporary'),
      { type: 'cost-state', startTime: BASE, totalToolDuration: 10_000_000, totalDuration: 20_000_000 },
      { type: 'cost-state', startTime: BASE, totalToolDuration: 2_000_000, totalDuration: 20_000_000 },
    ];
    const once = await (async () => {
      const { dir, cacheFile } = await makeEnv();
      await mkdir(join(dir, '-home-me-a'), { recursive: true });
      await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl(records));
      const { sessions } = await getActivityCalendar({ fromMs: BASE - 3600000, toMs: BASE + 86400000, dir, cacheFile });
      return sessions[0].slots;
    })();
    for (let cut = 1; cut < records.length; cut++) {
      resetActivityHeatmapState();
      const { dir, cacheFile } = await makeEnv();
      const file = join(dir, '-home-me-a', 's1.jsonl');
      await mkdir(join(dir, '-home-me-a'), { recursive: true });
      await writeFile(file, jsonl(records.slice(0, cut)));
      const range = { fromMs: BASE - 3600000, toMs: BASE + 86400000, dir, cacheFile };
      await getActivityCalendar(range);
      resetActivityHeatmapState();
      await appendFile(file, jsonl(records.slice(cut)));
      const { sessions } = await getActivityCalendar(range);
      assert.deepEqual(sessions[0].slots, once, `cut at ${cut}`);
    }
  });

  it('adds the busy time of subagents to the parent session', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a', 'parent', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 'parent.jsonl'), jsonl([human(0), block(10, 'p1')]));
    await writeFile(
      join(dir, '-home-me-a', 'parent', 'subagents', 'agent-x.jsonl'),
      jsonl([human(20), block(50, 's1')]),
    );
    const { sessions } = await getActivityCalendar({ fromMs: BASE, toMs: BASE + SLOT_MS, dir, cacheFile });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].slots[0][5], 10000 + 30000);
  });
});

describe('approved tools (human permission)', () => {
  beforeEach(() => resetActivityHeatmapState());

  const BASE = Math.floor(Date.UTC(2026, 10, 1, 3, 0) / SLOT_MS) * SLOT_MS;
  const ms = (s) => BASE + s * 1000;
  const sec = (s) => new Date(ms(s)).toISOString();
  const human = (s) => ({ type: 'user', timestamp: sec(s), message: { content: [{ type: 'text', text: 'やって' }] } });
  const block = (s, requestId, content = [{ type: 'text', text: 'はい' }]) => ({
    type: 'assistant',
    timestamp: sec(s),
    requestId,
    message: { id: `msg-${requestId}`, content },
  });
  const use = (id, name = 'Bash') => ({ type: 'tool_use', id, name, input: {} });
  const result = (s, id, decision) => ({
    type: 'user',
    timestamp: sec(s),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    ...(decision ? { permissionDecision: decision } : {}),
  });
  const ACCEPT = { decision: 'accept', source: 'user_temporary', grantScope: 'once' };
  const REJECT = { decision: 'reject', source: 'user_reject' };
  const CONFIG = { decision: 'accept', source: 'config', reasonType: 'classifier' };
  const costState = (startS, toolMs, durationS) => ({
    type: 'cost-state',
    startTime: ms(startS),
    totalToolDuration: toolMs,
    totalDuration: durationS * 1000,
  });
  const range = { fromMs: BASE - 3600000, toMs: BASE + 86400000 };

  async function calendar(records, subRecords) {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a', 's1', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl(records));
    if (subRecords) await writeFile(join(dir, '-home-me-a', 's1', 'subagents', 'agent-x.jsonl'), jsonl(subRecords));
    const { sessions } = await getActivityCalendar({ ...range, dir, cacheFile });
    return sessions[0];
  }
  const sumCol = (session, col) => session.slots.reduce((sum, slot) => sum + slot[col], 0);

  it('allocates the measured tool time to a human-approved tool, right before its result', async () => {
    // perm-test と同じ形: 自動ツールなし、許可待ち込みで 25.2 秒、cost-state の tool は 5230ms
    const records = [
      human(0),
      block(2, 'r1', [use('a')]),
      result(27.2, 'a', ACCEPT),
      block(30, 'r2'),
      costState(-1, 5230, 100),
    ];
    const withCost = await calendar(records);
    resetActivityHeatmapState();
    const without = await calendar(records.slice(0, -1));
    // 推論（0→2 秒と 27.2→30 秒）だけが共通で、差が配分
    assert.equal(sumCol(without, 5), 2000 + 2800);
    assert.equal(sumCol(withCost, 5) - sumCol(without, 5), 5230);
    assert.equal(sumCol(withCost, 7), 1); // 許可 1 回
  });

  it('places the share at [result - share, result]', () => {
    // 結果が枠の境界の 3 秒後 → 配分 5.23 秒は前の枠に 2.23 秒、後の枠に 3 秒
    const resultAt = BASE + SLOT_MS + 3000;
    const slots = allocateApprovedTools({
      approved: [[resultAt - 25200, resultAt]],
      costStates: { [BASE]: [5230, 3600000] },
      autoToolBySlot: new Map(),
    });
    const base = BASE / SLOT_MS;
    assert.deepEqual(
      Object.entries(slots).map(([k, cell]) => [Number(k) - base, cell[4]]),
      [
        [0, 2230],
        [1, 3000],
      ],
    );
  });

  it('splits by interval and never gives a tool more than its own interval', () => {
    const total = (toolMs) =>
      Object.values(
        allocateApprovedTools({
          approved: [
            [ms(0), ms(10)],
            [ms(100), ms(130)],
          ],
          costStates: { [BASE]: [toolMs, 3600000] },
          autoToolBySlot: new Map(),
        }),
      ).reduce((sum, cell) => sum + cell[4], 0);
    assert.equal(total(20000), 20000); // 10:30 の比で 5 秒・15 秒
    assert.equal(total(999999), 40000); // 間隔の合計で頭打ち
  });

  it('gives nothing when the automatic tool time already exceeds the measurement', async () => {
    const records = [
      human(0),
      block(1, 'r1', [use('auto')]),
      result(61, 'auto', CONFIG), // 自動ツール 60 秒
      block(62, 'r2', [use('a')]),
      result(90, 'a', ACCEPT),
      costState(-1, 30000, 3600),
    ];
    const withCost = await calendar(records);
    resetActivityHeatmapState();
    const without = await calendar(records.slice(0, -1));
    // 自動ツール（config）60 秒は実測 30 秒に縮み、その縮めた後の値で実測を使い切るので許可ツールには配られない
    assert.equal(sumCol(withCost, 5), sumCol(without, 5) - 30000);
    assert.equal(sumCol(withCost, 6), 30000); // 自動ツール時間の列（縮めた後）
  });

  it('leaves approved tools at 0 while the process has no cost-state yet', async () => {
    const session = await calendar([human(0), block(2, 'r1', [use('a')]), result(27.2, 'a', ACCEPT)]);
    assert.equal(sumCol(session, 5), 2000);
  });

  it('allocates per process window (resume writes a second startTime)', () => {
    const slots = allocateApprovedTools({
      approved: [
        [ms(10), ms(40)],
        [ms(5000), ms(5030)],
      ],
      costStates: { [ms(0)]: [4000, 1000 * 1000], [ms(4000)]: [7000, 2000 * 1000] },
      autoToolBySlot: new Map(),
    });
    const byIndex = Object.fromEntries(Object.entries(slots).map(([k, cell]) => [Number(k), cell[4]]));
    assert.equal(byIndex[Math.floor(ms(40) / SLOT_MS)], 4000);
    assert.equal(byIndex[Math.floor(ms(5030) / SLOT_MS)], 7000);
  });

  it('gives an approved tool to only the innermost window when two processes overlap', () => {
    // 外側（25 時間）の中に内側（69 秒）のプロセスがある。内側の許可ツールは内側からだけ配られる
    const slots = allocateApprovedTools({
      approved: [
        [ms(1000), ms(1030)], // 内側のウィンドウ内（間隔 30 秒）
        [ms(5000), ms(5010)], // 外側だけ（間隔 10 秒）
      ],
      costStates: { [ms(0)]: [999999, 25 * 3600 * 1000], [ms(990)]: [999999, 69 * 1000] },
      autoToolBySlot: new Map(),
    });
    const total = Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);
    assert.equal(total, 30000 + 10000); // 二重にならず、それぞれ自分の間隔まで
  });

  it('subtracts the automatic tools of the overlapped part only from the inner window', () => {
    const innerSlot = Math.floor(ms(1000) / SLOT_MS);
    const outerSlot = Math.floor(ms(20000) / SLOT_MS);
    const slots = allocateApprovedTools({
      approved: [
        [ms(1000), ms(1100)],
        [ms(20000), ms(20100)],
      ],
      // 外側 30 秒・内側 20 秒の実測。内側の枠の自動ツール 15 秒は内側からだけ引く
      costStates: { [ms(0)]: [30000, 30000 * 1000], [ms(900)]: [20000, 600 * 1000] },
      autoToolBySlot: new Map([
        [innerSlot, 15000],
        [outerSlot, 10000],
      ]),
    });
    const total = Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);
    assert.equal(total, 20000 - 15000 + (30000 - 10000));
  });

  it('counts approvals only for human-accepted tools, including subagents', async () => {
    const session = await calendar(
      [
        human(0),
        block(1, 'r1', [use('a'), use('b'), use('c'), use('q', 'AskUserQuestion'), use('d')]),
        result(10, 'a', ACCEPT),
        result(11, 'b', REJECT),
        result(12, 'c', CONFIG),
        result(13, 'q', ACCEPT),
        result(14, 'd'), // 判定の記録なし（10/7 以前）
      ],
      [human(20), block(21, 's1', [use('x')]), result(30, 'x', ACCEPT)],
    );
    assert.equal(sumCol(session, 7), 2);
  });
});

describe('unverified tools (no permissionDecision, before 10/8)', () => {
  beforeEach(() => resetActivityHeatmapState());

  const BASE = Math.floor(Date.UTC(2026, 8, 1, 3, 0) / SLOT_MS) * SLOT_MS;
  const ms = (s) => BASE + s * 1000;
  const sec = (s) => new Date(ms(s)).toISOString();
  const human = (s) => ({ type: 'user', timestamp: sec(s), message: { content: [{ type: 'text', text: 'やって' }] } });
  const use = (s, requestId, ...ids) => ({
    type: 'assistant',
    timestamp: sec(s),
    requestId,
    message: { id: `msg-${requestId}`, content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })) },
  });
  const result = (s, id, extra = {}) => ({
    type: 'user',
    timestamp: sec(s),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    ...extra,
  });
  const costState = (startS, toolMs, durationS) => ({
    type: 'cost-state',
    startTime: ms(startS),
    totalToolDuration: toolMs,
    totalDuration: durationS * 1000,
  });
  const newStats = () => ({
    keptProcesses: 0,
    shrunkProcesses: 0,
    shrunkCalls: 0,
    shrunkMs: 0,
    factors: [],
    outsideCalls: 0,
    cappedCalls: 0,
    cappedMs: 0,
  });
  const sumDelta = (delta, col = 4) => Object.values(delta).reduce((sum, cell) => sum + cell[col], 0);

  it('shrinks the unverified time by f = measured / U when U is larger', () => {
    const stats = newStats();
    const delta = adjustAutoTools({
      main: [
        [ms(0), ms(100)],
        [ms(200), ms(300)],
      ],
      costStates: { [ms(0)]: [100000, 3600 * 1000] },
      stats,
    });
    assert.equal(Math.round(sumDelta(delta)), -100000); // 200 秒 → 100 秒
    assert.equal(Math.round(sumDelta(delta, 5)), -100000); // 自動ツール時間も同じだけ減る
    assert.equal(Math.round(sumDelta(delta, 7)), -100000); // 未検証の列も
    assert.deepEqual(
      { ...stats, shrunkMs: Math.round(stats.shrunkMs) },
      { ...newStats(), shrunkProcesses: 1, shrunkCalls: 2, shrunkMs: 100000, factors: [0.5] },
    );
  });

  it('leaves the time as is when U <= measured (never grows)', () => {
    const stats = newStats();
    const delta = adjustAutoTools({
      main: [[ms(0), ms(100)]],
      costStates: { [ms(0)]: [500000, 3600 * 1000] },
      stats,
    });
    assert.deepEqual(delta, {});
    assert.equal(stats.keptProcesses, 1);
  });

  it('counts overlapping parallel calls once in U, but still shrinks each call', () => {
    const parallel = [
      [ms(0), ms(100)],
      [ms(0), ms(100)],
    ];
    // U = 100 秒（重なりは 1 回）。実測 100 秒なら縮めない（呼び出しごとの合計 200 秒のまま）
    assert.deepEqual(adjustAutoTools({ main: parallel, costStates: { [ms(0)]: [100000, 3600000] } }), {});
    // 実測 50 秒なら f = 0.5 で、各呼び出しを 50 秒に（合計 100 秒減る）
    const delta = adjustAutoTools({ main: parallel, costStates: { [ms(0)]: [50000, 3600000] } });
    assert.equal(Math.round(sumDelta(delta)), -100000);
  });

  it('caps a call at 10 minutes when its process has no cost-state', () => {
    const stats = newStats();
    const delta = adjustAutoTools({
      main: [
        [ms(0), ms(3600)],
        [ms(4000), ms(4100)],
      ],
      sub: [[ms(5000), ms(6000)]],
      costStates: {},
      stats,
    });
    assert.equal(sumDelta(delta), -(3000 + 400) * 1000);
    assert.deepEqual(stats, { ...newStats(), outsideCalls: 3, cappedCalls: 2, cappedMs: (3000 + 400) * 1000 });
  });

  it('does not shrink subagent calls inside a window', () => {
    const delta = adjustAutoTools({
      main: [[ms(0), ms(100)]],
      sub: [[ms(10), ms(1000)]],
      costStates: { [ms(0)]: [100000, 3600000] },
    });
    assert.deepEqual(delta, {});
  });

  async function calendarBusy(records) {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl(records));
    const { sessions } = await getActivityCalendar({ fromMs: BASE - 3600000, toMs: BASE + 86400000, dir, cacheFile });
    return sessions[0].slots.reduce((sum, slot) => sum + slot[5], 0);
  }

  it('applies the shrink and the cap in getActivityCalendar', async () => {
    const run = [human(0), use(0, 'r1', 'a'), result(1000, 'a'), human(2000)]; // 推論 0 秒 + Bash 1000 秒
    assert.equal(await calendarBusy([...run, costState(-1, 250000, 3600)]), 250000);
    resetActivityHeatmapState();
    assert.equal(await calendarBusy(run), MAX_CALL_MS); // cost-state なし
  });

  it('shrinks config calls (10/8 and later) only when the process has a cost-state', async () => {
    const decision = { permissionDecision: { decision: 'accept', source: 'config' } };
    const run = [human(0), use(0, 'r1', 'a'), result(1000, 'a', decision), human(2000)];
    // 判定待ち込みのタイムスタンプ差 1000 秒を実測 400 秒に揃える
    assert.equal(await calendarBusy([...run, costState(-1, 400000, 3600)]), 400000);
    resetActivityHeatmapState();
    // cost-state の無い（動作中の）プロセスの config は縮めず、上限もかけない
    assert.equal(await calendarBusy(run), 1000 * 1000);
  });

  it('does not shrink calls with toolUseResult.durationMs', async () => {
    const run = [
      human(0),
      use(0, 'r1', 'a'),
      result(1000, 'a', { toolUseResult: { durationMs: 900000 } }),
      human(2000),
      costState(-1, 10, 3600),
    ];
    assert.equal(await calendarBusy(run), 900000);
  });

  it('cuts the window when a resumed process rewrites the cost-state without adding to it', async () => {
    // 1 本目のプロセス（0〜100 秒、実測 50 秒）のあと resume した 2 本目が同じ startTime・同じ合計で書き直す。
    // 2 本目のツール（5000 秒〜）を 1 本目の実測で割らず、cost-state の無いプロセス（未検証は 600 秒上限）として扱う
    const first = [human(0), use(0, 'r1', 'a'), result(100, 'a'), human(150)];
    const second = [human(5000), use(5000, 'r2', 'b'), result(6000, 'b'), human(6100)];
    const state = costState(-1, 50000, 3600 * 24 * 10);
    const busy = await calendarBusy([...first, state, ...second, state]);
    assert.equal(busy, 50000 + MAX_CALL_MS);
  });

  it('keeps the window when a resumed process rewrites the cost-state with grown totals', () => {
    const costStates = {};
    noteCostState({ startTime: 0, totalToolDuration: 50, totalDuration: 100, totalAPIDuration: 5 }, costStates, 90);
    noteCostState({ startTime: 0, totalToolDuration: 50, totalDuration: 100, totalAPIDuration: 5 }, costStates, 90);
    assert.equal(costStates[0][2], null); // 会話を挟まない重複書き込みは打ち切らない
    noteCostState({ startTime: 0, totalToolDuration: 80, totalDuration: 900, totalAPIDuration: 9 }, costStates, 800);
    assert.deepEqual(costStates[0].slice(0, 3), [80, 900, null]); // 合計が増えた書き直しは累積
    noteCostState({ startTime: 0, totalToolDuration: 80, totalDuration: 5000, totalAPIDuration: 9 }, costStates, 4000);
    assert.deepEqual(costStates[0].slice(0, 3), [80, 900, 800]); // 増えないまま会話を挟んだら、増えた時点で打ち切る
  });
});

describe('tool start time correction (overlap with inference and queueing)', () => {
  beforeEach(() => resetActivityHeatmapState());

  const BASE = Math.floor(Date.UTC(2026, 8, 28, 10, 40) / SLOT_MS) * SLOT_MS;
  const ms = (s) => BASE + Math.round(s * 1000);
  const sec = (s) => new Date(ms(s)).toISOString();
  const human = (s) => ({ type: 'user', timestamp: sec(s), message: { content: [{ type: 'text', text: 'やって' }] } });
  const line = (s, requestId, id, name) => ({
    type: 'assistant',
    timestamp: sec(s),
    requestId,
    message: { id: `msg-${requestId}`, content: [{ type: 'tool_use', id, name, input: {} }] },
  });
  const text = (s, requestId) => ({
    type: 'assistant',
    timestamp: sec(s),
    requestId,
    message: { id: `msg-${requestId}`, content: [{ type: 'text', text: 'はい' }] },
  });
  const result = (s, id) => ({
    type: 'user',
    timestamp: sec(s),
    permissionDecision: { decision: 'accept', source: 'config' },
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

  // dd55e40a（2026-09-28 10:40 UTC 付近）と同じ形: 生成中に実行される読み取り 3 件、生成後に順に実行される
  // Edit 3 件、最後に Bash 1 件
  const records = [
    human(0),
    line(1, 'r1', 'read1', 'Read'),
    result(1.02, 'read1'),
    line(2, 'r1', 'read2', 'Grep'),
    result(2.02, 'read2'),
    line(3, 'r1', 'read3', 'Read'),
    result(3.02, 'read3'),
    line(4, 'r1', 'edit1', 'Edit'),
    line(6, 'r1', 'edit2', 'Edit'),
    line(8, 'r1', 'edit3', 'Edit'),
    line(9, 'r1', 'bash', 'Bash'),
    result(40, 'edit1'),
    result(40.15, 'edit2'),
    result(40.3, 'edit3'),
    result(45, 'bash'),
    text(46, 'r2'),
    human(100),
  ];

  const toolsOf = (recs) => {
    const state = emptyBusyState();
    const slots = {};
    const tools = {};
    const stats = { userSkippedMs: 0, onTool: (name, start, end) => (tools[`${name}@${end}`] = [start, end]) };
    for (const r of recs) accumulateBusy(r, state, slots, stats);
    return { tools, slots, state };
  };

  it('starts tools after generation, and sequential tools after the previous result', () => {
    const { tools } = toolsOf(records);
    assert.deepEqual(tools, {
      // 生成中に実行されたものは呼び出しの行から
      [`Read@${ms(1.02)}`]: [ms(1), ms(1.02)],
      [`Grep@${ms(2.02)}`]: [ms(2), ms(2.02)],
      [`Read@${ms(3.02)}`]: [ms(3), ms(3.02)],
      // Edit は 1 件目が応答の最後の行から、2 件目以降は直前の結果から
      [`Edit@${ms(40)}`]: [ms(9), ms(40)],
      [`Edit@${ms(40.15)}`]: [ms(40), ms(40.15)],
      [`Edit@${ms(40.3)}`]: [ms(40.15), ms(40.3)],
      // Bash は応答の最後の行から（順番待ちの補正はしない）
      [`Bash@${ms(45)}`]: [ms(9), ms(45)],
    });
  });

  it('does not split one response when tool results are written between its lines', () => {
    const { slots } = toolsOf(records);
    const total = Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);
    // 推論: r1 は 0〜9 秒（途中の結果で切れない）、r2 は 45〜46 秒。ツール: 0.06 + 31 + 0.3 + 36 秒
    assert.equal(total, 9000 + 1000 + 60 + 31000 + 300 + 36000);
  });

  it('does not chain parallel MCP calls', () => {
    const { tools } = toolsOf([
      human(0),
      line(1, 'r1', 'a', 'mcp__srv__a'),
      line(2, 'r1', 'b', 'mcp__srv__b'),
      result(10, 'b'),
      result(12, 'a'),
      human(20),
    ]);
    assert.deepEqual(tools, {
      [`mcp__srv__b@${ms(10)}`]: [ms(2), ms(10)],
      [`mcp__srv__a@${ms(12)}`]: [ms(2), ms(12)],
    });
  });

  it('holds tools until the response is settled', () => {
    // 末尾がツールの結果で終わっている間は、応答の終わりが確定しないので数えない（生成中の読み取りも含む）
    const { tools, state } = toolsOf(records.slice(0, 15));
    assert.deepEqual(tools, {});
    assert.equal(state.held.length, 7);
  });

  it('does not reuse the end of a response that continues after an injected user line', () => {
    const injected = { ...human(2), message: { content: [{ type: 'text', text: '<task-notification>…' }] } };
    const { tools } = toolsOf([
      human(0),
      line(1, 'r1', 'e', 'Edit'),
      injected, // 応答の途中に tool_result を含まない user 行が入ると、いったん応答が確定する
      text(5, 'r1'), // 同じ応答の続き（最後の行は 5 秒）
      result(10, 'e'),
      text(11, 'r2'),
    ]);
    // 確定し直した応答の最後の行（5 秒）から数える（古い終わり 1 秒を使い回すと 9 秒になる）
    assert.deepEqual(tools, { [`Edit@${ms(10)}`]: [ms(5), ms(10)] });
  });

  it('settles held tools of a file that stopped being updated', () => {
    const state = emptyBusyState();
    const slots = {};
    // サブエージェントは完了報告の tool_result で終わり、後続の行が来ない
    for (const r of [human(0), line(2, 'r1', 'b', 'Bash'), result(10, 'b')]) accumulateBusy(r, state, slots);
    assert.equal(state.held.length, 1);
    settleStaleBusy(state, slots);
    assert.equal(state.held.length, 0);
    const total = Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);
    assert.equal(total, 2000 + 8000); // 推論 0〜2 秒 + Bash 2〜10 秒（応答の最後の行から）
  });

  it('settles held tools of stale files in getActivityCalendar without double counting later appends', async () => {
    const { dir, cacheFile } = await makeEnv();
    const file = join(dir, '-home-me-a', 's1.jsonl');
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(file, jsonl([human(0), line(2, 'r1', 'b', 'Bash'), result(10, 'b')]));
    const range = { fromMs: BASE - 3600000, toMs: BASE + 86400000, dir, cacheFile };
    const busyOf = (sessions) => sessions[0].slots.reduce((sum, slot) => sum + slot[5], 0);
    // 更新が新しいうちは保留のまま（推論 2 秒だけ）
    assert.equal(busyOf((await getActivityCalendar(range)).sessions), 2000);
    // 11 分前に更新が止まったことにすると、保留していた Bash を確定させて数える
    resetActivityHeatmapState();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(file, old, old);
    assert.equal(busyOf((await getActivityCalendar(range)).sessions), 10000);
    // その後に追記が来ても二重にならない（一度に読んだときと同じ 20 秒）
    resetActivityHeatmapState();
    await appendFile(file, jsonl([text(20, 'r2'), human(30)]));
    assert.equal(busyOf((await getActivityCalendar(range)).sessions), 20000);
  });

  it('gives the same result when the incremental scan is cut anywhere', async () => {
    const all = [
      ...records,
      // 1 本目のプロセスの cost-state（実測で縮める）と、合計を増やさずに書き直す 2 本目（打ち切り）
      { type: 'cost-state', startTime: ms(-1), totalToolDuration: 30000, totalDuration: 1e9, totalAPIDuration: 1 },
      line(101, 'r3', 'w1', 'Write'),
      line(102, 'r3', 'w2', 'Write'),
      result(110, 'w1'),
      result(111, 'w2'),
      text(140, 'r4'),
      { type: 'cost-state', startTime: ms(-1), totalToolDuration: 30000, totalDuration: 1e9, totalAPIDuration: 1 },
    ];
    const range = (dir, cacheFile) => ({ fromMs: BASE - 3600000, toMs: BASE + 86400000, dir, cacheFile });
    const env0 = await makeEnv();
    await mkdir(join(env0.dir, '-home-me-a'), { recursive: true });
    await writeFile(join(env0.dir, '-home-me-a', 's1.jsonl'), jsonl(all));
    const once = (await getActivityCalendar(range(env0.dir, env0.cacheFile))).sessions[0].slots;
    for (let cut = 1; cut < all.length; cut++) {
      resetActivityHeatmapState();
      const { dir, cacheFile } = await makeEnv();
      const file = join(dir, '-home-me-a', 's1.jsonl');
      await mkdir(join(dir, '-home-me-a'), { recursive: true });
      await writeFile(file, jsonl(all.slice(0, cut)));
      await getActivityCalendar(range(dir, cacheFile));
      resetActivityHeatmapState();
      await appendFile(file, jsonl(all.slice(cut)));
      const { sessions } = await getActivityCalendar(range(dir, cacheFile));
      assert.deepEqual(sessions[0].slots, once, `cut at ${cut}`);
    }
  });
});

describe('warmActivityCache', () => {
  beforeEach(() => resetActivityHeatmapState());

  it('scans every file once so that the next request only reads the cache', async () => {
    const { dir, cacheFile } = await makeEnv();
    await mkdir(join(dir, '-home-me-a'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl([prompt(new Date().toISOString())]));
    assert.deepEqual(await warmActivityCache({ dir, cacheFile }), { fileCount: 1, scannedFiles: 1 });
    const result = await getActivityHeatmap({ days: 1, dir, cacheFile });
    assert.equal(result.scannedFiles, 0);
  });
});
