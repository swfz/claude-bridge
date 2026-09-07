import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChoicePrompt } from '../server/choice-prompt.js';

// 以下の画面テキストは実際の Claude Code (v2.1.233) の tmux capture-pane 出力から採った
const RULE = '─'.repeat(60);

const SINGLE_SELECT = `
❯ AskUserQuestion ツールで「好きな色は？」を1問だけ聞いて
${RULE}
 ☐ 好きな色

好きな色は？

❯ 1. 赤
     暖色系。情熱的で目を引く色。
  2. 青
     寒色系。落ち着いた印象の色。
  3. 緑
     中間色。自然を感じさせる色。
  4. Type something.
${RULE}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const MULTI_SELECT = `
❯ AskUserQuestion ツールで multiSelect: true の質問を1問だけ聞いて
${RULE}
←  ☒ 好きな果物  ✔ Submit  →

好きな果物は？（複数可）

❯ 1. [✔] りんご
  シャキシャキした食感と酸味のバランスが特徴。
  2. [ ] みかん
  手で剥けて手軽に食べる柑橘類。
  3. [✔] ぶどう
  甘みが強くジューシーな房なりの果物。
  4. [ ] Type something
     Submit
${RULE}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// multiSelect で Tab を押した後の確認画面。この画面だけフッター行が出ない
const SUBMIT_TAB = `
${RULE}
←  ☒ 好きな果物  ✔ Submit  →

Review your answers

 ● 好きな果物は？（複数可）
   → ぶどう

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;

const TRUST_PROMPT = `
❯ claude

${RULE}
 Accessing workspace:

 /tmp/work/project

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

// permission プロンプトは "Enter to select" 行を持たず、上に diff が出る
const PERMISSION_PROMPT = `
❯ perm-check.txt というファイルに hello と書いて

● I'll create the file.

● Write(perm-check.txt)
${RULE}
 Create file
 perm-check.txt
${'╌'.repeat(60)}
  1 hello
${'╌'.repeat(60)}
 Do you want to create perm-check.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
`;

// Bash 許可プロンプト（v2.1.259 実測）。コマンド本文・説明・注記が `│` の左ガター付きで描かれ、
// 罫線の上には会話ログ（◐ / ⎿）が残っている画面。罫線で detail の切り出しが止まることを確認する。
const BASH_PERMISSION_PROMPT = `
❯ conditionFilter の型と grouping の実装を調べて

◐ Investigating grouping implementation
  ⎿  $ cd /home/project && ls

● Bash(cd /home/project && echo "types")
${RULE}
 Bash command

   │ cd /home/... && echo "=== conditionFilter types ==="; grep -n foo
   │ bar; echo "=== apply impl ==="; grep -rl baz
   │ qux | cut -c1-140 | head -14
   Read filter rule shape and operator set used by grouping

 │ grep on 'frontend/src/types/conditionFilter.ts' after a cd would search a directory that cannot be determined here, and a Read(...

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
`;

// 1 行コマンドの Bash 許可（v2.1.263 実測）。`│` ガターが無いので collectQuestion が
// ツール詳細まで質問として拾ってしまう形。質問は最後の行だけ、上は detail に回る
const BASH_ONELINE_PERMISSION_PROMPT = `
  Fetching HTTP response headers from example.com
  ⎿  $ curl -sI https://example.com | head -3

${'─'.repeat(60)}
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   curl -sI https://example.com | head -3
   Fetch HTTP response headers from example.com

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl -sI https://example.com
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
`;

const IDLE_SCREEN = `
● 実行結果です。以下の3点でした。

  - <title>Example Domain</title>
  - 本文: "This domain is for use in documentation examples."
  - リンク: https://iana.org/domains/example

✻ Worked for 14s
${RULE}
❯
${RULE}
  0m | $0.5041 | Opus 5 (1M context)
  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)
`;

