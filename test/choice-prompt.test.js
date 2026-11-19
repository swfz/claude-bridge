import { describe, it } from 'vitest';
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

// preview 付きの AskUserQuestion（v2.1.322 の実測）。選択肢の右にプレビュー枠が並び、
// 数字キーはカーソル移動だけで確定しない
const PREVIEW_SELECT = `
❯ AskUserQuestion で1問だけ質問して
${RULE}
 ☐ 図の選択
どの図？
❯ 1. A                            ┌──────────────────────────────────────────┐
  2. B                            │ [Client] --> [API] --> [DB]              │
                                  │    |                                     │
                                  │    +--> [Cache]                          │
                                  └──────────────────────────────────────────┘
                                  Notes: press n to add notes
${RULE}
  Chat about this
Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
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

  it('preview 付きの左右分割レイアウトを preview として返し、ラベルから枠線を外す', () => {
    const p = parseChoicePrompt(PREVIEW_SELECT);
    assert.equal(p.preview, true);
    assert.equal(p.question, 'どの図？');
    assert.deepEqual(
      p.options.map((o) => [o.index, o.label, o.description, o.cursor]),
      [
        [1, 'A', '', true],
        [2, 'B', '', false],
      ],
    );
  });

  it('preview の無い通常の選択肢は preview: false', () => {
    assert.equal(parseChoicePrompt(SINGLE_SELECT).preview, false);
  });
});

// 行の配列から画面テキストを作る（先頭行 = 画面の 1 行目）
const screen = (...lines) => lines.join('\n');
const FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
const PERMISSION_FOOTER = ' Esc to cancel · Tab to amend';

describe('parseChoicePrompt: 選択肢行の読み取り', () => {
  it('説明文の途中にある「2.」は選択肢として扱わない', () => {
    const p = parseChoicePrompt(screen('好きな色は？', '❯ 1. 赤', '     暖色系 2. 補足', '  2. 青', FOOTER));
    assert.deepEqual(
      p.options.map((o) => [o.label, o.description]),
      [
        ['赤', '暖色系 2. 補足'],
        ['青', ''],
      ],
    );
  });

  it('カーソルの後に空白が 2 つ以上あっても選択肢として読む', () => {
    const p = parseChoicePrompt(screen('好きな色は？', '❯  1. 赤', '  2. 青', FOOTER));
    assert.deepEqual(
      p.options.map((o) => [o.label, o.cursor]),
      [
        ['赤', true],
        ['青', false],
      ],
    );
  });

  it('番号とラベルの間に空白が無くても読む', () => {
    const p = parseChoicePrompt(screen('続けますか？', '❯ 1.Yes', '  2.No', FOOTER));
    assert.deepEqual(
      p.options.map((o) => o.label),
      ['Yes', 'No'],
    );
  });

  it('2 桁の番号まで読み、100 番以降は選択肢にしない', () => {
    const optionLines = Array.from({ length: 100 }, (_, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. opt${i + 1}`);
    const p = parseChoicePrompt(screen('どれ？', ...optionLines, FOOTER));
    assert.equal(p.options.length, 99);
    assert.equal(p.options[9].label, 'opt10');
    assert.equal(p.options[98].index, 99);
    assert.equal(p.options[98].label, 'opt99');
  });

  it('「0.」で始まる行は選択肢の並びを切らない（説明として読む）', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. a', '     0. note', '  2. b', FOOTER));
    assert.deepEqual(
      p.options.map((o) => [o.label, o.description]),
      [
        ['a', '0. note'],
        ['b', ''],
      ],
    );
  });

  it('1 から始まらない番号付きリストは選択肢にしない', () => {
    assert.equal(parseChoicePrompt(screen('どれ？', '❯ 2. a', '  3. b', '  4. c', FOOTER)), null);
  });

  it('選択肢が 1 つしか無い画面は選択肢プロンプトにしない', () => {
    assert.equal(parseChoicePrompt(screen('どれ？', '❯ 1. only', FOOTER)), null);
  });

  it('番号が飛んだところで選択肢の並びを打ち切る', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. a', '  2. b', '', '  4. note', FOOTER));
    assert.deepEqual(
      p.options.map((o) => o.label),
      ['a', 'b'],
    );
  });

  it('次の選択肢が 6 行以内なら同じ並びとして読み、7 行離れたら別物とみなす', () => {
    const near = parseChoicePrompt(
      screen('どれ？', '❯ 1. a', '  d1', '  d2', '  d3', '  d4', '  d5', '  2. b', FOOTER),
    );
    assert.deepEqual(
      near.options.map((o) => [o.label, o.description]),
      [
        ['a', 'd1 d2 d3 d4 d5'],
        ['b', ''],
      ],
    );

    const far = screen('どれ？', '❯ 1. a', '  d1', '  d2', '  d3', '  d4', '  d5', '  d6', '  2. b', FOOTER);
    assert.equal(parseChoicePrompt(far), null);
  });

  it('説明文から空行・操作案内・会話ログの行を除き、残りを空白 1 つで繋ぐ', () => {
    const p = parseChoicePrompt(
      screen(
        'どれ？',
        '❯ 1. a',
        '     line one',
        '',
        '     line two',
        '     Esc to cancel',
        '     ⎿ log',
        '  2. b',
        FOOTER,
      ),
    );
    assert.equal(p.options[0].description, 'line one line two');
  });

  it('ラベルの末尾のピリオドだけを落とし、途中のピリオドは残す', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. Use v1.2', '  2. Other .', FOOTER));
    assert.deepEqual(
      p.options.map((o) => o.label),
      ['Use v1.2', 'Other'],
    );
  });

  it('チェックボックスは行頭の [ ] / [x] だけを見る（空白の有無・量を問わない）', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. Use [x] flag', '  2. [x]foo', '  3.  [x] bar', FOOTER));
    assert.deepEqual(
      p.options.map((o) => [o.label, o.checked]),
      [
        ['Use [x] flag', null],
        ['foo', true],
        ['bar', true],
      ],
    );
    assert.equal(p.multiSelect, true);
  });

  it('「Type something」で始まる選択肢だけを自由入力とみなす', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. Or Type something', '  2. Type something.', FOOTER));
    assert.deepEqual(
      p.options.map((o) => o.freeText),
      [false, true],
    );
  });
});

