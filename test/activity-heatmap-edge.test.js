// activity-heatmap.js の境界・異常系の振る舞い（ミューテーションテストで見つかった穴を埋めるもの）。
// 基本の振る舞いは activity-heatmap.test.js にある
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_CALL_MS,
  SLOT_MS,
  accumulateBusy,
  addBusy,
  adjustAutoTools,
  allocateApprovedTools,
  emptyBusyState,
  getActivityCalendar,
  getActivityHeatmap,
  listActiveSessionIds,
  noteCostState,
  resetActivityHeatmapState,
  sessionBusyCorrections,
  settleStaleBusy,
  toolCountMode,
} from '../server/activity-heatmap.js';

const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// テストが作った tmpdir だけを後で消す
const roots = [];
async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'cb-heatmap-edge-'));
  roots.push(root);
  const dir = join(root, 'projects');
  await mkdir(join(dir, '-home-me-a'), { recursive: true });
  return { root, dir, cacheFile: join(root, 'cache.json') };
}

beforeEach(() => resetActivityHeatmapState());
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});

// 枠の境界ちょうど（UTC で組み立てるので TZ に依存しない）
const BASE = Math.floor(Date.UTC(2026, 9, 1, 3, 0) / SLOT_MS) * SLOT_MS;
const ms = (s) => BASE + Math.round(s * 1000);
const sec = (s) => new Date(ms(s)).toISOString();
const RANGE = { fromMs: BASE - 3600000, toMs: BASE + 86400000 };

const human = (s, content = [{ type: 'text', text: 'やって' }], extra = {}) => ({
  type: 'user',
  timestamp: sec(s),
  message: { role: 'user', content },
  ...extra,
});
const assistant = (s, content = [{ type: 'text', text: 'はい' }], extra = {}) => ({
  type: 'assistant',
  timestamp: sec(s),
  message: { role: 'assistant', content },
  ...extra,
});
const block = (s, requestId, content = [{ type: 'text', text: 'はい' }]) => ({
  type: 'assistant',
  timestamp: sec(s),
  requestId,
  message: { id: `msg-${requestId}`, content },
});
const use = (id, name = 'Bash') => ({ type: 'tool_use', id, name, input: {} });
const result = (s, ids, extra = {}) => ({
  type: 'user',
  timestamp: sec(s),
  message: { content: [].concat(ids).map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
  ...extra,
});
const CONFIG = { decision: 'accept', source: 'config' };
const ACCEPT = { decision: 'accept', source: 'user_temporary' };
const costState = (startS, toolMs, durationS, extra = {}) => ({
  type: 'cost-state',
  startTime: ms(startS),
  totalToolDuration: toolMs,
  totalDuration: durationS * 1000,
  ...extra,
});

async function writeMain(dir, records, name = 's1') {
  await writeFile(join(dir, '-home-me-a', `${name}.jsonl`), jsonl(records));
}
async function calendarOf(records, subRecords) {
  const { dir, cacheFile } = await makeEnv();
  await writeMain(dir, records);
  if (subRecords) {
    await mkdir(join(dir, '-home-me-a', 's1', 'subagents'), { recursive: true });
    await writeFile(join(dir, '-home-me-a', 's1', 'subagents', 'agent-x.jsonl'), jsonl(subRecords));
  }
  const { sessions } = await getActivityCalendar({ ...RANGE, dir, cacheFile });
  return sessions[0];
}
// 枠の列: [枠番号, 発言, 応答, 調査, 編集, 稼働, 自動ツール, 許可回数, 縮める対象]
const sumCol = (session, col) => (session ? session.slots.reduce((sum, slot) => sum + slot[col], 0) : 0);
const PROMPTS_COL = 1;
const REPLIES_COL = 2;
const RESEARCH_COL = 3;
const EDIT_COL = 4;
const BUSY_COL = 5;

// ヒートマップで全期間の合計を取る（日付をまたいでも構わないように total で見る）
async function heatmapTotal(records) {
  const { dir, cacheFile } = await makeEnv();
  await writeMain(dir, records);
  const now = Date.now();
  const { total } = await getActivityHeatmap({ days: 3, dir, cacheFile, now });
  return total;
}
// 今日の正午（ローカル）を秒オフセット付きで
const todayAt = (s = 0) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return new Date(d.getTime() + s * 1000).toISOString();
};
const prompt = (content, extra = {}) => ({ type: 'user', timestamp: todayAt(), message: { content }, ...extra });
const reply = (usage, message = {}, extra = {}) => ({
  type: 'assistant',
  timestamp: todayAt(1),
  message: { content: [{ type: 'text', text: 'はい' }], usage, ...message },
  ...extra,
});
const usage = (input, output, create, read) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
});

describe('ヒートマップの合計', () => {
  it('期間内の各項目を全部足し上げる', async () => {
    const total = await heatmapTotal([
      prompt([{ type: 'text', text: 'やって' }]),
      reply(usage(1, 2, 3, 4)),
      reply(usage(10, 20, 30, 40)),
    ]);
    assert.deepEqual(total, {
      prompts: 1,
      replies: 2,
      messages: 3,
      tokens: 110,
      inputTokens: 11,
      outputTokens: 22,
      cacheCreationTokens: 33,
      cacheReadTokens: 44,
      activeMs: 1000,
      activeDays: 1,
    });
  });
});

