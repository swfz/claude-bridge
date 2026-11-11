// チャットのツール行・束の整形（client/src/utils/toolLines.js）と、
// サーバーが流すツールの結果の印（server/jsonl-utils.js の extractToolResultFlags）のテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolResultIndex,
  countLines,
  groupChatItems,
  isToolOnlyMessage,
  lineDiffStats,
  parseToolFlagsKey,
  splitFilePath,
  summarizeToolRun,
  toolDescription,
  toolDiffStats,
  toolFilePath,
  toolFlagsKey,
} from '../client/src/utils/toolLines.js';
import { extractToolResultFlags } from '../server/jsonl-utils.js';

const tool = (id, name, input = {}) => ({ id, name, input, summary: name });
const toolMsg = (id, ...tools) => ({ id, role: 'assistant', content: '', toolUses: tools });

describe('toolFilePath / splitFilePath', () => {
  it('ファイル系ツールだけパスを返す（NotebookEdit は notebook_path）', () => {
    assert.equal(toolFilePath(tool('1', 'Read', { file_path: '/a/b.js' })), '/a/b.js');
    assert.equal(toolFilePath(tool('1', 'NotebookEdit', { notebook_path: '/a/n.ipynb' })), '/a/n.ipynb');
    assert.equal(toolFilePath(tool('1', 'Bash', { file_path: '/a/b.js' })), null);
    assert.equal(toolFilePath(tool('1', 'Edit', {})), null);
    assert.equal(toolFilePath(null), null);
  });

  it('cwd 配下は相対にし、ディレクトリとファイル名に分ける', () => {
    assert.deepEqual(splitFilePath('/repo/client/src/App.jsx', '/repo/'), { dir: 'client/src/', name: 'App.jsx' });
    assert.deepEqual(splitFilePath('/repo/README.md', '/repo'), { dir: '', name: 'README.md' });
    assert.deepEqual(splitFilePath('/etc/hosts', '/repo'), { dir: '/etc/', name: 'hosts' });
    assert.deepEqual(splitFilePath('/etc/hosts', null), { dir: '/etc/', name: 'hosts' });
    assert.deepEqual(splitFilePath('', '/repo'), { dir: '', name: '' });
  });
});

describe('countLines / lineDiffStats', () => {
  it('末尾の改行は数えない', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines(undefined), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\nb\n'), 2);
  });

  it('変わっていない文脈行は打ち消し、増減だけ数える', () => {
    assert.deepEqual(lineDiffStats('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 });
    assert.deepEqual(lineDiffStats('', 'x\ny'), { added: 2, removed: 0 });
    assert.deepEqual(lineDiffStats('x\nx', 'x'), { added: 0, removed: 1 });
  });
});

describe('toolDiffStats', () => {
  it('Edit は置換前後の増減', () => {
    assert.deepEqual(toolDiffStats(tool('1', 'Edit', { old_string: 'a\nb', new_string: 'a\nc\nd' })), {
      added: 2,
      removed: 1,
      created: false,
    });
  });

  it('MultiEdit は各編集の合計', () => {
    const t = tool('1', 'MultiEdit', {
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'c\nd' },
      ],
    });
    assert.deepEqual(toolDiffStats(t), { added: 2, removed: 1, created: false });
    assert.deepEqual(toolDiffStats(tool('2', 'MultiEdit', {})), { added: 0, removed: 0, created: false });
  });

  it('Write は全行が追加。新規作成の印があれば created', () => {
    const t = tool('1', 'Write', { content: 'a\nb\nc\n' });
    assert.deepEqual(toolDiffStats(t), { added: 3, removed: 0, created: false });
    assert.deepEqual(toolDiffStats(t, { created: true }), { added: 3, removed: 0, created: true });
  });

  it('書き換えないツールは null', () => {
    assert.equal(toolDiffStats(tool('1', 'Read', { file_path: '/a' })), null);
    assert.equal(toolDiffStats(null), null);
  });
});

describe('buildToolResultIndex / toolFlagsKey / parseToolFlagsKey', () => {
  const messages = [
    { role: 'assistant', toolUses: [] },
    { role: 'toolresult', results: [{ id: 't1', error: true }] },
    { role: 'toolresult', results: [{ id: 't2', created: true }, null] },
    { role: 'toolresult' },
  ];

  it('toolresult メッセージから id → 印を引ける', () => {
    const index = buildToolResultIndex(messages);
    assert.deepEqual(index.get('t1'), { id: 't1', error: true });
    assert.deepEqual(index.get('t2'), { id: 't2', created: true });
    assert.equal(index.size, 2);
    assert.equal(buildToolResultIndex(null).size, 0);
  });

  it('メッセージのツールの印を文字列にして、同じ中身なら同じ文字列になる（memo 用）', () => {
    const index = buildToolResultIndex(messages);
    const key = toolFlagsKey([{ id: 't1' }, { id: 't2' }, { id: 't3' }], index);
    assert.equal(key, 'e:t1|c:t2');
    assert.equal(toolFlagsKey([{ id: 't3' }], index), '');
    assert.equal(toolFlagsKey(undefined, index), '');
    assert.equal(toolFlagsKey([{ id: 't1' }], new Map()), '');
  });

  it('文字列から印に戻す', () => {
    const flags = parseToolFlagsKey('e:t1|c:t2|x:');
    assert.deepEqual(flags.get('t1'), { error: true });
    assert.deepEqual(flags.get('t2'), { created: true });
    assert.equal(flags.size, 2);
    assert.equal(parseToolFlagsKey('').size, 0);
  });
});