describe('parseChoicePrompt: プロンプトとみなす条件・フッター', () => {
  it('文字列以外は null を返す', () => {
    assert.equal(parseChoicePrompt(123), null);
    assert.equal(parseChoicePrompt({ split: 1 }), null);
    assert.equal(parseChoicePrompt(undefined), null);
  });

  it('フッターもタブも無くてもカーソルがあればプロンプトとみなす', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. a', '  2. b'));
    assert.ok(p);
    assert.equal(p.footer, '');
    assert.equal(p.canCancel, false);
  });

  it('カーソルが無くてもフッターがあればプロンプトとみなす', () => {
    const p = parseChoicePrompt(screen('どれ？', '  1. a', '  2. b', FOOTER));
    assert.ok(p);
    assert.deepEqual(
      p.options.map((o) => o.cursor),
      [false, false],
    );
  });

  it('選択肢より上にある古いフッターは使わない', () => {
    const p = parseChoicePrompt(screen(FOOTER, '● answered', '新しい質問？', '❯ 1. a', '  2. b'));
    assert.equal(p.footer, '');
    assert.equal(p.canCancel, false);
  });

  it('フッターは前後の空白を落として返す', () => {
    assert.equal(parseChoicePrompt(PERMISSION_PROMPT).footer, 'Esc to cancel · Tab to amend');
  });
});