describe('人の指示として数えるもの', () => {
  const countPrompts = async (record) =>
    (await heatmapTotal([record, prompt([{ type: 'text', text: '後続' }])])).prompts - 1;

  it('文字列の本文は数え、空文字は数えない', async () => {
    assert.equal(await countPrompts(prompt('やって')), 1);
    assert.equal(await countPrompts(prompt('')), 0);
  });

  it('isMeta と自動コンパクトの要約はそれぞれ単独でも数えない', async () => {
    assert.equal(await countPrompts(prompt([{ type: 'text', text: 'x' }], { isMeta: true })), 0);
    assert.equal(await countPrompts(prompt([{ type: 'text', text: 'x' }], { isCompactSummary: true })), 0);
  });

  it('本文が配列でも文字列でもないものは数えず、後続の行も読む', async () => {
    assert.equal(await countPrompts(prompt({ text: 'x' })), 0);
    assert.equal(await countPrompts({ type: 'user', timestamp: todayAt() }), 0);
  });

  it('tool_result を含むものは text があっても数えない', async () => {
    assert.equal(
      await countPrompts(
        prompt([
          { type: 'text', text: 'x' },
          { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
        ]),
      ),
      0,
    );
  });

  it('text が 1 つでもあれば数え、text の無いものは数えない', async () => {
    assert.equal(
      await countPrompts(
        prompt([
          { type: 'text', text: 'x' },
          { type: 'image', source: {} },
        ]),
      ),
      1,
    );
    assert.equal(await countPrompts(prompt([{ type: 'image', source: {} }])), 0);
  });

  it('本文に null が混ざっていても判定は止まらず、後続の行も読む', async () => {
    assert.equal(await countPrompts(prompt([null, { type: 'image', source: {} }])), 0);
    assert.equal(await countPrompts(prompt([null, { type: 'tool_result', tool_use_id: 'a', content: 'ok' }])), 0);
  });
});

describe('同じ API 応答の usage の名寄せ', () => {
  const tokens = async (records) => (await heatmapTotal(records)).inputTokens;
  const u = usage(10, 0, 0, 0);

  it('message.id が空文字や文字列でなければ名寄せせず毎行足す', async () => {
    assert.equal(await tokens([reply(u, { id: '' }), reply(u, { id: '' })]), 20);
    assert.equal(await tokens([reply(u, { id: 123 }), reply(u, { id: 123 })]), 20);
  });

  it('同じ message.id でも requestId が違えば別の応答として足す', async () => {
    assert.equal(
      await tokens([reply(u, { id: 'm1' }, { requestId: 'a' }), reply(u, { id: 'm1' }, { requestId: 'b' })]),
      20,
    );
  });

  it('文字列でない requestId は無いものとして名寄せする', async () => {
    assert.equal(
      await tokens([reply(u, { id: 'm1' }, { requestId: 1 }), reply(u, { id: 'm1' }, { requestId: 2 })]),
      10,
    );
    assert.equal(
      await tokens([reply(u, { id: 'm1' }, { requestId: 'Stryker was here!' }), reply(u, { id: 'm1' })]),
      20,
    );
  });
});

describe('タイムスタンプの読み方', () => {
  async function activeIds(records, from, to) {
    const { dir, cacheFile } = await makeEnv();
    await writeMain(dir, records);
    return listActiveSessionIds({ from, to, dir, cacheFile });
  }

  it('13 文字ちょうどでも日時として読めれば数える', async () => {
    // "Nov 1 2026 10" はローカル時刻として読まれるので TZ に依存しない
    const ids = await activeIds([{ ...prompt('やって'), timestamp: 'Nov 1 2026 10' }], '2026-11-01', '2026-11-01');
    assert.deepEqual([...ids], ['s1']);
  });

  it('時刻の無い短いタイムスタンプ・文字列でないタイムスタンプは日別にも枠にも数えない', async () => {
    const records = [
      { ...prompt('やって'), timestamp: '2026-10-01' },
      { ...prompt('やって'), timestamp: 1790000000000 },
    ];
    assert.equal((await activeIds(records, '0000-00-00', '9999-99-99')).size, 0);
    resetActivityHeatmapState();
    const { dir, cacheFile } = await makeEnv();
    await writeMain(dir, [...records, human(0)]);
    const { sessions } = await getActivityCalendar({
      fromMs: Date.UTC(2026, 8, 1),
      toMs: Date.UTC(2026, 10, 1),
      dir,
      cacheFile,
    });
    assert.equal(sumCol(sessions[0], PROMPTS_COL), 1);
  });
});

describe('ツールの種類の数え方', () => {
  const research = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
  const edits = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

  it('調査系・編集系のツールを名前ごとに数え、それ以外や tool_use 以外のブロックは数えない', async () => {
    const content = [
      null,
      ...research.map((name, i) => use(`r${i}`, name)),
      ...edits.map((name, i) => use(`e${i}`, name)),
      use('b', 'Bash'),
      { type: 'server_tool_use', id: 's', name: 'WebSearch' },
    ];
    const session = await calendarOf([human(0), assistant(1, content)]);
    assert.equal(sumCol(session, RESEARCH_COL), research.length);
    assert.equal(sumCol(session, EDIT_COL), edits.length);
    assert.equal(sumCol(session, REPLIES_COL), 1);
  });

  it('本文の無い応答も応答として数え、後続の行も読む', async () => {
    const session = await calendarOf([
      human(0),
      { type: 'assistant', timestamp: sec(1), message: {} },
      { type: 'assistant', timestamp: sec(2) },
      human(3),
    ]);
    assert.equal(sumCol(session, REPLIES_COL), 2);
    assert.equal(sumCol(session, PROMPTS_COL), 2);
  });
});

describe('順に実行されるツールの開始時刻', () => {
  // 応答 r1 が 1s, 2s に tool_use を書き、3s で生成を終える。結果は 10s, 20s
  const startOfSecond = (name) => {
    const state = emptyBusyState();
    const tools = {};
    const stats = { userSkippedMs: 0, onTool: (n, start, end) => (tools[`${n}@${end}`] = start) };
    const records = [
      human(0),
      block(1, 'r1', [use('a', 'Edit')]),
      block(2, 'r1', [use('b', name)]),
      block(3, 'r1'),
      result(10, 'a', { permissionDecision: CONFIG }),
      result(20, 'b', { permissionDecision: CONFIG }),
      human(100),
    ];
    for (const r of records) accumulateBusy(r, state, {}, stats);
    return tools[`${name}@${ms(20)}`];
  };

  it('Edit / MultiEdit / Write / NotebookEdit は直前の結果の後から数える', () => {
    for (const name of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) assert.equal(startOfSecond(name), ms(10), name);
  });

  it('それ以外のツールは応答の生成が終わった時点から数える', () => {
    assert.equal(startOfSecond('Bash'), ms(3));
  });
});

describe('addBusy', () => {
  it('終わりが始まり以前なら何も足さない', () => {
    const slots = {};
    addBusy(slots, ms(5), ms(5));
    addBusy(slots, ms(5), ms(3));
    assert.deepEqual(slots, {});
  });

  it('枠の境界ちょうどで終わる区間は次の枠を作らない', () => {
    const slots = {};
    addBusy(slots, BASE, BASE + SLOT_MS);
    assert.deepEqual(Object.keys(slots), [String(BASE / SLOT_MS)]);
  });
});

describe('toolCountMode', () => {
  const block1 = (content) => ({ type: 'tool_result', tool_use_id: 'a', content });

  it('人の判定（user_*）は数えず、config は全体、それ以外の source は未検証', () => {
    assert.equal(toolCountMode({ permissionDecision: { source: 'user_reject' } }, block1('ok')), 'skip');
    assert.equal(toolCountMode({ permissionDecision: { source: 'config' } }, block1('ok')), 'full');
    assert.equal(toolCountMode({ permissionDecision: { source: 'hook' } }, block1('ok')), 'unverified');
  });

  it('記録の無い拒否は本文（文字列・ブロックの配列）の定型文で見分ける', () => {
    const rejected = "The user doesn't want to proceed with this tool use.";
    assert.equal(toolCountMode({}, block1(rejected)), 'skip');
    assert.equal(
      toolCountMode({}, block1([{ type: 'text', text: 'x' }, null, { type: 'text', text: rejected }])),
      'skip',
    );
    assert.equal(
      toolCountMode({}, block1([{ type: 'text', text: "doesn't want" }, { text: 'to proceed' }])),
      'unverified',
    );
    assert.equal(toolCountMode({}, block1([{ text: [rejected] }])), 'unverified');
    assert.equal(toolCountMode({}, block1({ text: rejected })), 'unverified');
    assert.equal(toolCountMode({}, null), 'unverified');
  });

  it('テキストのブロックは改行でつないで読む（定型文が 2 つのブロックに分かれていれば拒否ではない）', () => {
    assert.equal(
      toolCountMode(
        {},
        block1([
          { type: 'text', text: "doesn't want" },
          { type: 'text', text: ' to proceed' },
        ]),
      ),
      'unverified',
    );
  });
});

describe('JSONL の集め方と日付の書式', () => {
  it('.jsonl 以外のファイルと読めないファイル（壊れたリンク）は読まない', async () => {
    const { dir, cacheFile } = await makeEnv();
    const line = jsonl([prompt('やって')]);
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), line);
    await writeFile(join(dir, '-home-me-a', 'notes.txt'), line);
    await symlink(join(dir, 'missing'), join(dir, '-home-me-a', 'broken.jsonl'));
    const result = await getActivityHeatmap({ days: 3, dir, cacheFile });
    assert.equal(result.total.prompts, 1);
    assert.equal(result.fileCount, 1);
  });

  it('ディレクトリが無ければ全部 0 で返す', async () => {
    const { root, cacheFile } = await makeEnv();
    const result = await getActivityHeatmap({ days: 2, dir: join(root, 'nothing'), cacheFile });
    assert.equal(result.fileCount, 0);
    assert.equal(result.total.messages, 0);
  });

  it('日付は月・日を 2 桁にそろえた YYYY-MM-DD で返す', async () => {
    const { dir, cacheFile } = await makeEnv();
    const now = new Date(2026, 0, 5, 12).getTime();
    const result = await getActivityHeatmap({ days: 2, dir, cacheFile, now });
    assert.deepEqual(
      result.days.map((d) => d.date),
      ['2026-01-04', '2026-01-05'],
    );
  });
});