describe('groupChatItems', () => {
  it('ツールだけのメッセージが続いて 2 件以上なら 1 つの束にする', () => {
    const items = groupChatItems([
      { id: 'h', role: 'human', content: 'やって' },
      toolMsg('a', tool('1', 'Read')),
      toolMsg('b', tool('2', 'Edit')),
      { id: 'r', role: 'assistant', content: '直しました', toolUses: [] },
      toolMsg('c', tool('3', 'Bash')),
      { id: 'x', role: 'artifact', content: 't' },
      toolMsg('d', tool('4', 'Read'), tool('5', 'Read')),
    ]);
    assert.deepEqual(
      items.map((it) => [it.kind, it.key, it.kind === 'tools' ? it.messages.map((m) => m.id) : it.message.id]),
      [
        ['message', 'h', 'h'],
        ['tools', 'tools-a', ['a', 'b']],
        ['message', 'r', 'r'],
        ['message', 'c', 'c'],
        ['message', 'x', 'x'],
        ['tools', 'tools-d', ['d']],
      ],
    );
  });

  it('過去の会話と新着の境目では束を切る', () => {
    const items = groupChatItems([
      { ...toolMsg('a', tool('1', 'Read')), isHistory: true },
      { ...toolMsg('b', tool('2', 'Read')), isHistory: true },
      toolMsg('c', tool('3', 'Bash'), tool('4', 'Bash')),
    ]);
    assert.deepEqual(
      items.map((it) => it.key),
      ['tools-a', 'tools-c'],
    );
  });

  it('本文のあるメッセージはツール付きでも束に入れない', () => {
    const m = { id: 'm', role: 'assistant', content: '見ます', toolUses: [tool('1', 'Read')] };
    assert.equal(isToolOnlyMessage(m), false);
    assert.equal(isToolOnlyMessage(toolMsg('a', tool('1', 'Read'))), true);
    assert.equal(isToolOnlyMessage({ role: 'assistant', content: '', toolUses: [] }), false);
    assert.deepEqual(groupChatItems(null), []);
  });
});

describe('toolDescription', () => {
  it('summary を優先し、ツール名のままなら URL・クエリ、無ければツール名', () => {
    assert.equal(toolDescription({ name: 'Bash', summary: 'npm test', input: {} }), 'npm test');
    assert.equal(
      toolDescription({ name: 'WebFetch', summary: 'WebFetch', input: { url: 'https://a.example' } }),
      'https://a.example',
    );
    assert.equal(toolDescription({ name: 'WebSearch', input: { query: 'q' } }), 'q');
    assert.equal(toolDescription({ name: 'Foo', summary: 'Foo' }), 'Foo');
    assert.equal(toolDescription(null), '');
  });
});

describe('summarizeToolRun', () => {
  it('件数・失敗件数・差分の合計', () => {
    const index = new Map([
      ['1', { error: true }],
      ['3', { created: true }],
    ]);
    const summary = summarizeToolRun(
      [
        tool('1', 'Bash'),
        tool('2', 'Edit', { old_string: 'a', new_string: 'b\nc' }),
        tool('3', 'Write', { content: 'x\ny' }),
      ],
      index,
    );
    assert.deepEqual(summary, { count: 3, failed: 1, added: 4, removed: 1 });
    assert.deepEqual(summarizeToolRun(null), { count: 0, failed: 0, added: 0, removed: 0 });
  });
});

describe('extractToolResultFlags', () => {
  const userRecord = (content, toolUseResult) => ({ type: 'user', message: { content }, toolUseResult });

  it('is_error の tool_result は失敗', () => {
    const flags = extractToolResultFlags(
      userRecord([
        { type: 'tool_result', tool_use_id: 't1', is_error: true },
        { type: 'tool_result', tool_use_id: 't2' },
      ]),
    );
    assert.deepEqual(flags, [{ id: 't1', error: true }]);
  });

  it('Write の新規作成（toolUseResult.type === create）は created', () => {
    const flags = extractToolResultFlags(
      userRecord([{ type: 'tool_result', tool_use_id: 'w1' }], { type: 'create', filePath: '/a' }),
    );
    assert.deepEqual(flags, [{ id: 'w1', created: true }]);
  });

  it('上書き・普通の成功・tool_result 以外・user 以外は何も返さない', () => {
    assert.deepEqual(
      extractToolResultFlags(userRecord([{ type: 'tool_result', tool_use_id: 'w' }], { type: 'update' })),
      [],
    );
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'text', text: 'hi' }])), []);
    assert.deepEqual(extractToolResultFlags(userRecord('plain')), []);
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'tool_result' }])), []);
    assert.deepEqual(extractToolResultFlags({ type: 'assistant', message: { content: [] } }), []);
    assert.deepEqual(extractToolResultFlags(null), []);
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'tool_result', tool_use_id: 'x' }], ['arr'])), []);
  });
});
