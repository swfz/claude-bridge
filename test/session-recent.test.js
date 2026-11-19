import { describe, it, beforeEach } from 'vitest';
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

describe('buildRecentExchanges (境界)', () => {
  it('textMax が 0 なら切らない', () => {
    const [ex] = buildRecentExchanges([prompt('あ'.repeat(30)), assistant([text('い'.repeat(30))])], { textMax: 0 });
    assert.equal(ex.prompt, 'あ'.repeat(30));
    assert.equal(ex.promptTruncated, false);
    assert.equal(ex.reply, 'い'.repeat(30));
    assert.equal(ex.replyTruncated, false);
  });

  it('textMax ちょうどの長さは切らない', () => {
    const [ex] = buildRecentExchanges([prompt('あ'.repeat(10)), assistant([text('い'.repeat(11))])], { textMax: 10 });
    assert.equal(ex.promptTruncated, false);
    assert.equal(ex.replyTruncated, true);
    assert.equal(ex.reply, 'い'.repeat(10));
  });

  it('timestamp の無い指示・応答の時刻は空文字', () => {
    const records = [
      { type: 'user', message: { role: 'user', content: '時刻なし' } },
      { type: 'assistant', message: { role: 'assistant', content: [text('返事')] } },
    ];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.promptAt, '');
    assert.equal(ex.replyAt, '');
    assert.equal(ex.reply, '返事');
  });

  it('本文が文字列の assistant は応答・ツール数に数えない', () => {
    const records = [
      prompt('指示'),
      assistant([text('配列の応答')]),
      { type: 'assistant', message: { role: 'assistant', content: '文字列の応答' } },
    ];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.reply, '配列の応答');
    assert.equal(ex.toolCount, 0);
  });

  it('本文の無い assistant は直前の応答を上書きしない', () => {
    const records = [
      prompt('指示'),
      assistant([text('本文')], '2026-10-04T01:00:05.000Z'),
      assistant([text('   ')], '2026-10-04T01:00:09.000Z'),
    ];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.reply, '本文');
    assert.equal(ex.replyAt, '2026-10-04T01:00:05.000Z');
  });

  it('message の無い assistant は飛ばす', () => {
    const [ex] = buildRecentExchanges([prompt('指示'), assistant([text('応答')]), { type: 'assistant' }]);
    assert.equal(ex.reply, '応答');
  });

  it('区切りにならない user の配列本文は応答として扱わない', () => {
    const records = [
      prompt('指示'),
      assistant([text('本当の応答')]),
      { type: 'user', isMeta: true, message: { role: 'user', content: [text('meta の本文'), toolUse('x')] } },
    ];
    const [ex] = buildRecentExchanges(records);
    assert.equal(ex.reply, '本当の応答');
    assert.equal(ex.toolCount, 0);
  });

  it('limit で返す往復の数を変えられる', () => {
    const records = [prompt('1'), prompt('2'), prompt('3'), prompt('4')];
    assert.deepEqual(
      buildRecentExchanges(records, { limit: 2 }).map((e) => e.prompt),
      ['3', '4'],
    );
  });
});

