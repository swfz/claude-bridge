import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRecentExchanges, clearSessionRecentCache, readRecentExchanges } from '../server/session-recent.js';

const prompt = (text, timestamp = '2026-10-04T01:00:00.000Z') => ({
  type: 'user',
  timestamp,
  message: { role: 'user', content: text },
});
const assistant = (content, timestamp = '2026-10-04T01:00:05.000Z') => ({
  type: 'assistant',
  timestamp,
  message: { role: 'assistant', content },
});
const text = (t) => ({ type: 'text', text: t });
const toolUse = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

async function writeJsonl(records) {
  const dir = await mkdtemp(join(tmpdir(), 'session-recent-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('buildRecentExchanges', () => {
  it('3 往復を超えたら最後の 3 件を古い順に返す', () => {
    const records = [];
    for (let i = 1; i <= 5; i++) {
      records.push(prompt(`指示 ${i}`, `2026-10-04T0${i}:00:00.000Z`));
      records.push(assistant([text(`応答 ${i}`)], `2026-10-04T0${i}:00:30.000Z`));
    }
    const exchanges = buildRecentExchanges(records);
    assert.deepEqual(
      exchanges.map((e) => [e.prompt, e.reply]),
      [
        ['指示 3', '応答 3'],
        ['指示 4', '応答 4'],
        ['指示 5', '応答 5'],
      ],
    );
    assert.equal(exchanges[0].promptAt, '2026-10-04T03:00:00.000Z');
    assert.equal(exchanges[0].replyAt, '2026-10-04T03:00:30.000Z');
  });

  it('注入・meta・中断・tool_result は区切りにしない', () => {
    const records = [
      prompt('本当の指示'),
      assistant([text('途中の応答'), toolUse('t1')]),
      toolResult('t1'),
      prompt('<task-notification>完了しました</task-notification>'),
      { ...prompt('meta の本文'), isMeta: true },
      prompt('[Request interrupted by user]'),
      assistant([text('最後の応答')]),
    ];
    const exchanges = buildRecentExchanges(records);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].prompt, '本当の指示');
    assert.equal(exchanges[0].reply, '最後の応答');
  });

  it('スラッシュコマンドは /name 引数 の形にする', () => {
    const records = [
      prompt(
        '<command-message>ship</command-message>\n<command-name>/ship</command-name>\n<command-args>main</command-args>',
      ),
      assistant([text('出しました')]),
    ];
    assert.equal(buildRecentExchanges(records)[0].prompt, '/ship main');
  });

  it('指示と応答の改行を保つ', () => {
    const records = [prompt('1 行目\n\n2 行目\n'), assistant([text('  a\nb  ')])];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.prompt, '1 行目\n\n2 行目');
    assert.equal(ex.reply, 'a\nb');
  });

  it('textMax を超えたら切って Truncated を立てる', () => {
    const records = [prompt('あ'.repeat(30)), assistant([text('い'.repeat(5))])];
    const [ex] = buildRecentExchanges(records, { textMax: 10 });
    assert.equal(ex.prompt, 'あ'.repeat(10));
    assert.equal(ex.promptTruncated, true);
    assert.equal(ex.reply, 'い'.repeat(5));
    assert.equal(ex.replyTruncated, false);
  });

  it('応答が無ければ reply は空', () => {
    const [ex] = buildRecentExchanges([prompt('返事が来る前')]);
    assert.equal(ex.reply, '');
    assert.equal(ex.replyAt, '');
    assert.equal(ex.toolCount, 0);
  });

  it('tool_use の数を数え、本文のある最後の assistant を応答にする', () => {
    const records = [
      prompt('調べて'),
      assistant([text('読みます'), toolUse('a')]),
      toolResult('a'),
      assistant([toolUse('b'), toolUse('c')]),
      toolResult('b'),
      toolResult('c'),
      assistant([text('分かりました')]),
      assistant([toolUse('d')]),
    ];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.toolCount, 4);
    assert.equal(ex.reply, '分かりました');
  });

  it('最初の指示より前の応答は捨てる', () => {
    const records = [assistant([text('切れ目の前')]), prompt('指示'), assistant([text('応答')])];
    const exchanges = buildRecentExchanges(records);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].reply, '応答');
  });
});

describe('readRecentExchanges', () => {
  beforeEach(() => clearSessionRecentCache());

  it('JSONL から直近の往復を読み、追記されたら読み直す', async () => {
    const file = await writeJsonl([prompt('最初'), assistant([text('はい')])]);
    let result = await readRecentExchanges(file);
    assert.deepEqual(
      result.exchanges.map((e) => e.prompt),
      ['最初'],
    );
    // 同じ stat ならキャッシュを返す
    assert.equal(await readRecentExchanges(file), result);

    await appendFile(file, JSON.stringify(prompt('次')) + '\n');
    result = await readRecentExchanges(file);
    assert.deepEqual(
      result.exchanges.map((e) => e.prompt),
      ['最初', '次'],
    );
  });

  it('1MB を超える JSONL は末尾だけ読み、先頭の壊れた行を捨てる', async () => {
    const filler = assistant([text('x'.repeat(200 * 1024))]);
    const records = [prompt('古い指示')];
    for (let i = 0; i < 8; i++) records.push(filler);
    records.push(prompt('新しい指示'), assistant([text('新しい応答')]));
    const file = await writeJsonl(records);
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => [e.prompt, e.reply]),
      [['新しい指示', '新しい応答']],
    );
  });

  it('ファイルが無ければ reject する', async () => {
    await assert.rejects(readRecentExchanges(join(tmpdir(), 'no-such-session-recent.jsonl')));
  });
});
