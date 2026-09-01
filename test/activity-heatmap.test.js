import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getActivityHeatmap, resetActivityHeatmapState } from '../server/activity-heatmap.js';

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