describe('emptyBusyState', () => {
  it('空の状態から始める', () => {
    assert.deepEqual(emptyBusyState(), {
      request: null,
      tools: {},
      requests: {},
      held: [],
      seq: 0,
      lastUserMs: null,
      lastAssistantMs: null,
      approved: [],
      autoTools: [],
    });
  });
});

describe('accumulateBusy の境界', () => {
  const run = (records, stats) => {
    const state = emptyBusyState();
    const slots = {};
    for (const r of records) accumulateBusy(r, state, slots, stats);
    return { state, slots, busy: Object.values(slots).reduce((sum, cell) => sum + cell[4], 0) };
  };
  const toolsOf = (records) => {
    const tools = [];
    run(records, { userSkippedMs: 0, onTool: (name, start, end) => tools.push([name, start, end]) });
    return tools;
  };

  it('時刻の読めないレコードは無視し、前後の推論の区切りに影響させない', () => {
    const records = [
      human(0),
      block(5, 'r1'),
      { type: 'assistant', timestamp: 'broken', requestId: 'r2', message: { content: [] } },
      human(10),
      block(12, 'r3'),
      human(20),
    ];
    assert.equal(run(records).busy, 7000);
  });

  it('ファイルが応答から始まるときは最初の行から数える', () => {
    assert.equal(run([block(0, 'r1'), block(5, 'r1'), human(10)]).busy, 5000);
  });

  it('requestId だけを持つ行（message.id 無し）も同じ応答としてつなぐ', () => {
    const line = (s, content) => ({ type: 'assistant', timestamp: sec(s), requestId: 'r1', message: { content } });
    const records = [
      human(0),
      line(1, [use('a')]),
      result(2, 'a', { permissionDecision: CONFIG }),
      line(3, [{ type: 'text', text: 'はい' }]),
      human(10),
    ];
    // 推論 0〜3s と、生成中に実行されたツール 1〜2s
    assert.equal(run(records).busy, 4000);
  });

  it('キーの無い応答どうしは別の応答として扱う', () => {
    const keyless = (s, content) => ({ type: 'assistant', timestamp: sec(s), message: { content } });
    const records = [
      human(0),
      keyless(1, [use('a')]),
      keyless(2, [use('b')]),
      result(10, ['a'], { permissionDecision: CONFIG }),
      result(10, ['b'], { permissionDecision: CONFIG }),
      human(20),
    ];
    assert.deepEqual(toolsOf(records), [
      ['Bash', ms(1), ms(10)],
      ['Bash', ms(2), ms(10)],
    ]);
  });

  it('id が文字列でない tool_use や tool_use 以外のブロックの結果はツールとして数えない', () => {
    const records = [
      human(0),
      block(1, 'r1', [
        { type: 'server_tool_use', id: 's1', name: 'WebSearch' },
        { type: 'tool_use', id: 7, name: 'Bash' },
        { type: 'text', text: 'x' },
      ]),
      {
        type: 'user',
        timestamp: sec(5),
        permissionDecision: CONFIG,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 's1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 7, content: 'ok' },
            { type: 'tool_result', content: 'ok' },
          ],
        },
      },
      human(20),
    ];
    assert.deepEqual(toolsOf(records), []);
    assert.equal(run(records).busy, 1000);
  });

  it('名前の無い tool_use は名前を空文字として渡す', () => {
    const records = [
      human(0),
      block(1, 'r1', [{ type: 'tool_use', id: 'a' }]),
      result(3, 'a', { permissionDecision: CONFIG }),
      human(9),
    ];
    assert.deepEqual(toolsOf(records), [['', ms(1), ms(3)]]);
  });

  it('未解決の tool_use は新しい 200 件だけ覚え、それより古いものの結果は数えない', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
    const records = [
      human(0),
      block(
        1,
        'r1',
        ids.map((id) => use(id)),
      ),
      block(2, 'r2'),
      result(5, 't0', { permissionDecision: CONFIG }),
      result(5, 't1', { permissionDecision: CONFIG }),
      result(5, 't200', { permissionDecision: CONFIG }),
      human(10),
    ];
    assert.deepEqual(
      toolsOf(records).map(([, , end], i) => [i, end]),
      [
        [0, ms(5)],
        [1, ms(5)],
      ],
    );
  });

  it('user / assistant 以外のレコードは応答の区切りにしない', () => {
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      { type: 'attachment', timestamp: sec(2), attachment: {} },
      result(3, 'a', { permissionDecision: CONFIG }),
      block(4, 'r1'),
      human(10),
    ];
    // 推論 0〜4s と、生成中に実行されたツール 1〜3s
    assert.equal(run(records).busy, 6000);
  });

  it('応答が確定した後に届いた結果はすぐに数える', () => {
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(5, 'a', { permissionDecision: CONFIG }),
      human(10),
    ];
    assert.deepEqual(toolsOf(records), [['Bash', ms(1), ms(5)]]);
  });

  it('toolUseResult.durationMs は結果が 1 件で 0 以上の数値のときだけ使う', () => {
    const withReport = (durationMs, ids = ['a']) => [
      human(0),
      block(
        1,
        'r1',
        ids.map((id) => use(id)),
      ),
      block(2, 'r2'),
      result(10, ids, { permissionDecision: CONFIG, toolUseResult: { durationMs } }),
      human(20),
    ];
    const toolMs = (records) => toolsOf(records).reduce((sum, [, start, end]) => sum + Math.max(0, end - start), 0);
    assert.equal(toolMs(withReport(500)), 500);
    assert.equal(toolMs(withReport(0)), 0);
    // 負・文字列は使わずタイムスタンプ差（1s〜10s）
    assert.equal(toolMs(withReport(-500)), 9000);
    assert.equal(toolMs(withReport('500')), 9000);
    // 結果が 2 件ならそれぞれタイムスタンプ差
    assert.equal(toolMs(withReport(500, ['a', 'b'])), 18000);
  });

  it('人が許可したツールは durationMs があっても稼働に数えない', () => {
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(10, 'a', { permissionDecision: ACCEPT, toolUseResult: { durationMs: 500 } }),
      human(20),
    ];
    // 推論（0〜1s・1〜2s）だけ。許可ツールは集計時に cost-state から配る
    assert.equal(run(records).busy, 2000);
  });

  it('人が拒否・許可したツールの時間だけを userSkippedMs に足す', () => {
    const stats = (records) => {
      const s = { userSkippedMs: 0 };
      run(records, s);
      return s.userSkippedMs;
    };
    const rejectedText = (s, id) => ({
      type: 'user',
      timestamp: sec(s),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: "User doesn't want to proceed" }] },
    });
    assert.equal(stats([human(0), block(1, 'r1', [use('a')]), rejectedText(4, 'a'), human(9)]), 0);
    assert.equal(
      stats([
        human(0),
        block(1, 'r1', [use('a')]),
        result(4, 'a', { permissionDecision: { source: 'user_reject' } }),
        human(9),
      ]),
      3000,
    );
    // 結果の時刻が呼び出しより前（時計のずれ）なら足さない
    assert.equal(
      stats([
        human(0),
        block(5, 'r1', [use('a')]),
        result(4, 'a', { permissionDecision: { source: 'user_reject' } }),
        human(9),
      ]),
      0,
    );
  });
});

