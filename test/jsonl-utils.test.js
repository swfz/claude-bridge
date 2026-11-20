import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  contextWindowFor,
  cwdToProjectDir,
  extractArtifactPublish,
  extractContextUsage,
  extractTextContent,
  extractToolUses,
  extractWebFetchResult,
  isInjectedUserRecord,
  injectedSenderOf,
  extractHandbackReport,
  parseSlashCommand,
  skillNameOf,
  humanMessageFields,
  parseTeammateMessages,
  extractThinkingText,
  hookErrorMessage,
  parseTaskNotifications,
  taskNotificationMessage,
  createTaskNotificationState,
  queuedAgentMessage,
  noteAgentLaunch,
  extractToolResultFlags,
  parseSummaryTools,
} from '../server/jsonl-utils.js';

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

describe('extractWebFetchResult', () => {
  const fetchRecord = (toolUseResult, block = {}) => ({
    type: 'user',
    uuid: 'u-fetch',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_f', type: 'tool_result', content: '...', ...block }],
    },
    toolUseResult,
  });
  const base = { bytes: 1000, code: 200, codeText: 'OK', durationMs: 300, url: 'https://example.com/cve' };

  it('result の先頭の見出し行をタイトルにする', () => {
    const record = fetchRecord({ ...base, result: '\n# NGINX Rift 脆弱性（CVE-2026-42945）のまとめ\n\n本文' });
    assert.deepEqual(extractWebFetchResult(record), {
      url: 'https://example.com/cve',
      title: 'NGINX Rift 脆弱性（CVE-2026-42945）のまとめ',
      code: 200,
    });
  });

  it('見出しでなくても先頭の非空行を使い、強調・バッククォートを剥がして 120 文字で切る', () => {
    assert.equal(extractWebFetchResult(fetchRecord({ ...base, result: '**`foo` の概要**\n本文' })).title, 'foo の概要');
    assert.equal(extractWebFetchResult(fetchRecord({ ...base, result: 'あ'.repeat(200) })).title.length, 120);
  });

  it('Artifact を読んだ結果は引用部分のタイトルを使う', () => {
    const result = '[Artifact abc123 "週次レポート" — owned by you; raw HTML follows]\n<html></html>';
    assert.equal(
      extractWebFetchResult(fetchRecord({ ...base, url: 'https://claude.ai/artifact/abc123', result })).title,
      '週次レポート',
    );
  });

  it('リダイレクト・2xx 以外・code 不明はタイトル null（url と code は返す）', () => {
    assert.deepEqual(
      extractWebFetchResult(fetchRecord({ ...base, code: 301, result: 'REDIRECT DETECTED: https://example.com/new' })),
      { url: 'https://example.com/cve', title: null, code: 301 },
    );
    assert.deepEqual(extractWebFetchResult(fetchRecord({ ...base, code: undefined, result: '# x' })), {
      url: 'https://example.com/cve',
      title: null,
      code: null,
    });
  });

  it('失敗（toolUseResult が文字列）や http(s) 以外の url は null', () => {
    assert.equal(extractWebFetchResult(fetchRecord('Error: fetch failed', { is_error: true })), null);
    assert.equal(extractWebFetchResult(fetchRecord({ ...base, url: 'file:///tmp/x', result: '# x' })), null);
    assert.equal(extractWebFetchResult(null), null);
    assert.equal(extractWebFetchResult({ type: 'assistant', toolUseResult: { ...base, result: '# x' } }), null);
  });

  it('Artifact の publish レコード（result が無い）とは区別する', () => {
    const publish = fetchRecord({
      url: 'https://claude.ai/code/artifact/46f54464-0000-0000-0000-000000000000',
      path: '/tmp/report.html',
      title: 'レポート',
    });
    assert.equal(extractWebFetchResult(publish), null);
    assert.notEqual(extractArtifactPublish(publish), null);
  });
});

describe('isInjectedUserRecord', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

  it('isMeta の user レコードは注入', () => {
    assert.equal(isInjectedUserRecord(user('Caveat: ...', { isMeta: true })), true);
  });

  it('タグで始まる本文（タスク通知・system-reminder）は注入', () => {
    assert.equal(isInjectedUserRecord(user('  <task-notification>\n<task-id>x</task-id>')), true);
    assert.equal(isInjectedUserRecord(user([{ type: 'text', text: '<system-reminder>...</system-reminder>' }])), true);
  });

  it('自動コンパクトの要約（isCompactSummary）は本文が平文でも注入', () => {
    const r = user('This session is being continued from a previous conversation that ran out of context.', {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    });
    assert.equal(isInjectedUserRecord(r), true);
    assert.deepEqual(injectedSenderOf(r), { kind: 'compact' });
  });

  it('スラッシュコマンド（<command-name> 始まり）と普通の文は注入ではない', () => {
    assert.equal(isInjectedUserRecord(user('<command-name>/ship</command-name>')), false);
    assert.equal(isInjectedUserRecord(user('https://example.com/a を見て')), false);
    assert.equal(isInjectedUserRecord({ type: 'assistant', isMeta: true }), false);
    assert.equal(isInjectedUserRecord(null), false);
  });
});

describe('injectedSenderOf', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

  it('サブエージェントの完了報告（peer + handback）は subagent', () => {
    const r = user('Another Claude session sent a message: ...', {
      isMeta: true,
      origin: { kind: 'peer', handback: true, name: 'Explore', body: '...' },
    });
    assert.deepEqual(injectedSenderOf(r), { kind: 'subagent', name: 'Explore' });
  });

  it('handback なしの peer は peer、name が無ければ付けない', () => {
    assert.deepEqual(injectedSenderOf(user('x', { isMeta: true, origin: { kind: 'peer' } })), { kind: 'peer' });
  });

  it('タスク通知とその他の注入', () => {
    const notif = user('<task-notification>...', { origin: { kind: 'task-notification' } });
    assert.deepEqual(injectedSenderOf(notif), { kind: 'task-notification' });
    assert.deepEqual(injectedSenderOf(user('<system-reminder>...')), { kind: 'system' });
  });

  it('古いツール結果の要約の注記は summary（ツール名の配列）', () => {
    const r = user(
      '<system-reminder>\n<tools-used-before-summary>Read, mcp__x__y</tools-used-before-summary>\n</system-reminder>',
      {
        isMeta: true,
      },
    );
    assert.deepEqual(injectedSenderOf(r), { kind: 'summary', tools: ['Read', 'mcp__x__y'] });
    const fields = humanMessageFields(r, extractTextContent(r.message, 0));
    assert.equal(fields.content, 'Read, mcp__x__y');
    assert.equal(fields.injected, true);
    // 他の system-reminder が混ざっていれば従来どおり system
    const mixed = user('<system-reminder>\nother\n</system-reminder>', { isMeta: true });
    assert.deepEqual(injectedSenderOf(mixed), { kind: 'system' });
  });

  it('スラッシュコマンド（<command-message> 始まり）と !cmd は人の操作なので null', () => {
    const slash = user('<command-message>ship</command-message>\n<command-name>/ship</command-name>', {
      origin: { kind: 'human' },
    });
    assert.equal(injectedSenderOf(slash), null);
    assert.equal(injectedSenderOf(user('<command-message>ship</command-message>')), null);
    assert.equal(injectedSenderOf(user('<bash-input>ls</bash-input>')), null);
  });

  it('人の発言は null', () => {
    assert.equal(injectedSenderOf(user('これ直して', { origin: { kind: 'human' } })), null);
    assert.equal(injectedSenderOf(user('<command-name>/ship</command-name>')), null);
  });
});

