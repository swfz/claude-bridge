// チャットのツール行・束の整形（client/src/utils/toolLines.js）と、
// サーバーが流すツールの結果の印（server/jsonl-utils.js の extractToolResultFlags）のテスト
import { describe, it } from 'vitest';
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
  hookErrorText,
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

  it('フックの失敗はツールの成否と別に付き、中身ごと文字列を往復する', () => {
    const hookError = { name: 'PostToolUse:Edit', exitCode: '1', command: 'a.sh', detail: 'x|y:z' };
    const index = buildToolResultIndex([
      { role: 'toolresult', results: [{ id: 't1', created: true }] },
      { role: 'toolresult', results: [{ id: 't1', hookError }] },
    ]);
    const key = toolFlagsKey([{ id: 't1' }], index);
    assert.deepEqual(parseToolFlagsKey(key).get('t1'), { created: true, hookError });
    assert.equal(summarizeToolRun([{ id: 't1', name: 'Read' }], index).hookFailed, 1);
    assert.equal(hookErrorText(hookError), 'PostToolUse:Edit が失敗（exit 1）: x|y:z\na.sh');
    assert.equal(hookErrorText({ name: 'Stop' }), 'Stop が失敗');
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
    assert.deepEqual(summary, { count: 3, failed: 1, hookFailed: 0, added: 4, removed: 1 });
    assert.deepEqual(summarizeToolRun(null), { count: 0, failed: 0, hookFailed: 0, added: 0, removed: 0 });
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
    assert.deepEqual(flags, [{ id: 't1', error: true }, { id: 't2' }]);
  });

  it('Write の新規作成（toolUseResult.type === create）は created', () => {
    const flags = extractToolResultFlags(
      userRecord([{ type: 'tool_result', tool_use_id: 'w1' }], { type: 'create', filePath: '/a' }),
    );
    assert.deepEqual(flags, [{ id: 'w1', created: true }]);
  });

  it('上書き・普通の成功は id だけ返す', () => {
    assert.deepEqual(
      extractToolResultFlags(userRecord([{ type: 'tool_result', tool_use_id: 'w' }], { type: 'update' })),
      [{ id: 'w' }],
    );
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'tool_result', tool_use_id: 'x' }], ['arr'])), [
      { id: 'x' },
    ]);
  });

  it('tool_result 以外・user 以外は何も返さない', () => {
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'text', text: 'hi' }])), []);
    assert.deepEqual(extractToolResultFlags(userRecord('plain')), []);
    assert.deepEqual(extractToolResultFlags(userRecord([{ type: 'tool_result' }])), []);
    assert.deepEqual(extractToolResultFlags({ type: 'assistant', message: { content: [] } }), []);
    assert.deepEqual(extractToolResultFlags(null), []);
  });
});

describe('toolLines: 欠けた入力と境界', () => {
  it('Write / Edit / MultiEdit もファイルを扱うツールとしてパスを返す', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit']) {
      assert.equal(toolFilePath(tool('t', name, { file_path: '/r/a.js' })), '/r/a.js');
    }
  });

  it('input が無い・パスが文字列でないファイルツールはパス無し', () => {
    assert.equal(toolFilePath({ id: 't', name: 'Read' }), null);
    assert.equal(toolFilePath(tool('t', 'Read', { file_path: 123 })), null);
  });

  it('splitFilePath: パスが無ければ空、ルート直下・連続スラッシュの cwd も扱える', () => {
    assert.deepEqual(splitFilePath(null), { dir: '', name: '' });
    assert.deepEqual(splitFilePath('/a.js'), { dir: '/', name: 'a.js' });
    assert.deepEqual(splitFilePath('/r/src/a.js', '/r//'), { dir: 'src/', name: 'a.js' });
  });

  it('lineDiffStats: 末尾の改行の有無だけの違いは差分にしない', () => {
    assert.deepEqual(lineDiffStats('a\nb\n', 'a\nb'), { added: 0, removed: 0 });
    assert.deepEqual(lineDiffStats('a', 'a\n'), { added: 0, removed: 0 });
  });

  it('Edit の old_string が無ければ追加だけ数える', () => {
    assert.deepEqual(toolDiffStats(tool('t', 'Edit', { new_string: 'x\ny' })), {
      added: 2,
      removed: 0,
      created: false,
    });
  });

  it('MultiEdit の edits に欠けた要素があっても数えられる', () => {
    const t = tool('t', 'MultiEdit', { edits: [null, { old_string: 'a', new_string: 'b' }] });
    assert.deepEqual(toolDiffStats(t), { added: 1, removed: 1, created: false });
  });

  it('buildToolResultIndex は toolresult 以外のメッセージと欠けた要素を無視する', () => {
    const index = buildToolResultIndex([
      null,
      { role: 'assistant', results: [{ id: 'x', error: true }] },
      { role: 'toolresult', results: [{ id: 'y', error: true }] },
    ]);
    assert.deepEqual([...index.keys()], ['y']);
  });

  it('toolFlagsKey は欠けたツールを飛ばし、フックの失敗だけのツールに新規作成の印を付けない', () => {
    const index = new Map([['t1', { hookError: { name: 'h' } }]]);
    const key = toolFlagsKey([null, { id: 't1' }], index);
    assert.equal(key, `h:t1:${encodeURIComponent(JSON.stringify({ name: 'h' }))}`);
    assert.deepEqual([...parseToolFlagsKey(key)], [['t1', { hookError: { name: 'h' } }]]);
  });

  it('parseToolFlagsKey: キーが無ければ空、id の無いフック・壊れた中身は捨てる', () => {
    assert.equal(parseToolFlagsKey(null).size, 0);
    assert.equal(parseToolFlagsKey(undefined).size, 0);
    assert.equal(parseToolFlagsKey('h::%7B%7D').size, 0);
    assert.equal(parseToolFlagsKey('h:123').size, 0);
    assert.equal(parseToolFlagsKey('h:t1:%7Bbroken').size, 0);
  });

  it('hookErrorText: フックが無ければ空、名前が無ければ hook と出す', () => {
    assert.equal(hookErrorText(null), '');
    assert.equal(hookErrorText({}), 'hook が失敗');
  });

  it('isToolOnlyMessage: 空白だけの本文はツールだけ扱い、assistant 以外・null は対象外', () => {
    assert.equal(isToolOnlyMessage({ role: 'assistant', content: '  \n', toolUses: [{ id: 't' }] }), true);
    assert.equal(isToolOnlyMessage({ role: 'human', content: '', toolUses: [{ id: 't' }] }), false);
    assert.equal(isToolOnlyMessage(null), false);
  });

  it('toolDescription: 何も手がかりが無ければ空文字', () => {
    assert.equal(toolDescription({ input: {} }), '');
  });

  it('summarizeToolRun: 印の索引が無い・欠けたツールがあっても数える', () => {
    const tools = [null, tool('w', 'Write', { content: 'a\nb' })];
    assert.deepEqual(summarizeToolRun(tools), { count: 2, failed: 0, hookFailed: 0, added: 2, removed: 0 });
    assert.deepEqual(summarizeToolRun(tools, new Map([['w', { error: true }]])), {
      count: 2,
      failed: 1,
      hookFailed: 0,
      added: 2,
      removed: 0,
    });
  });
});