describe('ツール時間の補正の境界', () => {
  const toolsOf = (records, stats = {}) => {
    const state = emptyBusyState();
    const tools = [];
    const s = { userSkippedMs: 0, onTool: (name, start, end) => tools.push([start, end]), ...stats };
    for (const r of records) accumulateBusy(r, state, {}, s);
    return { tools, state, stats: s };
  };

  it('結果が応答の最後の行と同じ時刻なら生成後の実行として 0 にする', () => {
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      result(3, 'a', { permissionDecision: CONFIG }),
      block(3, 'r1'),
      human(10),
    ];
    assert.deepEqual(toolsOf(records).tools, [[ms(3), ms(3)]]);
  });

  it('onTool の無い stats でも人の許可ツールを処理できる', () => {
    const state = emptyBusyState();
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(5, 'a', { permissionDecision: ACCEPT }),
    ];
    assert.doesNotThrow(() => {
      for (const r of records) accumulateBusy(r, state, {}, { userSkippedMs: 0 });
    });
  });

  it('600 秒を超えた分だけを config / 未検証に分けて stats に足す', () => {
    const long = (durationS, extra) => [
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(1 + durationS, 'a', extra),
      human(5000),
    ];
    const statsOf = (records) => {
      const { stats } = toolsOf(records, { onTool: undefined });
      delete stats.onTool;
      return stats;
    };
    assert.deepEqual(statsOf(long(700, { permissionDecision: CONFIG })), { userSkippedMs: 0, uncappedMs: 100000 });
    assert.deepEqual(statsOf(long(700)), { userSkippedMs: 0, uncappedUnverifiedMs: 100000 });
    assert.deepEqual(statsOf(long(600, { permissionDecision: CONFIG })), { userSkippedMs: 0 });
    // 2 回目は前の値に足す
    const twice = [
      human(0),
      block(1, 'r1', [use('a'), use('b')]),
      block(2, 'r2'),
      result(701, 'a', { permissionDecision: CONFIG }),
      result(801, 'b', { permissionDecision: CONFIG }),
      human(5000),
    ];
    assert.deepEqual(statsOf(twice), { userSkippedMs: 0, uncappedMs: 300000 });
  });
});