describe('extractHandbackReport', () => {
  const handback = (body) => ({ type: 'user', origin: { kind: 'peer', handback: true, body } });

  it('枠と注意書きを外し、2 スペースの字下げを戻す', () => {
    const body =
      '[Subagent hand-back] The text below is the final report. The report follows:\n  ## 結果\n  - a\n      - b\n  ';
    assert.equal(extractHandbackReport(handback(body)), '## 結果\n- a\n    - b');
  });

  it('形が合わなければ null', () => {
    assert.equal(extractHandbackReport(handback('no marker')), null);
    assert.equal(
      extractHandbackReport({ type: 'user', origin: { kind: 'peer', body: 'The report follows:\n  x' } }),
      null,
    );
    assert.equal(extractHandbackReport({ type: 'user' }), null);
  });
});

describe('cwdToProjectDir', () => {
  it('/ を - に置き換える', () => {
    assert.equal(cwdToProjectDir('/home/user/proj'), '-home-user-proj');
  });

  it('. や _ など英数字以外も - にする（Claude Code の projects ディレクトリ名と同じ規則）', () => {
    assert.equal(
      cwdToProjectDir('/home/user/gh/claude-bridge/.claude/worktrees/feat-x'),
      '-home-user-gh-claude-bridge--claude-worktrees-feat-x',
    );
    assert.equal(cwdToProjectDir('/tmp/my_dir.v2'), '-tmp-my-dir-v2');
  });
});

describe('contextWindowFor', () => {
  it('[1m] 付きのモデルは 1M', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5[1m]'), 1_000_000);
  });
  it('opus 4.6 以降・opus 5・fable / mythos は表記なしでも 1M', () => {
    assert.equal(contextWindowFor('claude-opus-4-6'), 1_000_000);
    assert.equal(contextWindowFor('claude-opus-4-8'), 1_000_000);
    assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-fable-5-1'), 1_000_000);
    assert.equal(contextWindowFor('claude-mythos-5-1'), 1_000_000);
  });
  it('sonnet / haiku / opus 4.5 以前 / 不明は 200k', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5'), 200_000);
    assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
    assert.equal(contextWindowFor('claude-opus-4-5'), 200_000);
    assert.equal(contextWindowFor(undefined), 200_000);
  });
  it('実測の文脈量が 200k を超えていれば 1M に繰り上げる', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5', 250_000), 1_000_000);
    assert.equal(contextWindowFor('claude-sonnet-4-5', 150_000), 200_000);
  });
});

describe('extractContextUsage', () => {
  const assistant = (usage, model = 'claude-sonnet-4-5') => ({
    type: 'assistant',
    message: { role: 'assistant', model, usage },
  });

  it('assistant の usage から 3 つの和をコンテキスト量として返す', () => {
    const result = extractContextUsage(
      assistant({
        input_tokens: 100,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 30000,
        output_tokens: 500,
      }),
    );
    assert.deepEqual(result, {
      inputTokens: 100,
      cacheCreationTokens: 2000,
      cacheReadTokens: 30000,
      outputTokens: 500,
      contextTokens: 32100,
      contextWindow: 200_000,
      model: 'claude-sonnet-4-5',
    });
  });

  it('欠けているフィールドは 0 として扱う', () => {
    const result = extractContextUsage(assistant({ input_tokens: 10 }));
    assert.equal(result.contextTokens, 10);
    assert.equal(result.cacheReadTokens, 0);
  });

  it('[1m] モデルは窓を 1M にする', () => {
    const result = extractContextUsage(assistant({ input_tokens: 10 }, 'claude-opus-5[1m]'));
    assert.equal(result.contextWindow, 1_000_000);
    assert.equal(result.model, 'claude-opus-5[1m]');
  });

  it('usage が全部 0 の合成レコード（<synthetic>）は null', () => {
    assert.equal(
      extractContextUsage(
        assistant({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '<synthetic>'),
      ),
      null,
    );
  });

  it('usage が無い assistant・assistant 以外・不正入力は null', () => {
    assert.equal(extractContextUsage({ type: 'assistant', message: { role: 'assistant' } }), null);
    assert.equal(extractContextUsage({ type: 'user', message: { usage: { input_tokens: 1 } } }), null);
    assert.equal(extractContextUsage(null), null);
  });
});

describe('スラッシュコマンドとスキルの展開', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const SLASH = '<command-message>ship</command-message>\n<command-name>/ship</command-name>';
  const SKILL_BODY = [{ type: 'text', text: 'Base directory for this skill: /home/u/.claude/skills/ship\n\n手順…' }];

  it('parseSlashCommand はタグからコマンド名と引数を取り出す', () => {
    assert.deepEqual(parseSlashCommand(SLASH), { name: '/ship', args: '' });
    assert.deepEqual(
      parseSlashCommand(
        '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>123 --fix</command-args>',
      ),
      { name: '/review', args: '123 --fix' },
    );
    assert.equal(parseSlashCommand('<command-message>ship</command-message>'), null);
    assert.equal(parseSlashCommand('/ship して'), null);
    assert.equal(parseSlashCommand('<system-reminder><command-name>/x</command-name>'), null);
  });

  it('skillNameOf は isMeta の SKILL.md 展開だけを拾う', () => {
    assert.equal(skillNameOf(user(SKILL_BODY, { isMeta: true })), 'ship');
    assert.equal(skillNameOf(user(SKILL_BODY)), null);
    assert.equal(skillNameOf(user('<system-reminder>…', { isMeta: true })), null);
  });

  it('スキルの展開の送り手は skill', () => {
    assert.deepEqual(injectedSenderOf(user(SKILL_BODY, { isMeta: true })), { kind: 'skill', name: 'ship' });
  });

  it('humanMessageFields: コマンドは /name args の本文と command、人の発言なので sender なし', () => {
    const r = user(SLASH, { origin: { kind: 'human' } });
    assert.deepEqual(humanMessageFields(r, SLASH), { content: '/ship', command: { name: '/ship', args: '' } });
  });

  it('humanMessageFields: スキルの展開は injected + skill', () => {
    const r = user(SKILL_BODY, { isMeta: true });
    const f = humanMessageFields(r, SKILL_BODY[0].text);
    assert.equal(f.injected, true);
    assert.deepEqual(f.sender, { kind: 'skill', name: 'ship' });
    assert.equal(f.command, undefined);
  });
});

