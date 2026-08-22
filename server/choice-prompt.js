// Claude Code の TUI に出ている「選択肢プロンプト」を画面テキストから構造化する。
//
// AskUserQuestion（会話中の選択肢）・ツールの permission プロンプト・起動時の trust 確認は
// どれも「番号つきの選択肢リスト + フッター」という同じ形で描画され、番号キー1つで操作できる。
// JSONL には回答が終わるまで書かれないため（tool_use は回答後にまとめて記録される）、
// 待っている間に選択肢の中身を知る手段は画面テキストだけ。ここではその画面をパースする。
//
// 純粋関数なので入力は capture-pane 等で取った文字列。tmux でも内蔵 PTY でも同じものを使う。

const OPTION_RE = /^(\s*)(❯\s+)?(\d+)\.\s?(.*)$/;
const CHECKBOX_RE = /^\[([ x✔✓X])\]\s*(.*)$/;
const RULE_RE = /^[─━—╌┄┈\-=]{10,}$/;
// 選択待ちの画面に必ず出るフッター。AskUserQuestion / trust は "Enter to select|confirm"、
// permission プロンプトは "Esc to cancel · Tab to amend" だけで Enter 行が無い。
const FOOTER_RE = /(Enter to (select|confirm|submit)|Esc to (cancel|reject)|Tab to amend)/;
const TAB_RE = /[☐☒]/;
const FREE_TEXT_RE = /^Type something/i;
// permission プロンプトの問いかけ（"Do you want to create foo.txt?" 等）
const PERMISSION_QUESTION_RE = /^(Do you want to|Do you want|Allow )/i;

// 質問文を遡って集めるときに、ここに当たったら打ち切る行（会話ログを巻き込まないため）
const QUESTION_STOP_RE = /^([●✻⏺✽·]|⎿|❯\s|>\s|╭|╰|│)/;

// 選択肢行の間隔がこれ以上離れていたら別ブロックとみなす。
// `5. Chat about this` のように罫線を挟んで続くケースがあるので少し緩めにする。
const MAX_OPTION_GAP = 6;
const MAX_QUESTION_LINES = 14;

const isRule = (line) => RULE_RE.test(line.trim());

function parseOptionLine(line) {
  const m = OPTION_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, , cursor, num, rest] = m;
  const index = Number(num);
  if (!Number.isInteger(index) || index < 1 || index > 99) return null;
  return { index, cursor: Boolean(cursor), text: rest.trim() };
}

// `←  ☒ 好きな果物  ✔ Submit  →` / ` ☐ 好きな色` のタブ行を分解する
function parseTabLine(line) {
  const text = line.trim();
  if (!TAB_RE.test(text)) return null;
  const items = [];
  const re = /([☐☒])\s*([^☐☒✔→←]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const label = m[2].trim().replace(/\s+$/, '');
    if (label) items.push({ label, checked: m[1] === '☒' });
  }
  if (items.length === 0) return null;
  return {
    items,
    hasSubmit: /✔\s*Submit/.test(text),
    canPrev: text.startsWith('←'),
    canNext: text.endsWith('→'),
  };
}

// 画面の下側にある「番号 1 から始まる連続した選択肢群」を切り出す
function findOptionBlock(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseOptionLine(lines[i]);
    if (parsed) found.push({ ...parsed, line: i });
  }
  if (found.length === 0) return null;

  // 末尾側の 1. から始まるブロックを採用する（画面上に古い選択肢が残っていても最新を選ぶ）
  let start = -1;
  for (let i = found.length - 1; i >= 0; i--) {
    if (found[i].index === 1) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const block = [found[start]];
  for (let i = start + 1; i < found.length; i++) {
    const prev = block[block.length - 1];
    if (found[i].index !== prev.index + 1) break;
    if (found[i].line - prev.line > MAX_OPTION_GAP) break;
    block.push(found[i]);
  }
  return block;
}