describe('settleStaleBusy', () => {
  const settled = (state) => {
    const tools = [];
    settleStaleBusy(state, {}, { onTool: (name, start, end) => tools.push([name, start, end]) });
    return tools;
  };

  it('状態が無い・保留が無いときは何もしない', () => {
    assert.doesNotThrow(() => settleStaleBusy(undefined, {}));
    const state = emptyBusyState();
    for (const r of [human(0), block(1, 'r1'), human(2)]) accumulateBusy(r, state, {});
    assert.deepEqual(settled(state), []);
  });

  it('保留が無ければ進行中の応答を確定させない（推論の上限は応答の最初から数え続ける）', () => {
    const state = emptyBusyState();
    const slots = {};
    accumulateBusy(human(0), state, slots);
    accumulateBusy(block(1, 'r1'), state, slots);
    settleStaleBusy(state, slots);
    accumulateBusy(block(700, 'r1'), state, slots);
    assert.equal(
      Object.values(slots).reduce((sum, cell) => sum + cell[4], 0),
      MAX_CALL_MS,
    );
  });

  it('進行中の応答を最後の行（順序が前後しても最も遅い行）で確定させてから保留中のツールを数える', () => {
    const state = emptyBusyState();
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      block(5, 'r1'),
      block(3, 'r1'),
      result(4, 'a', { permissionDecision: CONFIG }),
    ];
    for (const r of records) accumulateBusy(r, state, {});
    assert.deepEqual(settled(state), [['Bash', ms(1), ms(4)]]);
    // 確定させたものは保留から消え、2 回目は数えない
    assert.deepEqual(settled(state), []);
  });

  it('応答の情報が無い保留は、その応答の終わり → 最後の応答の時刻 → 結果の時刻の順で終わりを決める', () => {
    const heldState = (extra) => ({
      ...emptyBusyState(),
      held: [['k', ms(1), ms(5), 'Bash', 'full', null]],
      ...extra,
    });
    assert.deepEqual(settled(heldState({ requests: { k: { endMs: ms(2), lastResultMs: null } } })), [
      ['Bash', ms(2), ms(5)],
    ]);
    assert.deepEqual(settled(heldState({ lastAssistantMs: ms(3) })), [['Bash', ms(3), ms(5)]]);
    assert.deepEqual(settled(heldState({})), [['Bash', ms(5), ms(5)]]);
  });

  it('応答の確定で保留が空になったあとは数えない', () => {
    const state = emptyBusyState();
    const records = [
      human(0),
      block(1, 'r1', [use('a')]),
      result(2, 'a', { permissionDecision: CONFIG }),
      block(3, 'r1'),
      human(4),
      block(5, 'r2', [use('b')]),
      result(6, 'b', { permissionDecision: CONFIG }),
    ];
    for (const r of records) accumulateBusy(r, state, {});
    assert.deepEqual(settled(state), [['Bash', ms(5), ms(6)]]);
  });
});

describe('noteCostState', () => {
  const cs = (extra = {}) => ({
    type: 'cost-state',
    startTime: 1000,
    totalToolDuration: 50,
    totalDuration: 9000,
    totalAPIDuration: 20,
    ...extra,
  });

  it('startTime・totalToolDuration のどちらかが数値でなければ記録しない', () => {
    for (const bad of [{ startTime: '1000' }, { totalToolDuration: '50' }, { startTime: undefined }]) {
      const states = {};
      noteCostState(cs(bad), states, 100);
      assert.deepEqual(states, {}, JSON.stringify(bad));
    }
  });

  it('totalDuration・totalAPIDuration が数値でなければ 0 として記録する', () => {
    const states = {};
    noteCostState(cs({ totalDuration: '9000', totalAPIDuration: '20' }), states, 100);
    assert.deepEqual(states, { 1000: [50, 0, null, 0, 100, 100] });
  });

  it('合計が同じ書き直しは、会話を挟んだときだけ合計が最後に増えた位置で打ち切る', () => {
    const states = {};
    noteCostState(cs(), states, 100);
    assert.deepEqual(states[1000], [50, 9000, null, 20, 100, 100]);
    // 会話を挟まない書き直しは打ち切らず、totalDuration は新しい値
    noteCostState(cs({ totalDuration: 12000 }), states, 100);
    assert.deepEqual(states[1000], [50, 12000, null, 20, 100, 100]);
    // 会話を挟んだ書き直しは打ち切る（totalDuration は前の値のまま）
    noteCostState(cs({ totalDuration: 15000 }), states, 200);
    assert.deepEqual(states[1000], [50, 12000, 100, 20, 100, 200]);
    // その後の書き直しでも打ち切りは保つ
    noteCostState(cs({ totalDuration: 18000 }), states, 200);
    assert.deepEqual(states[1000], [50, 12000, 100, 20, 100, 200]);
  });

  it('位置の分からない書き直しの後は、会話を挟んだかを判断しない', () => {
    const states = {};
    noteCostState(cs(), states, 100);
    noteCostState(cs(), states, null);
    assert.deepEqual(states[1000], [50, 9000, null, 20, 100, null]);
    noteCostState(cs(), states, 200);
    assert.deepEqual(states[1000], [50, 9000, null, 20, 100, 200]);
  });

  it('合計（ツール・API）が変われば新しい書き込みとして記録し直す', () => {
    const states = {};
    noteCostState(cs(), states, 100);
    noteCostState(cs({ totalToolDuration: 80 }), states, 300);
    assert.deepEqual(states[1000], [80, 9000, null, 20, 300, 300]);
    noteCostState(cs({ totalToolDuration: 80, totalAPIDuration: 30 }), states, 400);
    assert.deepEqual(states[1000], [80, 9000, null, 30, 400, 400]);
  });

  it('API 合計を持たない古い記録は、API 合計が同じものとして書き直しに扱う', () => {
    const states = { 1000: [50, 9000, null] };
    noteCostState(cs(), states, 100);
    assert.deepEqual(states[1000], [50, 9000, null, 20, null, 100]);
  });
});

