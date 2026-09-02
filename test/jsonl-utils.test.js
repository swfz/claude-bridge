import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractArtifactPublish, extractTextContent, extractToolUses } from '../server/jsonl-utils.js';

describe('extractTextContent', () => {
  it('returns empty for null/undefined', () => {
    assert.equal(extractTextContent(null), '');
    assert.equal(extractTextContent(undefined), '');
  });

  it('returns string message directly', () => {
    assert.equal(extractTextContent('hello'), 'hello');
  });

  it('extracts from string content field', () => {
    assert.equal(extractTextContent({ content: 'hello' }), 'hello');
  });

  it('extracts from array content with text blocks', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    };
    assert.equal(extractTextContent(msg), 'Hello\n\nWorld');
  });

  it('ignores non-text blocks', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'tool_use', name: 'Read', input: {} },
      ],
    };
    assert.equal(extractTextContent(msg), '');
  });

  it('truncates with maxLen', () => {
    assert.equal(extractTextContent('hello world', 5), 'hello');
  });
});

describe('extractToolUses', () => {
  it('returns empty for null/undefined/string', () => {
    assert.deepEqual(extractToolUses(null), []);
    assert.deepEqual(extractToolUses(undefined), []);
    assert.deepEqual(extractToolUses('text'), []);
  });

  it('returns empty when content is not array', () => {
    assert.deepEqual(extractToolUses({ content: 'text' }), []);
  });

  it('summarizes Artifact tool by action / target file', () => {
    const msg = {
      content: [
        { type: 'tool_use', id: 'a', name: 'Artifact', input: { file_path: '/tmp/x/report.html' } },
        { type: 'tool_use', id: 'b', name: 'Artifact', input: { action: 'list' } },
      ],
    };
    const [publish, list] = extractToolUses(msg);
    assert.equal(publish.summary, 'publish .../x/report.html');
    assert.equal(list.summary, 'list');
  });

  it('extracts tool_use blocks', () => {
    const msg = {
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo/bar.js' } }],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't1');
    assert.equal(result[0].name, 'Read');
    assert.equal(result[0].input.file_path, '/foo/bar.js');
  });

  it('extracts Write tool with file_path and content', () => {
    const msg = {
      content: [
        {
          type: 'tool_use',
          id: 't2',
          name: 'Write',
          input: { file_path: '/home/user/hoge.md', content: '# Hello' },
          caller: { type: 'direct' },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Write');
    assert.equal(result[0].input.file_path, '/home/user/hoge.md');
    assert.ok(result[0].summary.includes('hoge.md'));
  });

  it('extracts multiple tool_use blocks from same content', () => {
    const msg = {
      content: [
        { type: 'text', text: 'Let me check...' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/b.js' } },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'Grep');
    assert.equal(result[1].name, 'Read');
  });

  it('skips thinking blocks', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Bash');
  });

  it('returns empty when content only has thinking/text blocks', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: 'done' },
      ],
    };
    assert.deepEqual(extractToolUses(msg), []);
  });

  it('generates summary with shortPath for file tools', () => {
    const msg = {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: { file_path: '/Users/user/project/src/components/App.jsx' },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.ok(result[0].summary.includes('components/App.jsx'));
  });

  it('summarizes AskUserQuestion with the questions themselves', () => {
    const msg = {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              { question: '好きな色は？', options: [] },
              { question: '好きな季節は？', options: [] },
            ],
          },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result[0].summary, '好きな色は？ / 好きな季節は？');
  });

  it('falls back to the tool name when AskUserQuestion has no questions', () => {
    const msg = {
      content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }],
    };
    assert.equal(extractToolUses(msg)[0].summary, 'AskUserQuestion');
  });
});

describe('extractArtifactPublish', () => {
  const publishRecord = (toolUseResult, block = {}) => ({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-06-19T07:50:17.709Z',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'Published ...', ...block }],
    },
    toolUseResult,
  });

  const URL = 'https://claude.ai/code/artifact/46f54464-0000-0000-0000-000000000000';

  it('extracts url/title/path from a successful publish', () => {
    const record = publishRecord({ url: URL, path: '/tmp/report.html', title: 'dotfiles レポート' });
    assert.deepEqual(extractArtifactPublish(record), {
      url: URL,
      title: 'dotfiles レポート',
      path: '/tmp/report.html',
    });
  });

  it('falls back to the file basename when title is missing', () => {
    const record = publishRecord({ url: URL, path: '/home/user/work/report.html' });
    assert.equal(extractArtifactPublish(record).title, 'report.html');
  });

  it('falls back to the url when neither title nor path is present', () => {
    assert.equal(extractArtifactPublish(publishRecord({ url: URL })).title, URL);
    assert.equal(extractArtifactPublish(publishRecord({ url: URL })).path, null);
  });

  it('returns null for a failed publish (string toolUseResult + is_error)', () => {
    const record = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'Error', is_error: true }],
      },
      toolUseResult: 'Error: publish failed',
    };
    assert.equal(extractArtifactPublish(record), null);
  });

  it('returns null when the tool_result block is an error even with a url', () => {
    assert.equal(extractArtifactPublish(publishRecord({ url: URL }, { is_error: true })), null);
  });

  it('returns null for urls outside claude.ai', () => {
    assert.equal(extractArtifactPublish(publishRecord({ url: 'https://example.com/artifact/1' })), null);
    assert.equal(extractArtifactPublish(publishRecord({ url: 'http://claude.ai/code/artifact/1' })), null);
  });

  it('returns null for read/list results that carry no url', () => {
    assert.equal(extractArtifactPublish(publishRecord({ read: true, artifactRead: '<html>' })), null);
    assert.equal(extractArtifactPublish(publishRecord({ artifacts: [{ url: URL }] })), null);
  });

  it('returns null for non-user records and missing/odd input', () => {
    assert.equal(extractArtifactPublish(null), null);
    assert.equal(extractArtifactPublish({ type: 'assistant', toolUseResult: { url: URL } }), null);
    assert.equal(extractArtifactPublish({ type: 'user', toolUseResult: 'plain string' }), null);
    // content が配列でない（tool_result ブロックを確かめられない）
    assert.equal(
      extractArtifactPublish({ type: 'user', message: { content: 'text' }, toolUseResult: { url: URL } }),
      null,
    );
  });
});