// 選択肢行の直後から次の選択肢行までの間にある説明文を取る
function collectDescription(lines, from, to) {
  const parts = [];
  for (let i = from; i < to; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (isRule(text)) continue;
    if (FOOTER_RE.test(text)) continue;
    if (text === 'Submit') continue; // multiSelect の Submit 行は説明ではない
    if (QUESTION_STOP_RE.test(text)) continue;
    parts.push(text);
  }
  return parts.join(' ');
}

// 選択肢ブロックより上にある質問文（複数行ありうる）を遡って集める
function collectQuestion(lines, blockStart) {
  const collected = [];
  let blanks = 0;
  for (let i = blockStart - 1; i >= 0 && collected.length < MAX_QUESTION_LINES; i--) {
    const text = lines[i].trim();
    if (!text) {
      // 空行は段落の区切り。2 つ以上続いたら（＝離れた場所）そこで打ち切る
      if (collected.length > 0 && ++blanks >= 2) break;
      continue;
    }
    if (isRule(text) || parseTabLine(lines[i]) || QUESTION_STOP_RE.test(text)) break;
    if (FOOTER_RE.test(text)) continue;
    blanks = 0;
    collected.push(text);
  }
  return collected.reverse().join('\n');
}

/**
 * 画面テキストから選択肢プロンプトを抽出する。出ていなければ null。
 *
 * @param {string} screen capture-pane 等で取った画面テキスト
 * @returns {null | {
 *   question: string,
 *   options: Array<{index:number,label:string,description:string,checked:boolean|null,cursor:boolean,freeText:boolean}>,
 *   multiSelect: boolean,
 *   tabs: null | {items:Array<{label:string,checked:boolean}>,hasSubmit:boolean,canPrev:boolean,canNext:boolean},
 *   footer: string,
 *   canCancel: boolean,
 * }}
 */
export function parseChoicePrompt(screen) {
  if (!screen || typeof screen !== 'string') return null;
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));

  const block = findOptionBlock(lines);
  if (!block || block.length < 2) return null;

  const blockEnd = block[block.length - 1].line;
  const footerLine = lines.slice(block[0].line).find((l) => FOOTER_RE.test(l));

  let tabs = null;
  for (let i = block[0].line - 1; i >= 0 && i >= block[0].line - MAX_QUESTION_LINES - 4; i--) {
    const parsed = parseTabLine(lines[i]);
    if (parsed) {
      tabs = parsed;
      break;
    }
  }

  // 選択待ちの画面には必ず ❯ のカーソルが1つ乗る。フッター（"Enter to select …"）や
  // 質問タブが無い画面もある（複数選択の Review 画面）ので、どれか1つあれば認める。
  // 会話ログ中の番号付きリストを拾わないための最低条件。
  const hasCursor = block.some((o) => o.cursor);
  if (!footerLine && !hasCursor && !tabs) return null;

  const options = block.map((opt, i) => {
    const nextLine = i + 1 < block.length ? block[i + 1].line : blockEnd + 1;
    const cb = CHECKBOX_RE.exec(opt.text);
    const label = (cb ? cb[2] : opt.text).replace(/\.$/, '').trim();
    return {
      index: opt.index,
      label,
      description: collectDescription(lines, opt.line + 1, nextLine),
      checked: cb ? cb[1] !== ' ' : null,
      cursor: opt.cursor,
      freeText: FREE_TEXT_RE.test(label),
    };
  });

  const footer = footerLine ? footerLine.trim() : '';
  const question = collectQuestion(lines, block[0].line);
  return {
    kind: detectKind({ question, tabs, footer }),
    question,
    options,
    multiSelect: options.some((o) => o.checked !== null),
    tabs,
    footer,
    canCancel: /Esc to cancel/i.test(footer),
  };
}

// 画面から待ちの種類を推定する。~/.claude/sessions の waitingFor とは独立に判定できるので、
// UI のラベル（質問なのかツール許可なのか）はこちらを使える。
function detectKind({ question, tabs, footer }) {
  if (tabs) return 'question';
  if (PERMISSION_QUESTION_RE.test(question) || /Tab to amend/.test(footer)) {
    return 'permission';
  }
  return 'other';
}