describe('adjustAutoTools の境界', () => {
  const newStats = () => ({
    keptProcesses: 0,
    shrunkProcesses: 0,
    shrunkCalls: 0,
    shrunkMs: 0,
    factors: [],
    outsideCalls: 0,
    cappedCalls: 0,
    cappedMs: 0,
    windows: [],
  });
  // ウィンドウ [0, 1000] の実測 toolMs で、区間の和集合 U から f = toolMs / U を求める
  const factorOf = (main, toolMs) => {
    const stats = newStats();
    adjustAutoTools({ main, costStates: { 0: [toolMs, 1000, null] }, stats });
    return stats.factors;
  };

  it('main を省くと何も数えない', () => {
    const stats = newStats();
    assert.deepEqual(adjustAutoTools({ costStates: {}, stats }), {});
    assert.deepEqual(stats, newStats());
  });

  it('ツールの無いウィンドウは数えない', () => {
    const stats = newStats();
    adjustAutoTools({ main: [[5000, 6000, 0]], costStates: { 0: [10, 1000, null] }, stats });
    assert.equal(stats.keptProcesses, 0);
  });

  it('ウィンドウの終わりちょうどに始まった呼び出しはそのウィンドウで縮める', () => {
    const stats = newStats();
    adjustAutoTools({ main: [[1000, 1100, 0]], costStates: { 0: [50, 1000, null] }, stats });
    assert.deepEqual(stats.factors, [0.5]);
  });

  it('和集合は並び順に関係なく、重なり・包含をまとめ、長さ 0 以下の区間を除いて測る', () => {
    // 0〜20 と 50〜60 で U = 30
    assert.deepEqual(
      factorOf(
        [
          [50, 60, 0],
          [0, 10, 0],
          [5, 20, 0],
          [70, 65, 0],
          [80, 80, 0],
        ],
        15,
      ),
      [0.5],
    );
    // 桁の違う開始時刻も数値として並べる（100〜110 と 20〜30 で U = 20）
    assert.deepEqual(
      factorOf(
        [
          [100, 110, 0],
          [20, 30, 0],
          [300, 305, 0],
          [9, 14, 0],
        ],
        15,
      ),
      [0.5],
    );
    // 包含（0〜40 の中の 5〜10）は外側の長さ
    assert.deepEqual(
      factorOf(
        [
          [0, 40, 0],
          [5, 10, 0],
        ],
        20,
      ),
      [0.5],
    );
  });

  it('縮めたウィンドウごとに件数・未検証の件数・引いた時間を記録する', () => {
    const stats = newStats();
    adjustAutoTools({
      main: [
        [0, 100, 1],
        [100, 200, 0],
        [300, 250, 1],
      ],
      costStates: { 0: [100, 1000, null] },
      stats,
    });
    assert.deepEqual(stats.windows, [{ start: 0, f: 0.5, calls: 3, unverifiedCalls: 2, removedMs: 100 }]);
    assert.equal(stats.shrunkMs, 100);
  });

  it('ウィンドウ外の未検証は 600 秒ちょうどなら上限をかけない', () => {
    const stats = newStats();
    adjustAutoTools({ main: [[0, MAX_CALL_MS, 1]], costStates: {}, stats });
    assert.equal(stats.cappedCalls, 0);
    assert.equal(stats.outsideCalls, 1);
  });
});

describe('allocateApprovedTools の境界', () => {
  const W = 100 * SLOT_MS;
  const window = (toolMs, durationMs, start = W) => ({ [start]: [toolMs, durationMs, null] });
  const total = (slots) => Object.values(slots).reduce((sum, cell) => sum + cell[4], 0);

  it('どのウィンドウにも入らない許可ツール・自動ツールの枠は無視する', () => {
    assert.deepEqual(
      allocateApprovedTools({
        approved: [[W - 5000, W - 1000]],
        costStates: window(10000, 60000),
        autoToolBySlot: new Map([[50, 1000]]),
      }),
      {},
    );
    assert.equal(
      total(
        allocateApprovedTools({
          approved: [[W + 1000, W + 5000]],
          costStates: window(10000, 60000),
          autoToolBySlot: new Map([[50, 1000]]),
        }),
      ),
      4000,
    );
  });

  it('許可ツールの無いウィンドウがあっても、ある方には配る', () => {
    const costStates = { ...window(10000, 60000), ...window(10000, 60000, W + 10 * SLOT_MS) };
    assert.equal(
      total(allocateApprovedTools({ approved: [[W + 1000, W + 3000]], costStates, autoToolBySlot: new Map() })),
      2000,
    );
  });

  it('ウィンドウの始まり・終わりの枠に掛かる自動ツールは差し引き、外の枠のものは引かない', () => {
    const allocate = (slot) =>
      total(
        allocateApprovedTools({
          approved: [[W + 1000, W + 9000]],
          costStates: window(10000, SLOT_MS * 2),
          autoToolBySlot: new Map([[slot, 6000]]),
        }),
      );
    const startSlot = W / SLOT_MS;
    assert.equal(allocate(startSlot - 1), 8000);
    assert.equal(allocate(startSlot), 4000);
    assert.equal(allocate(startSlot + 2), 4000);
    assert.equal(allocate(startSlot + 3), 8000);
  });
});

