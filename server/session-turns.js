import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { extractContextUsage } from './jsonl-utils.js';
import { userPrompt } from './session-summary.js';

// ホームの「セッション詳細」に出すターン詳細。ユーザーの指示 1 件を 1 ターンとして、
// 時刻・所要時間・トークン・コンテキスト量・コミット・PR・編集したファイルを並べる。
// パネルを開いたときにだけ読む（JSONL 全文を読むので一覧のポーリングには載せない）。

const execAsync = promisify(exec);

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const PROMPT_MAX = 200;
const SUBJECT_MAX = 120;

function parseRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 書きかけ・壊れた行は無視
    }
  }
  return records;
}

// git commit のコマンドから件名（1 行目）を取り出す。1 つの Bash で複数回コミットする
// こともあるので配列で返す。出力からハッシュを拾うのはフックの出力が混ざったり出力を
// 絞って実行していたりして当てにならないので、件名を取って git log と突き合わせる。
//   git commit -m "件名" / -m '件名'
//   git commit -F - <<'EOF'\n件名\n…EOF / -m "$(cat <<'EOF'\n件名\n…"
export function parseCommitSubjects(command) {
  if (typeof command !== 'string') return [];
  const lines = command.split('\n');
  const subjects = [];
  // ヒアドキュメントの本文を読み飛ばす（i を終端の行まで進める）。git commit 以外の
  // ヒアドキュメント（スクリプトやファイルの書き出し）の中の文字列を拾わないため
  const skipHeredoc = (i, terminator, onLine) => {
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== terminator; j++) onLine?.(lines[j]);
    return j;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    // コマンドの先頭か、&& ; | の直後にある git commit だけを数える（コメントや文字列は除く）
    const isCommit = /(?:^|&&|\|\||[;|(])\s*git\s+(?:-\S+\s+(?:\S+\s+)?)*commit\b/.test(line);
    if (!isCommit) {
      if (heredoc) i = skipHeredoc(i, heredoc[1]);
      continue;
    }
    // --amend は件名を変えないことも多く、新しい成果として数えない
    if (/--amend\b/.test(line)) {
      if (heredoc) i = skipHeredoc(i, heredoc[1]);
      continue;
    }
    if (heredoc) {
      // 本文の最初の非空行を件名にする
      let subject = null;
      i = skipHeredoc(i, heredoc[1], (body) => {
        if (!subject && body.trim()) subject = body.trim();
      });
      if (subject) subjects.push(subject.slice(0, SUBJECT_MAX));
      continue;
    }
    const quoted = line.match(/\s-(?:m|-message)(?:\s+|=)(["'])(.*?)\1/);
    if (quoted && quoted[2].trim() && !quoted[2].startsWith('$(')) {
      subjects.push(quoted[2].trim().slice(0, SUBJECT_MAX));
    }
  }
  return subjects;
}

// ターンの区切りになる指示。普通の指示に加え、スラッシュコマンド（/ship など）は本文が
// <command-name> タグで書かれ userPrompt() では落ちるので、コマンド名と引数を取り出す
export function turnPrompt(record) {
  if (record.type !== 'user' || record.isMeta) return '';
  const content = record.message?.content;
  if (typeof content === 'string') {
    const name = content.match(/<command-name>([^<]+)<\/command-name>/);
    if (name) {
      const args = content.match(/<command-args>([^<]*)<\/command-args>/);
      return `${name[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`;
    }
  }
  const prompt = userPrompt(record);
  return prompt.startsWith('[Request interrupted') ? '' : prompt;
}

function toolResultIsError(block) {
  return block?.is_error === true;
}

function emptyTurn(record, prompt) {
  return {
    startedAt: record.timestamp || '',
    prompt: prompt.slice(0, PROMPT_MAX),
    durationMs: 0,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    contextUsage: null,
    commits: [],
    prs: [],
    editedFiles: [],
  };
}

// JSONL のレコード列 → ターンの配列。純粋関数（テストしやすいよう git には触らない）
export function buildTurns(records) {
  const turns = [];
  let turn = null;
  // 1 つの応答は content ブロックごとに複数レコードへ分割され、同じ usage が繰り返し
  // 書かれる。そのまま足すと何倍にも数えるので message.id ごとに 1 回だけ数える
  const countedMessages = new Set();
  const pendingCommits = new Map(); // tool_use_id -> { turn, subjects }
  const seenPrs = new Set();
  const edited = new Map(); // turn -> Set

  for (const record of records) {
    if (record.type === 'user') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const pending = pendingCommits.get(block.tool_use_id);
          if (!pending) continue;
          pendingCommits.delete(block.tool_use_id);
          if (toolResultIsError(block)) continue;
          for (const subject of pending.subjects) pending.turn.commits.push({ subject, hash: null });
        }
      }
      const prompt = turnPrompt(record);
      if (prompt) {
        turn = emptyTurn(record, prompt);
        turns.push(turn);
        edited.set(turn, new Set());
      }
      continue;
    }
    if (!turn) continue;

    if (record.type === 'system' && record.subtype === 'turn_duration') {
      turn.durationMs += Number(record.durationMs) || 0;
      continue;
    }
    if (record.type === 'pr-link' && record.prUrl && !seenPrs.has(record.prUrl)) {
      seenPrs.add(record.prUrl);
      turn.prs.push({ url: record.prUrl, number: record.prNumber ?? null, repository: record.prRepository || '' });
      continue;
    }
    if (record.type !== 'assistant') continue;

    const id = record.message?.id;
    const usage = record.message?.usage;
    if (usage && !(id && countedMessages.has(id))) {
      if (id) countedMessages.add(id);
      turn.tokens.input += usage.input_tokens || 0;
      turn.tokens.output += usage.output_tokens || 0;
      turn.tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
      turn.tokens.cacheRead += usage.cache_read_input_tokens || 0;
      turn.tokens.total = turn.tokens.input + turn.tokens.output + turn.tokens.cacheCreation + turn.tokens.cacheRead;
    }
    const context = extractContextUsage(record);
    if (context) turn.contextUsage = context;

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(block.name)) {
        const path = block.input?.file_path || block.input?.notebook_path;
        if (typeof path === 'string') edited.get(turn).add(path);
      } else if (block.name === 'Bash') {
        const subjects = parseCommitSubjects(block.input?.command);
        if (subjects.length > 0 && block.id) pendingCommits.set(block.id, { turn, subjects });
      }
    }
  }

  for (const t of turns) t.editedFiles = [...edited.get(t)].sort();
  return turns;
}