describe('チームメイト（teammate-message）からの送信', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const NOTE = '\n\nThis came from another Claude session — not typed by your user.';
  const PLAIN =
    'Another Claude session sent a message:\n<teammate-message teammate_id="impl" color="blue" summary="実装完了">\n実装しました。\n</teammate-message>' +
    NOTE;
  const IDLE =
    'Another Claude session sent a message:\n<teammate-message teammate_id="rev" color="green">\n' +
    JSON.stringify({ type: 'idle_notification', from: 'rev', idleReason: 'available', result: 'レビュー結果です' }) +
    '\n</teammate-message>' +
    NOTE;

  it('平文と idle_notification の JSON から送り手・要約・本文を取り出す', () => {
    assert.deepEqual(parseTeammateMessages(PLAIN), [{ from: 'impl', summary: '実装完了', body: '実装しました。' }]);
    assert.deepEqual(parseTeammateMessages(IDLE), [{ from: 'rev', summary: '', body: 'レビュー結果です' }]);
    const idleOnly = PLAIN.replace(
      '実装しました。',
      JSON.stringify({ type: 'idle_notification', idleReason: 'available' }),
    );
    assert.equal(parseTeammateMessages(idleOnly)[0].body, '実装完了');
  });

  it('形が合わなければ null', () => {
    assert.equal(parseTeammateMessages('これ直して'), null);
    assert.equal(parseTeammateMessages('Another Claude session sent a message: no block'), null);
    assert.equal(parseTeammateMessages(null), null);
  });

  it('origin が無くても人の発言ではなく subagent として扱い、本文は報告だけにする', () => {
    const r = user(PLAIN);
    assert.equal(isInjectedUserRecord(r), true);
    assert.deepEqual(injectedSenderOf(r), { kind: 'subagent', name: 'impl', summary: '実装完了' });
    assert.deepEqual(humanMessageFields(r, PLAIN), {
      content: '実装しました。',
      injected: true,
      sender: { kind: 'subagent', name: 'impl', summary: '実装完了' },
    });
  });

  it('1 レコードに複数ブロックがあれば送り手と本文をまとめる', () => {
    const multi = PLAIN.replace(NOTE, '') + '\n' + IDLE.replace('Another Claude session sent a message:\n', '');
    const r = user(multi);
    assert.deepEqual(injectedSenderOf(r), { kind: 'subagent', name: 'impl, rev', summary: '実装完了' });
    assert.equal(humanMessageFields(r, multi).content, '実装しました。\n\n---\n\nレビュー結果です');
  });
});

describe('extractThinkingText', () => {
  it('中身のある thinking だけを返す（署名だけのものは空）', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'thinking', thinking: '  今これを調べています。\n\n' },
        { type: 'text', text: '本文' },
      ],
    };
    assert.equal(extractThinkingText(msg), '今これを調べています。');
    assert.equal(extractThinkingText({ content: [{ type: 'thinking', thinking: '' }] }), '');
    assert.equal(extractThinkingText(null), '');
  });
});

describe('hookErrorMessage', () => {
  const rec = (attachment) => ({ type: 'attachment', uuid: 'u1', timestamp: 't', attachment });

  it('ツールのフックはそのツールの toolresult に印を付ける', () => {
    const m = hookErrorMessage(
      rec({
        type: 'hook_non_blocking_error',
        hookName: 'PostToolUse:Edit',
        toolUseID: 'toolu_01',
        stderr: 'Failed with non-blocking status code: No stderr output',
        exitCode: '1',
        command: 'a.sh',
      }),
    );
    assert.deepEqual(m, {
      uuid: 'u1',
      timestamp: 't',
      role: 'toolresult',
      content: '',
      results: [
        { id: 'toolu_01', hookError: { name: 'PostToolUse:Edit', exitCode: '1', command: 'a.sh', detail: '' } },
      ],
    });
  });

  it('ツールに紐づかないフックは hookerror の 1 行', () => {
    const m = hookErrorMessage(
      rec({
        type: 'hook_non_blocking_error',
        hookName: 'Stop',
        toolUseID: '013ff673-1f91',
        stderr: 'Failed with non-blocking status code: /bin/sh: 1: node: not found',
        exitCode: 127,
      }),
    );
    assert.equal(m.role, 'hookerror');
    assert.equal(m.content, '/bin/sh: 1: node: not found');
    assert.deepEqual(m.hook, { name: 'Stop', exitCode: '127', command: '', detail: '/bin/sh: 1: node: not found' });
  });

  it('他の attachment は null', () => {
    assert.equal(hookErrorMessage(rec({ type: 'hook_success' })), null);
    assert.equal(hookErrorMessage({ type: 'user' }), null);
  });
});

const AGENT_NOTIFICATION = `<task-notification>
<task-id>ae47</task-id>
<tool-use-id>toolu_018</tool-use-id>
<status>completed</status>
<summary>Agent "調査" finished</summary>
<result>This agent's report was delivered to you.</result>
<usage><subagent_tokens>84060</subagent_tokens><tool_uses>12</tool_uses><duration_ms>108907</duration_ms></usage>
</task-notification>`;

describe('parseTaskNotifications', () => {
  it('タグを読んで 1 件ずつ返す', () => {
    assert.deepEqual(parseTaskNotifications(AGENT_NOTIFICATION), [
      {
        taskId: 'ae47',
        toolUseId: 'toolu_018',
        status: 'completed',
        summary: 'Agent "調査" finished',
        event: '',
        result: "This agent's report was delivered to you.",
        tokens: 84060,
        toolUses: 12,
        durationMs: 108907,
      },
    ]);
  });

  it('Monitor のイベントは status が event、複数並んでも拾う', () => {
    const text =
      '<task-notification>\n<task-id>bt5</task-id>\n<summary>Monitor event: "CI"</summary>\n<event>line1\nline2</event>\n</task-notification>\n' +
      '<task-notification>\n<task-id>bg4</task-id>\n<status>failed</status>\n<summary>Background command "x" failed with exit code 144</summary>\n</task-notification>';
    const tasks = parseTaskNotifications(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].status, 'event');
    assert.equal(tasks[0].event, 'line1\nline2');
    assert.equal(tasks[1].status, 'failed');
    assert.equal(tasks[1].tokens, null);
  });

  it('タスク通知でなければ null', () => {
    assert.equal(parseTaskNotifications('ふつうの指示'), null);
    assert.equal(parseTaskNotifications(null), null);
  });
});