describe('getActivityCalendar の範囲と並び', () => {
  const fromSlot = Math.floor(RANGE.fromMs / SLOT_MS);
  const toSlot = Math.ceil(RANGE.toMs / SLOT_MS);

  it('終わりの枠ちょうど・終わりの分ちょうどの活動は含めない', async () => {
    const end = ((toSlot - BASE / SLOT_MS) * SLOT_MS) / 1000;
    const session = await calendarOf([human(0), human(end), assistant(end + 1)]);
    assert.deepEqual(
      session.slots.map(([index]) => index),
      [BASE / SLOT_MS],
    );
    assert.deepEqual(
      session.prompts.map(([minute]) => minute),
      [BASE / 60000],
    );
  });

  it('本体とサブエージェントの枠・順序の前後した指示を時刻順に並べる', async () => {
    const m = SLOT_MS / 1000;
    const session = await calendarOf(
      [human(0), human(3 * m), human(2 * m + 120), assistant(3 * m + 1)],
      [human(m), assistant(2 * m)],
    );
    const indices = session.slots.map(([index]) => index);
    assert.deepEqual(
      indices,
      [...indices].sort((a, b) => a - b),
    );
    assert.equal(indices.length, 4);
    const minutes = session.prompts.map(([minute]) => minute);
    assert.deepEqual(
      minutes,
      [...minutes].sort((a, b) => a - b),
    );
    assert.equal(minutes.length, 3);
  });

  it('縮めた枠も 9 列のまま返す', async () => {
    const session = await calendarOf([
      human(0),
      block(1, 'r1', [use('a')]),
      result(301, 'a', { permissionDecision: CONFIG }),
      block(302, 'r2'),
      costState(-10, 10000, 3600),
    ]);
    for (const slot of session.slots) assert.equal(slot.length, 9);
    assert.ok(sumCol(session, BUSY_COL) < 300000);
  });

  it('期間外の縮小・配分だけでセッションを出したり、期間外の枠を足したりしない', async () => {
    // 期間（RANGE）より前に終わったセッション。縮小と配分の差分は期間外の枠にだけ乗る
    const before = (RANGE.fromMs - BASE) / 1000 - 7200;
    const records = [
      human(before),
      block(before + 1, 'r1', [use('a')]),
      result(before + 301, 'a', { permissionDecision: CONFIG }),
      block(before + 302, 'r2', [use('b')]),
      result(before + 400, 'b', { permissionDecision: ACCEPT }),
      block(before + 401, 'r3'),
      costState(before - 10, 20000, 3600),
    ];
    assert.equal(await calendarOf(records), undefined);
  });

  it('期間の最初の枠の縮小も当てる', async () => {
    const start = (fromSlot * SLOT_MS - BASE) / 1000;
    const session = await calendarOf([
      human(start),
      block(start + 1, 'r1', [use('a')]),
      result(start + 301, 'a', { permissionDecision: CONFIG }),
      block(start + 302, 'r2'),
      costState(start - 10, 10000, 3600),
    ]);
    // 推論 1s + 1s とツール 300s を実測 10s に縮めたもの
    assert.equal(sumCol(session, BUSY_COL), 12000);
  });

  it('記録の無い枠にまたがる許可ツールへの配分も、その枠の稼働として返す', async () => {
    const m = SLOT_MS / 1000;
    const session = await calendarOf([
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(3 * m, 'a', { permissionDecision: ACCEPT }),
      block(3 * m + 1, 'r3'),
      costState(-10, 2 * SLOT_MS, 4 * m),
    ]);
    const middle = session.slots.find(([index]) => index === BASE / SLOT_MS + 1);
    assert.equal(middle.length, 9);
    assert.equal(middle[BUSY_COL], SLOT_MS);
  });
});

describe('セッションの単位', () => {
  it('projects 直下の JSONL はどのセッションにも数えない', async () => {
    const { dir, cacheFile } = await makeEnv();
    await writeFile(join(dir, 'stray.jsonl'), jsonl([human(0), assistant(1)]));
    await writeMain(dir, [human(0), assistant(1)]);
    const ids = await listActiveSessionIds({ from: '0000-00-00', to: '9999-99-99', dir, cacheFile });
    assert.deepEqual([...ids], ['s1']);
    resetActivityHeatmapState();
    const { sessions } = await getActivityCalendar({ ...RANGE, dir, cacheFile });
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ['s1'],
    );
  });

  it('指示と応答が 1 件ずつの日も活動のあった日として数える', async () => {
    const { dir, cacheFile } = await makeEnv();
    await writeMain(dir, [
      { ...prompt('やって'), timestamp: 'Nov 1 2026 10' },
      { ...reply(), timestamp: 'Nov 1 2026 10:01' },
    ]);
    const ids = await listActiveSessionIds({ from: '2026-11-01', to: '2026-11-01', dir, cacheFile });
    assert.deepEqual([...ids], ['s1']);
  });

  it('サブエージェントのツールは縮めず、本体と同じ枠の自動ツールも許可ツールの差し引きに足す', async () => {
    const main = [
      human(0),
      block(1, 'r1', [use('a')]),
      block(2, 'r2'),
      result(31, 'a', { permissionDecision: ACCEPT }),
      block(32, 'r3', [use('c')]),
      result(42, 'c', { permissionDecision: CONFIG }),
      block(43, 'r4'),
      costState(-10, 30000, 600),
    ];
    const sub = [
      human(0),
      block(1, 's1', [use('b')]),
      result(11, 'b', { permissionDecision: CONFIG }),
      block(12, 's2'),
    ];
    const session = await calendarOf(main, sub);
    // 推論: 本体 1+1+1+1 = 4s、サブ 1+1 = 2s。自動ツール: 本体 c 10s・サブ b 10s（どちらも縮まない: U=10s <= 30s）。
    // 許可ツール a には 30s − 20s = 10s を配る
    assert.equal(sumCol(session, BUSY_COL), 4000 + 2000 + 20000 + 10000);
  });
});

