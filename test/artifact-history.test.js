import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryLines } from '../server/claude-sessions.js';

const URL = 'https://claude.ai/code/artifact/46f54464-0000-0000-0000-000000000000';

const publishRecord = (overrides = {}) => ({
  type: 'user',
  uuid: 'u-artifact',
  timestamp: '2026-06-19T07:50:17.709Z',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: `Published at ${URL}` }],
  },
  toolUseResult: { url: URL, path: '/tmp/report.html', title: 'dotfiles レポート' },
  ...overrides,
});

describe('parseHistoryLines と Artifact の公開リンク', () => {
  it('publish 成功の user レコードから artifact メッセージを作る', () => {
    const content = [JSON.stringify(publishRecord())].join('\n');
    const messages = parseHistoryLines(content);

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
      role: 'artifact',
      content: 'dotfiles レポート',
      url: URL,
      title: 'dotfiles レポート',
      path: '/tmp/report.html',
      uuid: 'u-artifact',
      timestamp: '2026-06-19T07:50:17.709Z',
    });
  });

  it('人の発言と混ざっても既存の human/assistant はそのまま残る', () => {
    const content = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: '公開して' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: '公開しました' }] },
      }),
      JSON.stringify(publishRecord()),
    ].join('\n');

    assert.deepEqual(
      parseHistoryLines(content).map((m) => m.role),
      ['human', 'assistant', 'artifact'],
    );
  });

  it('publish 失敗（is_error）や url の無い結果は artifact にしない', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'e1',
        message: {
          role: 'user',
          content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'Error', is_error: true }],
        },
        toolUseResult: 'Error: publish failed',
      }),
      JSON.stringify(publishRecord({ toolUseResult: { read: true, artifactRead: '<html>' } })),
    ].join('\n');

    assert.deepEqual(parseHistoryLines(content), []);
  });
});