describe('taskNotificationMessage', () => {
  it('enqueue を出し、後から来た同じ本文の user レコードは捨てる', () => {
    const state = createTaskNotificationState();
    const queued = taskNotificationMessage({ timestamp: 't1' }, AGENT_NOTIFICATION, state, { queued: true });
    assert.equal(queued.message.role, 'task');
    assert.equal(queued.message.content, 'Agent "調査" finished');
    assert.equal(queued.message.tasks.length, 1);
    assert.deepEqual(taskNotificationMessage({ uuid: 'u' }, `${AGENT_NOTIFICATION}\n`, state), { message: null });
  });

  it('enqueue の無い user レコードは出し、同じ本文の積み直しは二度出さない', () => {
    const state = createTaskNotificationState();
    assert.equal(taskNotificationMessage({ uuid: 'u' }, AGENT_NOTIFICATION, state).message.uuid, 'u');
    assert.deepEqual(taskNotificationMessage({}, AGENT_NOTIFICATION, state, { queued: true }), { message: null });
  });

  it('タスク通知でなければ null', () => {
    assert.equal(taskNotificationMessage({}, 'こんにちは', createTaskNotificationState()), null);
  });
});

describe('queuedAgentMessage', () => {
  const HANDBACK_BODY =
    '[Subagent hand-back] The text below is the final report. The report follows:\n  ## 結果\n  - 完了';
  const enqueueText = (from, body) => `<agent-message from="${from}">\n${body}\n</agent-message>`;
  const peerRecord = (from, body) => ({ type: 'user', uuid: 'u-peer', origin: { kind: 'peer', from, body } });

  it('enqueue の報告を subagent の human メッセージにし、種別名を引き当てる', () => {
    const state = createTaskNotificationState();
    // 種別名は Agent ツールのレコードから覚える（noteAgentLaunch）
    noteAgentLaunch({ type: 'user', toolUseResult: { agentId: 'a1', agentType: 'Explore' } }, state);
    const r = queuedAgentMessage({ uuid: 'u1', timestamp: 't1' }, enqueueText('a1', HANDBACK_BODY), state, {
      queued: true,
    });
    assert.deepEqual(r, {
      message: {
        role: 'human',
        content: '## 結果\n- 完了',
        injected: true,
        sender: { kind: 'subagent', name: 'Explore' },
        uuid: 'u1',
        timestamp: 't1',
      },
    });
  });

  it('報告の形でない本文は peer として本文をそのまま出し、timestamp が無ければ空文字', () => {
    const state = createTaskNotificationState();
    const r = queuedAgentMessage({ uuid: 'u2' }, enqueueText('a2', '  こんにちは  '), state, { queued: true });
    assert.deepEqual(r.message, {
      role: 'human',
      content: 'こんにちは',
      injected: true,
      sender: { kind: 'peer' },
      uuid: 'u2',
      timestamp: '',
    });
  });

  it('hand-back の前置きがあれば報告を取り出せなくても subagent', () => {
    const state = createTaskNotificationState();
    const r = queuedAgentMessage({}, enqueueText('a3', '[Subagent hand-back] no marker'), state, { queued: true });
    assert.equal(r.message.sender.kind, 'subagent');
    assert.equal(r.message.content, '[Subagent hand-back] no marker');
  });

  it('enqueue の後に来た同じ本文の peer レコードは捨て、2 件目以降は呼び出し側に任せる（null）', () => {
    const state = createTaskNotificationState();
    queuedAgentMessage({}, enqueueText('a1', HANDBACK_BODY), state, { queued: true });
    assert.deepEqual(queuedAgentMessage(peerRecord('a1', HANDBACK_BODY), '', state), { message: null });
    assert.equal(queuedAgentMessage(peerRecord('a1', HANDBACK_BODY), '', state), null);
  });

  it('同じ本文が 2 回積まれたら、後の peer レコードも 2 件まで捨てる（表示は 1 回）', () => {
    const state = createTaskNotificationState();
    const first = queuedAgentMessage({}, enqueueText('a1', 'x'), state, { queued: true });
    const second = queuedAgentMessage({}, enqueueText('a1', 'x'), state, { queued: true });
    assert.notEqual(first.message, null);
    assert.deepEqual(second, { message: null });
    assert.deepEqual(queuedAgentMessage(peerRecord('a1', 'x'), '', state), { message: null });
    assert.deepEqual(queuedAgentMessage(peerRecord('a1', 'x'), '', state), { message: null });
    assert.equal(queuedAgentMessage(peerRecord('a1', 'x'), '', state), null);
  });

  it('送り手が違えば同じ本文でも別の報告', () => {
    const state = createTaskNotificationState();
    queuedAgentMessage({}, enqueueText('a1', 'x'), state, { queued: true });
    assert.equal(queuedAgentMessage(peerRecord('a2', 'x'), '', state), null);
    assert.notEqual(queuedAgentMessage({}, enqueueText('a2', 'x'), state, { queued: true }).message, null);
  });

  it('agent-message でない enqueue・peer でないレコードは null', () => {
    const state = createTaskNotificationState();
    assert.equal(queuedAgentMessage({}, 'ふつうの文', state, { queued: true }), null);
    assert.equal(queuedAgentMessage({}, null, state, { queued: true }), null);
    assert.equal(queuedAgentMessage({}, `前置き ${enqueueText('a1', 'x')}`, state, { queued: true }), null);
    assert.equal(queuedAgentMessage({}, `${enqueueText('a1', 'x')} 後ろ`, state, { queued: true }), null);
    assert.equal(queuedAgentMessage({ type: 'user', origin: { kind: 'human' } }, '', state), null);
    assert.equal(queuedAgentMessage({ type: 'user', origin: { kind: 'peer', from: 1, body: 'x' } }, '', state), null);
    assert.equal(queuedAgentMessage({ type: 'user', origin: { kind: 'peer', from: 'a', body: 2 } }, '', state), null);
    assert.equal(queuedAgentMessage(null, '', state), null);
  });

  it('属性付きの agent-message タグや前後の空白も読む', () => {
    const state = createTaskNotificationState();
    const text = '  <agent-message from="a9" extra="1">本文</agent-message>  ';
    assert.equal(queuedAgentMessage({}, text, state, { queued: true }).message.content, '本文');
  });
});