describe('キャッシュの読み込みと走査', () => {
  // 実際の JSONL と食い違う集計を持つキャッシュ（採用されたかを見分けるため）
  async function withCache(cacheContent, records = [prompt('やって')]) {
    const { dir, cacheFile } = await makeEnv();
    await writeMain(dir, records);
    const path = join(dir, '-home-me-a', 's1.jsonl');
    const content = typeof cacheContent === 'function' ? cacheContent(path) : cacheContent;
    await writeFile(cacheFile, typeof content === 'string' ? content : JSON.stringify(content));
    return getActivityHeatmap({ days: 3, dir, cacheFile });
  }
  const fakeEntry = (extra = {}) => {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      offset: 10 ** 9,
      daily: { [date]: [50, 0, 0, 0, 0, 0] },
      slots: {},
      prompts: [],
      busy: emptyBusyState(),
      costStates: {},
      ...extra,
    };
  };

  it('版の違うキャッシュ・壊れたキャッシュは使わず読み直す', async () => {
    const size = Buffer.byteLength(jsonl([prompt('やって')]));
    const entry = (path) => ({ [path]: fakeEntry({ offset: size }) });
    assert.equal((await withCache((path) => ({ version: 6, files: entry(path) }))).total.prompts, 1);
    assert.equal((await withCache((path) => ({ files: entry(path) }))).total.prompts, 1);
    assert.equal((await withCache('null')).total.prompts, 1);
    // 同じ版なら使う（読み直さない）
    assert.equal((await withCache((path) => ({ version: 7, files: entry(path) }))).total.prompts, 50);
  });

  it('offset が数値でないエントリは先頭から読み直す', async () => {
    const result = await withCache((path) => ({ version: 7, files: { [path]: fakeEntry({ offset: '0' }) } }));
    assert.equal(result.total.prompts, 1);
  });

  it('稼働の状態や指示の時刻を持たない古いエントリからも続きを読む', async () => {
    const { dir, cacheFile } = await makeEnv();
    const first = jsonl([human(0)]);
    await writeMain(dir, [human(0)]);
    const path = join(dir, '-home-me-a', 's1.jsonl');
    await writeFile(
      cacheFile,
      JSON.stringify({ version: 7, files: { [path]: { offset: Buffer.byteLength(first), daily: {}, slots: {} } } }),
    );
    await writeFile(path, first + jsonl([human(60)]));
    const { sessions } = await getActivityCalendar({ ...RANGE, dir, cacheFile });
    assert.deepEqual(sessions[0].prompts, [[BASE / 60000 + 1, 1]]);
  });

  it('前回までの指示の時刻を引き継いで追記分を足す', async () => {
    const { dir, cacheFile } = await makeEnv();
    await writeMain(dir, [human(0)]);
    await getActivityCalendar({ ...RANGE, dir, cacheFile });
    resetActivityHeatmapState();
    await writeMain(dir, [human(0), human(120)]);
    const { sessions } = await getActivityCalendar({ ...RANGE, dir, cacheFile });
    assert.deepEqual(sessions[0].prompts, [
      [BASE / 60000, 1],
      [BASE / 60000 + 2, 1],
    ]);
  });

  it('読めない行は飛ばして残りの行を数える', async () => {
    const { dir, cacheFile } = await makeEnv();
    await writeFile(join(dir, '-home-me-a', 's1.jsonl'), jsonl(['{broken', prompt('やって'), '   ']));
    assert.equal((await getActivityHeatmap({ days: 3, dir, cacheFile })).total.prompts, 1);
  });

  it('チャンクの境目で多バイト文字が割れても、追記分を正しい位置から読む', async () => {
    const { dir, cacheFile } = await makeEnv();
    const path = join(dir, '-home-me-a', 's1.jsonl');
    // 64KB（読み込みのチャンク）の境目が「あ」（3 バイト）の途中に来るよう前置きの長さをそろえる
    const make = (pad) =>
      JSON.stringify({ ...prompt('x'), message: { content: `${'a'.repeat(pad)}${'あ'.repeat(30000)}` } });
    let pad = 0;
    while ((65536 - Buffer.byteLength(make(pad).split('あ')[0])) % 3 !== 1) pad++;
    const first = `${make(pad)}\n`;
    await writeFile(path, first);
    assert.equal((await getActivityHeatmap({ days: 3, dir, cacheFile })).total.prompts, 1);
    resetActivityHeatmapState();
    await writeFile(path, first + jsonl([prompt('次')]));
    assert.equal((await getActivityHeatmap({ days: 3, dir, cacheFile })).total.prompts, 2);
  });

  it('同時に来た要求は最初の走査を共有し、リセット後の要求は新しく走査する', async () => {
    const a = await makeEnv();
    const b = await makeEnv();
    await writeMain(a.dir, [prompt('やって')]);
    await writeMain(b.dir, [prompt('やって'), prompt('もう一回')]);
    const [first, second] = await Promise.all([
      getActivityHeatmap({ days: 3, ...a }),
      getActivityHeatmap({ days: 3, ...b }),
    ]);
    assert.equal(first.total.prompts, 1);
    assert.equal(second.total.prompts, 1);
    const pending = getActivityHeatmap({ days: 3, ...a });
    resetActivityHeatmapState();
    const fresh = await getActivityHeatmap({ days: 3, ...b });
    await pending;
    assert.equal(fresh.total.prompts, 2);
  });

  it('更新されたばかりのファイルの保留中のツールはまだ数えない', async () => {
    const session = await calendarOf([
      human(0),
      block(1, 'r1', [use('a')]),
      result(301, 'a', { permissionDecision: CONFIG }),
    ]);
    // 推論 1s だけ（ツールは応答の確定を待って保留）
    assert.equal(sumCol(session, BUSY_COL), 1000);
  });
});

describe('cost-state の打ち切りに使う会話の位置', () => {
  const run = (between) =>
    calendarOf([
      human(0),
      block(1, 'r1', [use('a')]),
      result(101, 'a', { permissionDecision: CONFIG }),
      block(102, 'r2'),
      costState(0, 10000, 3600),
      ...between,
      human(200),
      block(201, 'r3', [use('b')]),
      result(301, 'b', { permissionDecision: CONFIG }),
      block(302, 'r4'),
      costState(0, 10000, 3600),
    ]);

  it('時刻の読めない行を挟んでも、会話を挟んだ書き直しとして打ち切る', async () => {
    const plain = await run([]);
    const broken = await run([{ type: 'user', timestamp: 'broken', message: { content: 'x' } }]);
    assert.equal(sumCol(broken, BUSY_COL), sumCol(plain, BUSY_COL));
    // a は実測 10s に縮み、打ち切り後の b（config）は 100s のまま。推論 1+1+1+1 = 4s
    assert.equal(sumCol(plain, BUSY_COL), 10000 + 100000 + 4000);
  });

  it('会話の位置は時刻が前後しても最も遅い時刻で表す', async () => {
    // 書き直しの直前の行が前の cost-state より前の時刻でも、それより後の会話があれば打ち切る
    const session = await calendarOf([
      human(0),
      block(1, 'r1', [use('a')]),
      result(101, 'a', { permissionDecision: CONFIG }),
      block(102, 'r2'),
      costState(0, 10000, 3600),
      human(200),
      block(201, 'r3', [use('b')]),
      result(301, 'b', { permissionDecision: CONFIG }),
      block(302, 'r4'),
      human(50),
      costState(0, 10000, 3600),
    ]);
    assert.equal(sumCol(session, BUSY_COL), 10000 + 100000 + 4000);
  });
});
