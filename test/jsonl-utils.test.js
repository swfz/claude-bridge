import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
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