describe('noteAgentLaunch', () => {
  const launch = (id, name, subagentType) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { subagent_type: subagentType } }] },
  });
  const result = (toolUseId, toolUseResult) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
    toolUseResult,
  });
  // 覚えた種別名は、その agentId からの報告の sender.name として見える
  const nameAfter = (state, agentId) => {
    const r = queuedAgentMessage({}, `<agent-message from="${agentId}">x</agent-message>`, state, { queued: true });
    return r.message.sender.name;
  };

  it('Agent / Task の呼び出しの subagent_type を結果の agentId に結びつける', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(launch('t1', 'Agent', 'Explore'), state);
    noteAgentLaunch(launch('t2', 'Task', 'Plan'), state);
    noteAgentLaunch(result('t1', { agentId: 'a1', agentType: 'other' }), state);
    noteAgentLaunch(result('t2', { agentId: 'a2' }), state);
    assert.equal(nameAfter(state, 'a1'), 'Explore');
    assert.equal(nameAfter(state, 'a2'), 'Plan');
  });

  it('種別名が分からない結果で、覚えていた種別名を消さない', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(launch('t1', 'Agent', 'Explore'), state);
    noteAgentLaunch(result('t1', { agentId: 'a1' }), state);
    noteAgentLaunch(result('t-unknown', { agentId: 'a1' }), state);
    assert.equal(nameAfter(state, 'a1'), 'Explore');
  });

  it('呼び出しが見つからなければ結果の agentType を使う', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(result('t9', { agentId: 'a1', agentType: 'general' }), state);
    assert.equal(nameAfter(state, 'a1'), 'general');
  });

  it('Agent 以外のツール・subagent_type の無い呼び出し・agentId の無い結果は覚えない', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(launch('t1', 'Read', 'Explore'), state);
    noteAgentLaunch(launch('t2', 'Agent', ''), state);
    noteAgentLaunch(result('t1', { agentId: 'a1' }), state);
    noteAgentLaunch(result('t2', { agentId: 'a2', agentType: 5 }), state);
    noteAgentLaunch(result('t1', { agentId: 7, agentType: 'x' }), state);
    noteAgentLaunch({ ...result('t1', { agentId: 'a3', agentType: 'x' }), type: 'system' }, state);
    noteAgentLaunch(result('t1', null), state);
    assert.equal(nameAfter(state, 'a1'), undefined);
    assert.equal(nameAfter(state, 'a2'), undefined);
    assert.equal(nameAfter(state, 'a3'), undefined);
  });

  it('assistant レコードの toolUseResult は結果として扱わない', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(
      { type: 'assistant', message: { content: [] }, toolUseResult: { agentId: 'a1', agentType: 'x' } },
      state,
    );
    assert.equal(nameAfter(state, 'a1'), undefined);
  });

  it('agentNames を持たない state でも落ちず、content の無い結果は agentType で覚える', () => {
    assert.doesNotThrow(() => noteAgentLaunch(launch('t1', 'Agent', 'Explore'), {}));
    assert.doesNotThrow(() => noteAgentLaunch(launch('t1', 'Agent', 'Explore'), null));
    const state = createTaskNotificationState();
    noteAgentLaunch({ type: 'user', toolUseResult: { agentId: 'a1', agentType: 'x' } }, state);
    assert.equal(nameAfter(state, 'a1'), 'x');
  });
});

describe('extractToolResultFlags', () => {
  const record = (content, toolUseResult) => ({ type: 'user', message: { content }, toolUseResult });
  const ok = (id, extra = {}) => ({ type: 'tool_result', tool_use_id: id, ...extra });

  it('失敗・新規作成・普通の成功をツールごとに返す', () => {
    assert.deepEqual(extractToolResultFlags(record([ok('t1', { is_error: true }), ok('t2')])), [
      { id: 't1', error: true },
      { id: 't2' },
    ]);
    assert.deepEqual(extractToolResultFlags(record([ok('t3')], { type: 'create' })), [{ id: 't3', created: true }]);
  });

  it('失敗は新規作成より優先し、create 以外の結果は普通の成功', () => {
    assert.deepEqual(extractToolResultFlags(record([ok('t1', { is_error: true })], { type: 'create' })), [
      { id: 't1', error: true },
    ]);
    assert.deepEqual(extractToolResultFlags(record([ok('t1')], { type: 'update' })), [{ id: 't1' }]);
    assert.deepEqual(extractToolResultFlags(record([ok('t1')], [{ type: 'create' }])), [{ id: 't1' }]);
    assert.deepEqual(extractToolResultFlags(record([ok('t1')], 'create')), [{ id: 't1' }]);
  });

  it('tool_result 以外のブロック・id が文字列でないブロックは飛ばす', () => {
    assert.deepEqual(
      extractToolResultFlags(record([null, { type: 'text', text: 'x', tool_use_id: 'tx' }, ok(5), ok('t1')])),
      [{ id: 't1' }],
    );
  });

  it('user 以外・content が配列でないレコードは空', () => {
    assert.deepEqual(extractToolResultFlags(null), []);
    assert.deepEqual(extractToolResultFlags({ type: 'assistant', message: { content: [ok('t')] } }), []);
    assert.deepEqual(extractToolResultFlags({ type: 'user', message: { content: 'text' } }), []);
    assert.deepEqual(extractToolResultFlags({ type: 'user' }), []);
  });
});

describe('parseSummaryTools', () => {
  it('system-reminder だけの注記からツール名を取り出す（空の要素は捨てる）', () => {
    assert.deepEqual(
      parseSummaryTools(
        '  <system-reminder> <tools-used-before-summary> Read ,, Grep </tools-used-before-summary> </system-reminder>\n',
      ),
      ['Read', 'Grep'],
    );
  });

  it('前後に他の文があるもの・文字列でないものは null', () => {
    const tag = '<system-reminder><tools-used-before-summary>Read</tools-used-before-summary></system-reminder>';
    assert.equal(parseSummaryTools(`x${tag}`), null);
    assert.equal(parseSummaryTools(`${tag}x`), null);
    assert.equal(parseSummaryTools(null), null);
  });

  it('タグの間に空白が無くても読む', () => {
    assert.deepEqual(
      parseSummaryTools(
        '<system-reminder><tools-used-before-summary>Read</tools-used-before-summary></system-reminder>',
      ),
      ['Read'],
    );
  });
});

describe('CLAUDE_PROJECTS_DIR', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('環境変数が無ければ ~/.claude/projects', async () => {
    vi.stubEnv('CLAUDE_BRIDGE_PROJECTS_DIR', '');
    vi.resetModules();
    const mod = await import('../server/jsonl-utils.js');
    assert.equal(mod.CLAUDE_PROJECTS_DIR, join(homedir(), '.claude', 'projects'));
  });

  it('CLAUDE_BRIDGE_PROJECTS_DIR があればそれを使う', async () => {
    vi.stubEnv('CLAUDE_BRIDGE_PROJECTS_DIR', '/tmp/x-projects');
    vi.resetModules();
    const mod = await import('../server/jsonl-utils.js');
    assert.equal(mod.CLAUDE_PROJECTS_DIR, '/tmp/x-projects');
  });
});

describe('extractTextContent（content の形）', () => {
  it('content が文字列でも配列でもなければ空文字', () => {
    assert.equal(extractTextContent({}), '');
    assert.equal(extractTextContent({ content: { type: 'text', text: 'x' } }), '');
  });
});