describe('readRecentExchanges (末尾の読み方とキャッシュ)', () => {
  beforeEach(() => clearSessionRecentCache());

  async function writeRaw(text) {
    const dir = await mkdtemp(join(tmpdir(), 'session-recent-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, text);
    return file;
  }

  // 全体は壊れた行だが、途中から読むと有効な指示の JSON に見える行
  const brokenLineWithPromptTail = (spaces) =>
    'BROKEN' + ' '.repeat(spaces) + JSON.stringify(prompt('切れ目の後ろの指示'));

  it('途中から読んだときは、先頭の欠けた行が JSON として読めても捨てる', async () => {
    const file = await writeRaw(
      brokenLineWithPromptTail(1536 * 1024) + '\n' + JSON.stringify(prompt('末尾の指示')) + '\n',
    );
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => e.prompt),
      ['末尾の指示'],
    );
  });

  it('末尾 1MB に改行が無ければ何も返さない', async () => {
    const file = await writeRaw(brokenLineWithPromptTail(1536 * 1024));
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(exchanges, []);
  });

  it('末尾に改行の無い 1MB 超のファイルも最後の行を読む', async () => {
    const filler = JSON.stringify(assistant([text('x'.repeat(1200 * 1024))]));
    const file = await writeRaw(filler + '\n' + JSON.stringify(prompt('改行なしの最後の指示')));
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => e.prompt),
      ['改行なしの最後の指示'],
    );
  });

  it('clearSessionRecentCache の後は同じ stat でも読み直す', async () => {
    const file = await writeJsonl([prompt('指示A')]);
    const { utimes } = await import('fs/promises');
    const fixed = new Date('2026-10-01T00:00:00.000Z');
    await utimes(file, fixed, fixed);
    assert.equal((await readRecentExchanges(file)).exchanges[0].prompt, '指示A');
    await writeFile(file, JSON.stringify(prompt('指示B')) + '\n');
    await utimes(file, fixed, fixed);
    assert.equal((await readRecentExchanges(file)).exchanges[0].prompt, '指示A');
    clearSessionRecentCache();
    assert.equal((await readRecentExchanges(file)).exchanges[0].prompt, '指示B');
  });

  it('1MB 以下のファイルは先頭行も読む', async () => {
    const file = await writeRaw(JSON.stringify(prompt('先頭の指示')) + '\n');
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => e.prompt),
      ['先頭の指示'],
    );
  });

  it('limit・textMax が違えばキャッシュを使わず作り直す', async () => {
    const file = await writeJsonl([prompt('一番目の指示'), prompt('二番目の指示')]);
    const all = await readRecentExchanges(file, { limit: 3 });
    assert.equal(all.exchanges.length, 2);
    const one = await readRecentExchanges(file, { limit: 1 });
    assert.deepEqual(
      one.exchanges.map((e) => e.prompt),
      ['二番目の指示'],
    );
    const clipped = await readRecentExchanges(file, { limit: 1, textMax: 2 });
    assert.equal(clipped.exchanges[0].prompt, '二番');
    assert.equal(clipped.exchanges[0].promptTruncated, true);
  });

  it('同じサイズのまま書き換わって mtime が変わったら読み直す', async () => {
    const file = await writeJsonl([prompt('指示A')]);
    const first = await readRecentExchanges(file);
    assert.equal(first.exchanges[0].prompt, '指示A');
    await writeFile(file, JSON.stringify(prompt('指示B')) + '\n');
    const { utimes } = await import('fs/promises');
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    const second = await readRecentExchanges(file);
    assert.equal(second.exchanges[0].prompt, '指示B');
  });

  it('mtime が同じでもサイズが変われば読み直す', async () => {
    const file = await writeJsonl([prompt('指示A')]);
    const { utimes } = await import('fs/promises');
    const mtime = new Date('2026-10-01T00:00:00.000Z');
    await utimes(file, mtime, mtime);
    await readRecentExchanges(file);
    await appendFile(file, JSON.stringify(prompt('指示B')) + '\n');
    await utimes(file, mtime, mtime);
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => e.prompt),
      ['指示A', '指示B'],
    );
  });
});

describe('readRecentExchanges (読み始めがちょうど改行のとき)', () => {
  beforeEach(() => clearSessionRecentCache());

  it('末尾 1MB の先頭が改行なら、その次の行から全部読む', async () => {
    const TAIL = 1024 * 1024;
    const base = JSON.stringify({ ...prompt('境界の指示'), pad: '' });
    // 最後の行（改行込み）をちょうど 1MB - 1 バイトにすると、読み始めが直前の行末の改行になる
    const last = JSON.stringify({ ...prompt('境界の指示'), pad: 'p'.repeat(TAIL - 1 - 1 - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(last) + 1, TAIL - 1);
    const dir = await mkdtemp(join(tmpdir(), 'session-recent-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, JSON.stringify(prompt('古い指示')) + '\n' + last + '\n');
    const { exchanges } = await readRecentExchanges(file);
    assert.deepEqual(
      exchanges.map((e) => e.prompt),
      ['境界の指示'],
    );
  });
});

describe('buildRecentExchanges (message が文字列のレコード)', () => {
  it('message が文字列の指示もそのまま本文にする', () => {
    const [ex] = buildRecentExchanges([{ type: 'user', message: '文字列の指示' }]);
    assert.equal(ex.prompt, '文字列の指示');
  });
});