describe('parseChoicePrompt', () => {
  it('parses a single-select AskUserQuestion prompt', () => {
    const prompt = parseChoicePrompt(SINGLE_SELECT);

    assert.ok(prompt);
    assert.equal(prompt.question, '好きな色は？');
    assert.equal(prompt.multiSelect, false);
    assert.equal(prompt.canCancel, true);
    assert.equal(prompt.options.length, 5);
    assert.deepEqual(
      prompt.options.map((o) => [o.index, o.label]),
      [
        [1, '赤'],
        [2, '青'],
        [3, '緑'],
        [4, 'Type something'],
        [5, 'Chat about this'],
      ],
    );
    assert.equal(prompt.options[0].description, '暖色系。情熱的で目を引く色。');
    assert.equal(prompt.options[0].cursor, true);
    assert.equal(prompt.options[1].cursor, false);
    assert.equal(prompt.options[3].freeText, true);
    assert.equal(prompt.options[0].freeText, false);
    assert.deepEqual(prompt.tabs.items, [{ label: '好きな色', checked: false }]);
    assert.equal(prompt.tabs.hasSubmit, false);
  });

  it('parses checkbox state and the Submit tab of a multiSelect prompt', () => {
    const prompt = parseChoicePrompt(MULTI_SELECT);

    assert.ok(prompt);
    assert.equal(prompt.question, '好きな果物は？（複数可）');
    assert.equal(prompt.multiSelect, true);
    assert.deepEqual(
      prompt.options.map((o) => [o.label, o.checked]),
      [
        ['りんご', true],
        ['みかん', false],
        ['ぶどう', true],
        ['Type something', false],
        ['Chat about this', null],
      ],
    );
    assert.equal(prompt.options[0].description, 'シャキシャキした食感と酸味のバランスが特徴。');
    // multiSelect の "Submit" 行は説明文に混ぜない
    assert.equal(prompt.options[3].description, '');
    assert.deepEqual(prompt.tabs, {
      items: [{ label: '好きな果物', checked: true }],
      hasSubmit: true,
      canPrev: true,
      canNext: true,
    });
  });

  it('parses the review/submit step reached by Tab (footer is absent there)', () => {
    const prompt = parseChoicePrompt(SUBMIT_TAB);

    assert.ok(prompt);
    assert.deepEqual(
      prompt.options.map((o) => o.label),
      ['Submit answers', 'Cancel'],
    );
    assert.equal(prompt.multiSelect, false);
    assert.equal(prompt.footer, '');
    assert.match(prompt.question, /Ready to submit your answers\?/);
    assert.equal(prompt.tabs.hasSubmit, true);
  });

  it('parses the trust-folder prompt (Enter to confirm)', () => {
    const prompt = parseChoicePrompt(TRUST_PROMPT);

    assert.ok(prompt);
    assert.deepEqual(
      prompt.options.map((o) => o.label),
      ['Yes, I trust this folder', 'No, exit'],
    );
    assert.match(prompt.question, /Quick safety check/);
    assert.equal(prompt.tabs, null);
  });

  it("parses a tool permission prompt (no 'Enter to select' footer)", () => {
    const prompt = parseChoicePrompt(PERMISSION_PROMPT);

    assert.ok(prompt);
    assert.equal(prompt.kind, 'permission');
    assert.equal(prompt.question, 'Do you want to create perm-check.txt?');
    assert.deepEqual(
      prompt.options.map((o) => o.label),
      ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No'],
    );
    assert.equal(prompt.options[0].cursor, true);
    assert.equal(prompt.multiSelect, false);
    assert.equal(prompt.canCancel, true);
    assert.equal(prompt.tabs, null);
    assert.match(prompt.detail, /Create file/);
    assert.match(prompt.detail, /perm-check\.txt/);
    assert.match(prompt.detail, /1 hello/);
    assert.doesNotMatch(prompt.detail, /╌/);
  });

  it('extracts the tool detail (command/notes) of a Bash permission prompt, stopping at the rule', () => {
    const prompt = parseChoicePrompt(BASH_PERMISSION_PROMPT);

    assert.ok(prompt);
    assert.equal(prompt.kind, 'permission');
    assert.equal(prompt.question, 'Do you want to proceed?');
    assert.deepEqual(
      prompt.options.map((o) => o.label),
      ['Yes', 'No'],
    );
    assert.match(prompt.detail, /^Bash command/);
    assert.match(prompt.detail, /cd \/home\/\.\.\. && echo "=== conditionFilter types ==="; grep -n foo/);
    assert.match(prompt.detail, /Read filter rule shape and operator set used by grouping/);
    assert.match(prompt.detail, /grep on 'frontend\/src\/types\/conditionFilter\.ts'/);
    assert.doesNotMatch(prompt.detail, /│/);
    assert.doesNotMatch(prompt.detail, /❯/);
    assert.doesNotMatch(prompt.detail, /⎿/);
  });

  it('keeps only the last line as the question for a one-line Bash permission prompt', () => {
    const prompt = parseChoicePrompt(BASH_ONELINE_PERMISSION_PROMPT);

    assert.ok(prompt);
    assert.equal(prompt.kind, 'permission');
    assert.equal(prompt.question, 'Do you want to proceed?');
    assert.equal(prompt.options.length, 4);
    assert.ok(prompt.detail.startsWith('Bash command'));
    assert.ok(prompt.detail.includes('curl -sI https://example.com | head -3'));
    assert.ok(prompt.detail.includes('This command requires approval'));
    assert.ok(!prompt.detail.includes('Tip:'));
    assert.ok(!prompt.detail.includes('Do you want to proceed?'));
    assert.ok(!prompt.detail.includes('⎿'));
  });

  it('reports kind for question and trust prompts', () => {
    assert.equal(parseChoicePrompt(SINGLE_SELECT).kind, 'question');
    assert.equal(parseChoicePrompt(MULTI_SELECT).kind, 'question');
    assert.equal(parseChoicePrompt(TRUST_PROMPT).kind, 'other');
  });

  it('leaves detail empty for non-permission prompts', () => {
    assert.equal(parseChoicePrompt(SINGLE_SELECT).detail, '');
    assert.equal(parseChoicePrompt(MULTI_SELECT).detail, '');
    assert.equal(parseChoicePrompt(TRUST_PROMPT).detail, '');
  });

  it('returns null when no prompt is on screen', () => {
    assert.equal(parseChoicePrompt(IDLE_SCREEN), null);
    assert.equal(parseChoicePrompt(''), null);
    assert.equal(parseChoicePrompt(null), null);
  });

  it('returns null for a numbered list that is not a prompt (no footer)', () => {
    const screen = `● 手順はこうです。

  1. 依存を入れる
  2. ビルドする
  3. 起動する

✻ Worked for 3s`;
    assert.equal(parseChoicePrompt(screen), null);
  });

  it('picks the newest prompt when an older one is still on screen', () => {
    const screen = `${RULE}
 ☐ 古い質問

古い質問は？

❯ 1. 古いA
  2. 古いB

Enter to select · Esc to cancel
● User answered Claude's questions:
  ⎿  · 古い質問は？ → 古いA
${RULE}
 ☐ 新しい質問

新しい質問は？

❯ 1. 新しいA
  2. 新しいB

Enter to select · ↑/↓ to navigate · Esc to cancel`;

    const prompt = parseChoicePrompt(screen);
    assert.ok(prompt);
    assert.equal(prompt.question, '新しい質問は？');
    assert.deepEqual(
      prompt.options.map((o) => o.label),
      ['新しいA', '新しいB'],
    );
  });
});