describe('parseTaskNotifications（境界）', () => {
  it('先頭の空白は許し、タグの値の前後の空白は落とす', () => {
    const [t] = parseTaskNotifications('  \n<task-notification><task-id> x1 </task-id></task-notification>');
    assert.equal(t.taskId, 'x1');
  });

  it('本文が通知で始まらなければ null', () => {
    assert.equal(parseTaskNotifications('前置き <task-notification><task-id>x</task-id></task-notification>'), null);
  });

  it('閉じタグが無ければ null', () => {
    assert.equal(parseTaskNotifications('<task-notification><task-id>x</task-id>'), null);
  });

  it('status も event も無ければ status は空文字', () => {
    assert.equal(parseTaskNotifications('<task-notification><task-id>x</task-id></task-notification>')[0].status, '');
  });

  it('数値でない usage は null（数字が混ざっていても）', () => {
    const [t] = parseTaskNotifications(
      '<task-notification><usage><subagent_tokens>abc12</subagent_tokens><tool_uses>12abc</tool_uses><duration_ms>7</duration_ms></usage></task-notification>',
    );
    assert.equal(t.tokens, null);
    assert.equal(t.toolUses, null);
    assert.equal(t.durationMs, 7);
  });

  it('event と result は 2000 文字で切る', () => {
    const long = 'あ'.repeat(2500);
    const [t] = parseTaskNotifications(
      `<task-notification><event>${long}</event><result>${long}</result></task-notification>`,
    );
    assert.equal(t.event.length, 2000);
    assert.equal(t.result.length, 2000);
  });
});

describe('taskNotificationMessage（メッセージの中身）', () => {
  it('複数の通知の要約を改行でつなぎ、時刻を引き継ぐ（無ければ空文字）', () => {
    const text =
      '<task-notification><summary>A</summary></task-notification>\n<task-notification><summary>B</summary></task-notification>';
    const m = taskNotificationMessage({ uuid: 'u', timestamp: 't9' }, text, createTaskNotificationState()).message;
    assert.equal(m.content, 'A\nB');
    assert.equal(m.timestamp, 't9');
    assert.equal(m.uuid, 'u');
    const m2 = taskNotificationMessage({ uuid: 'u' }, text, createTaskNotificationState()).message;
    assert.equal(m2.timestamp, '');
  });
});

describe('queuedAgentMessage（境界）', () => {
  const queued = (text, state = createTaskNotificationState()) => queuedAgentMessage({}, text, state, { queued: true });

  it('先頭の空白・前置きの無い hand-back は subagent、途中に出てくるだけなら peer', () => {
    assert.equal(
      queued('<agent-message from="a">\n  [Subagent hand-back] x\n</agent-message>').message.sender.kind,
      'subagent',
    );
    assert.equal(
      queued('<agent-message from="a">\nx [Subagent hand-back]\n</agent-message>').message.sender.kind,
      'peer',
    );
  });

  it('agentNames を持たない state でも種別名なしで出す', () => {
    const state = { pending: new Map(), shown: new Set() };
    assert.deepEqual(queued('<agent-message from="a">x</agent-message>', state).message.sender, { kind: 'peer' });
  });

  it('前後に空白のある本文の peer レコードも同じ報告として捨てる', () => {
    const state = createTaskNotificationState();
    queued('<agent-message from="a">\nx\n</agent-message>', state);
    assert.deepEqual(queuedAgentMessage({ origin: { kind: 'peer', from: 'a', body: '  x  ' } }, '', state), {
      message: null,
    });
  });

  it('origin.from が文字列でない peer レコードは同じ報告とみなさない', () => {
    const state = createTaskNotificationState();
    queued('<agent-message from="1">x</agent-message>', state);
    assert.equal(queuedAgentMessage({ origin: { kind: 'peer', from: 1, body: 'x' } }, '', state), null);
  });
});

describe('noteAgentLaunch（壊れたブロック）', () => {
  it('結果の tool_result が先頭のブロックでなくても呼び出しを引き当てる', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore' } }] },
      },
      state,
    );
    noteAgentLaunch(
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'x' },
            { type: 'tool_result', tool_use_id: 't1' },
          ],
        },
        toolUseResult: { agentId: 'a1', agentType: 'other' },
      },
      state,
    );
    const r = queuedAgentMessage({}, '<agent-message from="a1">y</agent-message>', state, { queued: true });
    assert.equal(r.message.sender.name, 'Explore');
  });

  it('null のブロックや input の無い tool_use があっても読み飛ばす', () => {
    const state = createTaskNotificationState();
    noteAgentLaunch(
      { type: 'assistant', message: { content: [null, { type: 'tool_use', id: 't', name: 'Agent' }] } },
      state,
    );
    noteAgentLaunch(
      { type: 'user', message: { content: [null] }, toolUseResult: { agentId: 'a1', agentType: 'x' } },
      state,
    );
    const r = queuedAgentMessage({}, '<agent-message from="a1">y</agent-message>', state, { queued: true });
    assert.equal(r.message.sender.name, 'x');
  });
});

describe('hookErrorMessage（境界）', () => {
  const rec = (attachment, extra = {}) => ({ type: 'attachment', uuid: 'u1', attachment, ...extra });
  const base = { type: 'hook_non_blocking_error', hookName: 'Stop' };

  it('attachment 以外のレコード・null は null', () => {
    assert.equal(hookErrorMessage({ type: 'user', attachment: base }), null);
    assert.equal(hookErrorMessage(rec(null)), null);
    assert.equal(hookErrorMessage(null), null);
  });

  it('stderr・exitCode・時刻が無ければ空・null・空文字', () => {
    const m = hookErrorMessage(rec(base));
    assert.equal(m.timestamp, '');
    assert.deepEqual(m.hook, { name: 'Stop', exitCode: null, command: '', detail: '' });
  });

  it('前置きは先頭にあるときだけ外し、空白を詰める', () => {
    assert.equal(
      hookErrorMessage(rec({ ...base, stderr: 'Failed with non-blocking status code:boom  \n' })).hook.detail,
      'boom',
    );
    assert.equal(
      hookErrorMessage(rec({ ...base, stderr: 'x Failed with non-blocking status code: y' })).hook.detail,
      'x Failed with non-blocking status code: y',
    );
  });

  it('stderr は 500 文字で切る', () => {
    assert.equal(hookErrorMessage(rec({ ...base, stderr: 'e'.repeat(800) })).hook.detail.length, 500);
  });

  it('フック名が無ければ hookEvent、それも無ければ hook', () => {
    assert.equal(
      hookErrorMessage(rec({ type: 'hook_non_blocking_error', hookEvent: 'PreToolUse' })).hook.name,
      'PreToolUse',
    );
    assert.equal(hookErrorMessage(rec({ type: 'hook_non_blocking_error' })).hook.name, 'hook');
  });

  it('toolUseID が文字列でなければツールに紐づけない', () => {
    assert.equal(hookErrorMessage(rec({ ...base, toolUseID: 123 })).role, 'hookerror');
  });
});

describe('extractThinkingText（境界）', () => {
  it('空白だけ・文字列でない thinking と null のブロックを除き、複数は空行でつなぐ', () => {
    const msg = {
      content: [
        null,
        { type: 'thinking', thinking: '   ' },
        { type: 'thinking', thinking: 5 },
        { type: 'text', thinking: 'text ブロック' },
        { type: 'thinking', thinking: 'A' },
        { type: 'thinking', thinking: 'B' },
      ],
    };
    assert.equal(extractThinkingText(msg), 'A\n\nB');
  });
});