export function summarizeTurns(turns) {
  const files = new Set();
  const totals = { prompts: turns.length, tokens: 0, durationMs: 0, commits: 0, prs: 0, editedFiles: 0 };
  for (const t of turns) {
    totals.tokens += t.tokens.total;
    totals.durationMs += t.durationMs;
    totals.commits += t.commits.length;
    totals.prs += t.prs.length;
    for (const f of t.editedFiles) files.add(f);
  }
  totals.editedFiles = files.size;
  return totals;
}

// git log の「短縮ハッシュ\t件名」から件名 → ハッシュを引き、コミットにハッシュを埋める。
// 同じ件名が複数あれば新しい方（git log は新しい順）
export function attachCommitHashes(turns, logText) {
  const bySubject = new Map();
  for (const line of logText.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const subject = line.slice(tab + 1).slice(0, SUBJECT_MAX);
    if (!bySubject.has(subject)) bySubject.set(subject, line.slice(0, tab));
  }
  for (const t of turns) {
    for (const c of t.commits) c.hash = bySubject.get(c.subject) || null;
  }
}

async function resolveCommitHashes(turns, cwd) {
  if (!cwd || !turns.some((t) => t.commits.length > 0)) return;
  // since はシェルに埋め込むので、自分で作った ISO 形式だけを通す
  const since = new Date(Date.parse(turns[0].startedAt) - 60 * 60 * 1000).toISOString();
  if (!/^[\d\-T:.Z]+$/.test(since)) return;
  try {
    const { stdout } = await execAsync(`git log --all --since=${since} --format=%h%x09%s -n 5000`, {
      cwd,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    attachCommitHashes(turns, stdout);
  } catch {
    // cwd が消えている・git 管理外。件名だけ出す
  }
}

export async function readSessionTurns(filePath, { cwd } = {}) {
  const records = parseRecords(await readFile(filePath, 'utf-8'));
  const turns = buildTurns(records);
  await resolveCommitHashes(turns, cwd);
  return { turns, totals: summarizeTurns(turns) };
}