describe('parseChoicePrompt: 質問文の集め方', () => {
  it('画面の 1 行目にある質問文も拾う', () => {
    assert.equal(parseChoicePrompt(screen('最初の行？', '❯ 1. a', '  2. b', FOOTER)).question, '最初の行？');
  });

  it('質問文は直近の 14 行までにする', () => {
    const qLines = Array.from({ length: 16 }, (_, i) => `q${i + 1}`);
    const p = parseChoicePrompt(screen(...qLines, '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.question, qLines.slice(2).join('\n'));
  });

  it('選択肢の直前の空行は飛ばし、質問文の上に空行が 2 つ続いたら打ち切る', () => {
    const p = parseChoicePrompt(screen('old text', '', '', '新しい質問？', '', '', '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.question, '新しい質問？');
  });

  it('質問文の途中に出た操作案内の行は飛ばし、行末の空白は落とす', () => {
    const p = parseChoicePrompt(screen('Line A   ', 'Esc to cancel', 'Line B  ', '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.question, 'Line A\nLine B');
  });

  it('入力欄（❯ / >）の行で質問文の遡りを止める', () => {
    for (const prompt of ['❯ my prompt', '> quoted prompt']) {
      const p = parseChoicePrompt(screen(prompt, 'どれ？', '❯ 1. a', '  2. b', FOOTER));
      assert.equal(p.question, 'どれ？');
    }
  });

  it('質問文の途中にある記号（· │）や罫線風の文字列では打ち切らない', () => {
    const p = parseChoicePrompt(screen('========== 上', 'A · B │ C', '下 ==========', '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.question, '========== 上\nA · B │ C\n下 ==========');
  });

  it('文中に「do you want」があってもフッターに Tab to amend が無ければ permission にしない', () => {
    const p = parseChoicePrompt(screen('So, do you want this? Allow it?', '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.kind, 'other');
    assert.equal(p.question, 'So, do you want this? Allow it?');
    assert.equal(p.detail, '');
  });
});

describe('parseChoicePrompt: 質問タブ', () => {
  it('タブ行の無い質問は前後への移動を持たない', () => {
    assert.deepEqual(parseChoicePrompt(SINGLE_SELECT).tabs, {
      items: [{ label: '好きな色', checked: false }],
      hasSubmit: false,
      canPrev: false,
      canNext: false,
    });
  });

  it('字下げされたタブ行・空白の無い ✔Submit・空の見出しを読み分ける', () => {
    const p = parseChoicePrompt(
      screen('   ←  ☐ favorite color  ☒   ☐形  ✔Submit  →', '', 'どれ？', '❯ 1. a', '  2. b', FOOTER),
    );
    assert.deepEqual(p.tabs, {
      items: [
        { label: 'favorite color', checked: false },
        { label: '形', checked: false },
      ],
      hasSubmit: true,
      canPrev: true,
      canNext: true,
    });
    assert.equal(p.question, 'どれ？');
  });

  it('見出しの無い ☐ だけの行はタブとみなさない', () => {
    const p = parseChoicePrompt(screen('☐', 'どれ？', '❯ 1. a', '  2. b', FOOTER));
    assert.equal(p.tabs, null);
    assert.equal(p.kind, 'other');
  });

  it('選択肢のラベルにある ☐ はタブとみなさない', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. ☐ todo', '  2. done', FOOTER));
    assert.equal(p.tabs, null);
    assert.equal(p.options[0].label, '☐ todo');
  });

  it('画面の 1 行目にあるタブ行も拾う', () => {
    const p = parseChoicePrompt(screen(' ☐ 色', 'どれ？', '❯ 1. a', '  2. b', FOOTER));
    assert.deepEqual(p.tabs.items, [{ label: '色', checked: false }]);
  });

  it('タブ行は選択肢の 18 行上までを探す', () => {
    const fillers = (n) => Array.from({ length: n }, (_, i) => `x${i + 1}`);
    const within = parseChoicePrompt(screen('filler', ' ☐ 色', ...fillers(17), '❯ 1. a', '  2. b', FOOTER));
    assert.deepEqual(within.tabs.items, [{ label: '色', checked: false }]);

    const beyond = parseChoicePrompt(screen('filler', ' ☐ 色', ...fillers(18), '❯ 1. a', '  2. b', FOOTER));
    assert.equal(beyond.tabs, null);
  });
});

describe('parseChoicePrompt: preview レイアウト', () => {
  it('フッターに「n to add notes」があれば preview とし、選択肢の間の行を説明にしない', () => {
    const p = parseChoicePrompt(
      screen('どれ？', '❯ 1. A', '     desc a', '  2. B', 'Enter to select · n to add notes · Esc to cancel'),
    );
    assert.equal(p.preview, true);
    assert.deepEqual(
      p.options.map((o) => o.description),
      ['', ''],
    );
  });

  it('1 つの選択肢の右にだけ枠があっても preview とし、枠の続きを説明にしない', () => {
    const p = parseChoicePrompt(
      screen(
        'どれ？',
        '❯ 1. A                ┌────┐',
        '                      │ x  │',
        '                      └────┘',
        '  2. B',
        FOOTER,
      ),
    );
    assert.equal(p.preview, true);
    assert.deepEqual(
      p.options.map((o) => [o.label, o.description]),
      [
        ['A', ''],
        ['B', ''],
      ],
    );
  });

  it('ラベル内の 2 つ続きの空白は枠とみなさない', () => {
    const p = parseChoicePrompt(screen('どれ？', '❯ 1. A  B', '  2. C', FOOTER));
    assert.equal(p.preview, false);
    assert.equal(p.options[0].label, 'A  B');
  });
});

describe('parseChoicePrompt: permission の detail', () => {
  it('罫線から質問までを、空行を整え・ガターと Tip 行を落として切り出す', () => {
    const p = parseChoicePrompt(
      screen(
        '─'.repeat(60),
        '',
        ' Bash command',
        '   head ────────────',
        '   ──────────── tail',
        ' a · b',
        '',
        '',
        ' Note Tip: keep',
        ' Tip: drop me',
        ' │ guttered',
        ' │foo',
        ' x │ y',
        '',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        '',
        PERMISSION_FOOTER,
      ),
    );
    assert.equal(p.kind, 'permission');
    assert.equal(p.question, 'Do you want to proceed?');
    assert.equal(
      p.detail,
      [
        'Bash command',
        'head ────────────',
        '──────────── tail',
        'a · b',
        '',
        'Note Tip: keep',
        'guttered',
        'foo',
        'x │ y',
      ].join('\n'),
    );
  });

  it('入力欄（❯ / >）の行で detail の遡りを止める', () => {
    for (const prompt of ['❯ do something', '> quoted']) {
      const p = parseChoicePrompt(
        screen(prompt, '  some detail', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', PERMISSION_FOOTER),
      );
      assert.equal(p.detail, 'some detail');
    }
  });

  it('画面の 1 行目まで detail として拾う', () => {
    const p = parseChoicePrompt(
      screen('cmd here', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', PERMISSION_FOOTER),
    );
    assert.equal(p.detail, 'cmd here');
  });

  it('罫線が見つからなければ直近の 40 行までを detail にする', () => {
    const dLines = Array.from({ length: 45 }, (_, i) => `d${i + 1}`);
    const p = parseChoicePrompt(
      screen(...dLines, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', PERMISSION_FOOTER),
    );
    assert.equal(p.detail, dLines.slice(5).join('\n'));
  });

  it('質問文が無ければ question も detail も空にする', () => {
    const p = parseChoicePrompt(screen('─'.repeat(60), ' ❯ 1. Yes', '   2. No', PERMISSION_FOOTER));
    assert.equal(p.kind, 'permission');
    assert.equal(p.question, '');
    assert.equal(p.detail, '');
  });
});