describe('extractArtifactPublish（境界）', () => {
  const URL = 'https://claude.ai/code/artifact/1';
  const rec = (toolUseResult, content = [{ type: 'tool_result', tool_use_id: 't' }], extra = {}) => ({
    type: 'user',
    message: { content },
    toolUseResult,
    ...extra,
  });

  it('claude.ai の URL は先頭一致だけ', () => {
    assert.equal(extractArtifactPublish(rec({ url: `https://example.com/?r=${URL}` })), null);
  });

  it('assistant のレコード・toolUseResult が null・url が文字列でないものは null', () => {
    assert.equal(extractArtifactPublish(rec({ url: URL }, undefined, { type: 'assistant' })), null);
    assert.equal(extractArtifactPublish(rec(null)), null);
    assert.equal(extractArtifactPublish(rec({ url: [URL] })), null);
  });

  it('message が無ければ null', () => {
    assert.equal(extractArtifactPublish({ type: 'user', toolUseResult: { url: URL } }), null);
  });

  it('成功した tool_result が 1 つでもあれば公開とみなし、tool_result が無ければ null', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'a', is_error: true },
      { type: 'tool_result', tool_use_id: 'b' },
    ];
    assert.equal(extractArtifactPublish(rec({ url: URL }, content)).url, URL);
    assert.equal(extractArtifactPublish(rec({ url: URL }, [{ type: 'text', text: 'x' }])), null);
    assert.equal(extractArtifactPublish(rec({ url: URL }, [null, { type: 'tool_result', tool_use_id: 'b' }])).url, URL);
  });

  it('path が空文字・文字列でなければ path は null', () => {
    assert.equal(extractArtifactPublish(rec({ url: URL, path: '' })).path, null);
    assert.equal(extractArtifactPublish(rec({ url: URL, path: 5 })).path, null);
  });
});

describe('extractToolResultFlags（toolUseResult が null）', () => {
  it('toolUseResult が null でも普通の成功として返す', () => {
    const r = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] }, toolUseResult: null };
    assert.deepEqual(extractToolResultFlags(r), [{ id: 't' }]);
  });
});

describe('extractWebFetchResult（境界）', () => {
  const rec = (toolUseResult, extra = {}) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't' }] },
    toolUseResult,
    ...extra,
  });
  const ok = (result, extra = {}) => ({ url: 'https://example.com/a', code: 200, result, ...extra });
  const title = (result, extra) => extractWebFetchResult(rec(ok(result, extra))).title;

  it('2xx の境界（199・300 はタイトルなし、200・299 はあり）', () => {
    assert.equal(title('# T', { code: 199 }), null);
    assert.equal(title('# T', { code: 150 }), null);
    assert.equal(title('# T', { code: 300 }), null);
    assert.equal(title('# T', { code: 299 }), 'T');
  });

  it('空白だけの行は飛ばし、本文が空ならタイトルなし', () => {
    assert.equal(title('   \n  # T'), 'T');
    assert.equal(title('\n  \n'), null);
    assert.equal(title('****'), null);
  });

  it('見出し記号は先頭のものだけ、何個でも外す', () => {
    assert.equal(title('## T'), 'T');
    assert.equal(title('#T'), 'T');
    assert.equal(title('a # b'), 'a # b');
  });

  it('強調を外して残った前後の空白も落とす', () => {
    assert.equal(title('** T **'), 'T');
  });

  it('Artifact の引用は行頭にあるときだけ、前後の空白を落として 120 文字で切る', () => {
    assert.equal(title('[Artifact x " 週次 " — owned]'), '週次');
    assert.equal(title(`[Artifact x "${'あ'.repeat(200)}"]`).length, 120);
    assert.equal(title('見出し [Artifact x "T"]'), '見出し [Artifact x "T"]');
  });

  it('http も受け付け、url が先頭から http(s) でなければ null', () => {
    assert.equal(extractWebFetchResult(rec(ok('# T', { url: 'http://example.com/' }))).url, 'http://example.com/');
    assert.equal(extractWebFetchResult(rec(ok('# T', { url: 'xhttps://example.com/' }))), null);
    assert.equal(extractWebFetchResult(rec(ok('# T', { url: ['https://example.com/'] }))), null);
  });

  it('toolUseResult が null なら null', () => {
    assert.equal(extractWebFetchResult(rec(null)), null);
  });
});

describe('isInjectedUserRecord（境界）', () => {
  it('コマンドのタグは本文の先頭にあるときだけ人の操作とみなす', () => {
    const r = { type: 'user', message: { content: '<x><command-name>/ship</command-name>' } };
    assert.equal(isInjectedUserRecord(r), true);
  });
});

describe('parseTeammateMessages（境界）', () => {
  const wrap = (attrs, inner) =>
    `Another Claude session sent a message:\n<teammate-message ${attrs}>${inner}</teammate-message>`;

  it('先頭の空白は許し、前置きで始まらなければ null', () => {
    assert.equal(parseTeammateMessages(`  ${wrap('teammate_id="a"', 'x')}`)[0].body, 'x');
    assert.equal(parseTeammateMessages(`前置き ${wrap('teammate_id="a"', 'x')}`), null);
  });

  it('teammate_id は位置に関わらずその属性から読む', () => {
    assert.equal(parseTeammateMessages(wrap('color="blue" teammate_id="impl"', 'x'))[0].from, 'impl');
  });

  it('{ で始まらない本文は JSON として読まない', () => {
    assert.equal(parseTeammateMessages(wrap('teammate_id="a" summary="S"', '42'))[0].body, '42');
  });

  it('JSON の summary・result・failureReason・idle を使い分ける', () => {
    const body = (json) => parseTeammateMessages(wrap('teammate_id="a"', JSON.stringify(json)))[0];
    assert.deepEqual(body({ type: 'idle_notification', summary: '要約' }), {
      from: 'a',
      summary: '要約',
      body: '要約',
    });
    assert.equal(body({ result: '  結果  ' }).body, '結果');
    assert.equal(body({ result: '   ', failureReason: ' 失敗 ' }).body, '失敗');
    assert.equal(body({ type: 'idle_notification' }).body, '（待機中）');
    assert.equal(body({ type: 'other' }).body, '{"type":"other"}');
    assert.equal(body({ summary: 5, type: 'other' }).summary, '');
  });
});

describe('parseSlashCommand（境界）', () => {
  it('前後の空白を許し、名前と引数の空白を落とし、/ が無ければ付ける', () => {
    assert.deepEqual(parseSlashCommand('  <command-name> ship </command-name><command-args> a b </command-args>'), {
      name: '/ship',
      args: 'a b',
    });
  });

  it('文字列でなければ null', () => {
    assert.equal(parseSlashCommand(null), null);
  });
});

describe('skillNameOf（境界）', () => {
  const meta = (text, extra = {}) => ({ type: 'user', isMeta: true, message: { content: text }, ...extra });

  it('ディレクトリ名の前後の空白・末尾の / を外す', () => {
    assert.equal(skillNameOf(meta('  Base directory for this skill: /a/ship/  \n手順')), 'ship');
    assert.equal(skillNameOf(meta('Base directory for this skill: /a/ship//')), 'ship');
  });

  it('/ を含まない名前はそのまま、空なら skill', () => {
    assert.equal(skillNameOf(meta('Base directory for this skill: ship')), 'ship');
    assert.equal(skillNameOf(meta('Base directory for this skill: /')), 'skill');
  });

  it('user 以外・null は null', () => {
    assert.equal(skillNameOf(meta('Base directory for this skill: /a/ship', { type: 'assistant' })), null);
    assert.equal(skillNameOf(null), null);
  });
});

describe('humanMessageFields（引数付きコマンド）', () => {
  it('引数があれば /name args を本文にする', () => {
    const text = '<command-name>/review</command-name><command-args>123</command-args>';
    const r = { type: 'user', message: { content: text }, origin: { kind: 'human' } };
    assert.equal(humanMessageFields(r, text).content, '/review 123');
  });
});

describe('injectedSenderOf（境界）', () => {
  const TEAMMATE = 'Another Claude session sent a message:\n<teammate-message teammate_id="impl">x</teammate-message>';
  const user = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });

  it('null・user 以外は null', () => {
    assert.equal(injectedSenderOf(null), null);
    assert.equal(injectedSenderOf({ type: 'assistant', isMeta: true, message: { content: '<x>' } }), null);
    assert.equal(injectedSenderOf({ type: 'assistant', origin: { kind: 'peer' }, message: { content: 'x' } }), null);
  });

  it('origin が null や文字列でもチームメイトの送信を拾う', () => {
    assert.deepEqual(injectedSenderOf(user(TEAMMATE, { origin: null })), { kind: 'subagent', name: 'impl' });
    assert.deepEqual(injectedSenderOf(user(TEAMMATE, { origin: 'peer' })), { kind: 'subagent', name: 'impl' });
  });

  it('origin が human ならタグで始まる本文でも人の発言', () => {
    assert.equal(injectedSenderOf(user(TEAMMATE, { origin: { kind: 'human' } })), null);
    assert.equal(injectedSenderOf(user('<system-reminder>x', { origin: { kind: 'human' } })), null);
  });

  it('teammate_id の無いブロックは名前に数えず、要約が無ければ付けない', () => {
    const multi =
      'Another Claude session sent a message:\n<teammate-message>x</teammate-message>\n<teammate-message teammate_id="b">y</teammate-message>';
    assert.deepEqual(injectedSenderOf(user(multi)), { kind: 'subagent', name: 'b' });
    const anon = 'Another Claude session sent a message:\n<teammate-message>x</teammate-message>';
    assert.deepEqual(injectedSenderOf(user(anon)), { kind: 'subagent' });
  });
});

describe('extractHandbackReport（境界）', () => {
  const handback = (body) => ({ type: 'user', origin: { kind: 'peer', handback: true, body } });

  it('マーカーが本文の先頭にあっても読む', () => {
    assert.equal(extractHandbackReport(handback('The report follows:\n  r')), 'r');
  });

  it('マーカーの無い長い本文は null', () => {
    assert.equal(extractHandbackReport(handback('x'.repeat(80))), null);
  });

  it('行頭の 2 スペースだけ外し、行中の空白は残す', () => {
    assert.equal(extractHandbackReport(handback('The report follows:\n  a  b\nc  d')), 'a  b\nc  d');
  });

  it('null・body が文字列でなければ null', () => {
    assert.equal(extractHandbackReport(null), null);
    assert.equal(extractHandbackReport(handback(5)), null);
  });
});

describe('extractToolUses（要約）', () => {
  const summary = (name, input) =>
    extractToolUses({ content: [{ type: 'tool_use', id: 't', name, input }] })[0].summary;

  it('input が無ければツール名', () => {
    assert.equal(summary('Bash', undefined), 'Bash');
  });

  it('Bash は説明、無ければコマンドの先頭 120 文字、どちらも無ければ Bash', () => {
    assert.equal(summary('Bash', { description: '一覧', command: 'ls' }), '一覧');
    assert.equal(summary('Bash', { command: 'x'.repeat(200) }).length, 120);
    assert.equal(summary('Bash', {}), 'Bash');
  });

  it('Grep / Glob はパターンと場所', () => {
    assert.equal(summary('Grep', { pattern: 'foo', path: '/a/b/c/d' }), 'foo in .../c/d');
    assert.equal(summary('Glob', { pattern: '*.js' }), '*.js');
  });

  it('Agent は説明、無ければ Agent', () => {
    assert.equal(summary('Agent', { description: '調査' }), '調査');
    assert.equal(summary('Agent', {}), 'Agent');
  });

  it('Artifact の publish は対象ファイル、ファイルが無ければ publish だけ', () => {
    assert.equal(summary('Artifact', { action: 'publish', file_path: '/a/b/c.html' }), 'publish .../b/c.html');
    assert.equal(summary('Artifact', {}), 'publish');
  });

  it('AskUserQuestion は質問の無い要素を飛ばす', () => {
    assert.equal(summary('AskUserQuestion', { questions: [null, { question: 'Q1' }, {}] }), 'Q1');
  });

  it('パスは 3 階層以上なら末尾 2 つ、2 階層以下はそのまま、無ければ空', () => {
    assert.equal(summary('Read', { file_path: '/Users/u/project/src/App.jsx' }), '.../src/App.jsx');
    assert.equal(summary('Read', { file_path: 'src/App.jsx' }), 'src/App.jsx');
    assert.equal(summary('Read', { file_path: '/App.jsx' }), '/App.jsx');
    assert.equal(summary('Read', {}), '');
  });
});

describe('contextWindowFor（境界）', () => {
  it('2 桁の版も 1M とみなす', () => {
    assert.equal(contextWindowFor('claude-opus-4-10'), 1_000_000);
    assert.equal(contextWindowFor('claude-opus-10'), 1_000_000);
  });

  it('ちょうど 200k は繰り上げない', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5', 200_000), 200_000);
  });
});

describe('extractContextUsage（境界）', () => {
  it('message・usage が無い（null）なら null', () => {
    assert.equal(extractContextUsage({ type: 'assistant' }), null);
    assert.equal(extractContextUsage({ type: 'assistant', message: { usage: null } }), null);
  });

  it('model が文字列でなければ空文字', () => {
    assert.equal(extractContextUsage({ type: 'assistant', message: { usage: { input_tokens: 1 } } }).model, '');
    assert.equal(
      extractContextUsage({ type: 'assistant', message: { model: 5, usage: { input_tokens: 1 } } }).model,
      '',
    );
  });
});
