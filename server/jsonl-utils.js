import { basename, join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_BRIDGE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

// cwd からプロジェクトディレクトリ名を算出。Claude Code は `/` だけでなく英数字以外を
// すべて `-` にする（`.claude/worktrees/x` → `--claude-worktrees-x`。実測 v2.1.260）ので同じ規則で写す。
// `/` だけ置換すると worktree 配下の cwd で JSONL が見つからず、tmux タブに履歴もタスクも出ない
// e.g. /path/to/project → -path-to-project
export function cwdToProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// message オブジェクトからテキストを取り出す（maxLen=0 で全文）
export function extractTextContent(msg, maxLen = 0) {
  let text = '';
  if (typeof msg === 'string') {
    text = msg;
  } else if (!msg) {
    return '';
  } else {
    const content = msg.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
    }
  }
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

// タスク通知（バックグラウンドのサブエージェント・シェル・Monitor が終わった／イベントが来たときに Claude Code が差し込む）。
// 本文は `<task-notification><task-id>…<status>completed|failed|killed|stopped</status><summary>…</summary>
// <usage><subagent_tokens>…<tool_uses>…<duration_ms>…</usage></task-notification>` の形（Monitor のイベントは
// status の代わりに <event>）。1 つの本文に複数並ぶこともある。該当しなければ null
const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_TEXT_MAX = 2000;
export function parseTaskNotifications(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification>')) return null;
  const tasks = [...text.matchAll(TASK_NOTIFICATION_PATTERN)].map(([, inner]) => {
    const tag = (name, src = inner) => src.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || '';
    const usage = tag('usage');
    const num = (name) => {
      const v = tag(name, usage);
      return /^\d+$/.test(v) ? Number(v) : null;
    };
    const event = tag('event');
    return {
      taskId: tag('task-id'),
      toolUseId: tag('tool-use-id'),
      status: tag('status') || (event ? 'event' : ''),
      summary: tag('summary'),
      event: event.slice(0, TASK_TEXT_MAX),
      result: tag('result').slice(0, TASK_TEXT_MAX),
      tokens: num('subagent_tokens'),
      toolUses: num('tool_uses'),
      durationMs: num('duration_ms'),
    };
  });
  return tasks.length > 0 ? tasks : null;
}

// タスク通知をチャットのメッセージ（role: 'task'）にする。履歴読み込みと JSONL 監視で共用。
// 通知は必ず queue-operation の enqueue に積まれ、Claude が手すきならその後に同じ本文の user レコード
// （origin.kind === 'task-notification'）としても書かれる（作業中に取り込まれたときは書かれない）。
// 両方出すと二重になるので、enqueue を出して本文を pending に覚え、後から来た同じ本文の user レコードは捨てる。
// 同じ本文が積み直される（enqueue → remove → また enqueue）こともあるので、一度出した本文は shown に覚えて二度出さない。
// state は createTaskNotificationState() で作り、1 つのセッションの読み込み・監視の間だけ持つ。
// 戻り値: タスク通知でなければ null、通知なら {message}（捨てるときは message が null）
export function createTaskNotificationState() {
  return { pending: new Map(), shown: new Set() };
}

export function taskNotificationMessage(record, text, state, { queued = false } = {}) {
  const tasks = parseTaskNotifications(text);
  if (!tasks) return null;
  const key = text.trim();
  const { pending, shown } = state;
  if (queued) {
    pending.set(key, (pending.get(key) || 0) + 1);
  } else {
    const n = pending.get(key) || 0;
    if (n > 0) {
      if (n === 1) pending.delete(key);
      else pending.set(key, n - 1);
      return { message: null };
    }
  }
  if (shown.has(key)) return { message: null };
  shown.add(key);
  return {
    message: {
      role: 'task',
      content: tasks.map((t) => t.summary).join('\n'),
      tasks,
      uuid: record.uuid,
      timestamp: record.timestamp || '',
    },
  };
}

// フックの失敗（`attachment.type === 'hook_non_blocking_error'`）。処理は止まらないが出しておきたいもの。
// ツールのフック（PostToolUse 等）は toolUseID が `toolu_…` なので、そのツールの行に印を付ける（toolUseId）。
// Stop などツールに紐づかないフックは toolUseId が null。stderr は定型の前置きと「No stderr output」を外す
const HOOK_DETAIL_MAX = 500;
export function extractHookError(record) {
  const a =
    record?.type === 'attachment' && record.attachment && typeof record.attachment === 'object'
      ? record.attachment
      : null;
  if (!a || a.type !== 'hook_non_blocking_error') return null;
  const detail = String(a.stderr || '')
    .replace(/^Failed with non-blocking status code:\s*/, '')
    .trim();
  return {
    toolUseId: typeof a.toolUseID === 'string' && a.toolUseID.startsWith('toolu_') ? a.toolUseID : null,
    name: String(a.hookName || a.hookEvent || 'hook'),
    exitCode: a.exitCode != null ? String(a.exitCode) : null,
    command: typeof a.command === 'string' ? a.command : '',
    detail: detail === 'No stderr output' ? '' : detail.slice(0, HOOK_DETAIL_MAX),
  };
}

// フックの失敗をチャットのメッセージにする（履歴読み込みと JSONL 監視で共用）。
// ツールのフックは toolresult として流し、チャットはそのツールの行に「フック失敗」を付ける。
// ツールに紐づかないフックは role: 'hookerror' の 1 行として流す。該当しなければ null
export function hookErrorMessage(record) {
  const hook = extractHookError(record);
  if (!hook) return null;
  const { toolUseId, ...info } = hook;
  const base = { uuid: record.uuid, timestamp: record.timestamp || '' };
  if (toolUseId) return { ...base, role: 'toolresult', content: '', results: [{ id: toolUseId, hookError: info }] };
  return { ...base, role: 'hookerror', content: info.detail, hook: info };
}

// assistant の thinking ブロックのうち中身があるもの（`thinkingDisplay: "updates"` のときに TUI が
// 「· summary」付きの薄い文字で出す途中経過）を 1 つの文字列にする。中身の無い（署名だけの）thinking は空文字
export function extractThinkingText(msg) {
  const content = msg && typeof msg === 'object' ? msg.content : null;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim())
    .map((b) => b.thinking.trim())
    .join('\n\n');
}

// Artifact ツールの publish 成功レコードから公開先を取り出す。
// 成功時だけ toolUseResult がオブジェクトで url/path/title を持つ（失敗時は文字列 + is_error、
// read/list の結果は url を持たない）ので、それを判定条件にしている。
const ARTIFACT_URL_PATTERN = /^https:\/\/claude\.ai\//;

export function extractArtifactPublish(record) {
  if (!record || record.type !== 'user') return null;

  const result = record.toolUseResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  const url = result.url;
  if (typeof url !== 'string' || !ARTIFACT_URL_PATTERN.test(url)) return null;

  const content = record.message?.content;
  if (!Array.isArray(content)) return null;
  const hasSuccess = content.some((b) => b && b.type === 'tool_result' && !b.is_error);
  if (!hasSuccess) return null;

  const path = typeof result.path === 'string' && result.path ? result.path : null;
  const title = result.title || (path ? basename(path) : '') || url;
  return { url, title, path };
}

// tool_result だけの user レコードから、ツールの結果の印を取り出す（失敗・新規作成）。
// 失敗は tool_result の is_error、新規作成は Write の toolUseResult.type === 'create'。
// どちらでもない普通の成功も {id} だけで返す（入力欄の直上の「<ツール> 実行中…」が終わったことを知るため）
export function extractToolResultFlags(record) {
  if (!record || record.type !== 'user') return [];
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const result = record.toolUseResult;
  const created = !!result && typeof result === 'object' && !Array.isArray(result) && result.type === 'create';
  const flags = [];
  for (const block of content) {
    if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    if (block.is_error) flags.push({ id: block.tool_use_id, error: true });
    else if (created) flags.push({ id: block.tool_use_id, created: true });
    else flags.push({ id: block.tool_use_id });
  }
  return flags;
}

// WebFetch の結果レコードから、読んだ URL と結果の見出し（タイトル）を取り出す。
// 結果は tool_result だけの user レコードで、toolUseResult が {bytes, code, codeText, result, durationMs, url}。
// result は WebFetch が返した要約テキストで、先頭行が Markdown の見出しになっていることが多い。
// claude.ai の Artifact を読んだときは `[Artifact <id> "タイトル" — owned by you; ...]` で始まる。
// 失敗時は toolUseResult が文字列なので拾わない。Artifact の publish（extractArtifactPublish）とは result の有無で分かれる
const WEBFETCH_TITLE_MAX = 120;
const ARTIFACT_READ_TITLE_PATTERN = /^\[Artifact [^\]]*"([^"]+)"/;

function webFetchTitle(result, code) {
  // リダイレクト（`REDIRECT DETECTED: ...`）やエラー応答の本文はタイトルにしない
  if (typeof code !== 'number' || code < 200 || code >= 300) return null;
  const firstLine = result.split('\n').find((line) => line.trim());
  if (!firstLine) return null;

  const artifact = firstLine.match(ARTIFACT_READ_TITLE_PATTERN);
  if (artifact) return artifact[1].trim().slice(0, WEBFETCH_TITLE_MAX) || null;

  const title = firstLine
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
  return title ? title.slice(0, WEBFETCH_TITLE_MAX) : null;
}

export function extractWebFetchResult(record) {
  if (!record || record.type !== 'user') return null;

  const result = record.toolUseResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  const url = result.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  // Artifact の publish 結果（url はあるが result が無い）と取り違えない
  if (typeof result.result !== 'string') return null;

  const code = typeof result.code === 'number' ? result.code : null;
  return { url, title: webFetchTitle(result.result, code), code };
}

// 人が打っていない user レコード（タグ注入・isMeta）か。タスク通知（`<task-notification>`）、
// `<system-reminder>`、チームメイトのメッセージなどは本文がタグで始まる。スラッシュコマンド（`<command-name>`）は
// 人の操作なので注入扱いしない。session-summary.js の userPrompt() と同じ考え方
export function isInjectedUserRecord(record) {
  if (!record || record.type !== 'user') return false;
  // 自動コンパクトの要約（`isCompactSummary`）は本文が平文で始まるが、Claude Code が書いたもの
  if (record.isMeta || record.isCompactSummary) return true;
  const text = extractTextContent(record.message, 0).trim();
  if (parseTeammateMessages(text)) return true;
  // スラッシュコマンドは `<command-message>` か `<command-name>` で、`!cmd` は `<bash-input>` で始まる（どれも人の操作）
  return text.startsWith('<') && !/^<(command-name|command-message|bash-input)>/.test(text);
}

// チームメイト（agent team のメンバー）からの送信。origin を持たず、本文が
// `Another Claude session sent a message:\n<teammate-message teammate_id="x" summary="…">本文</teammate-message>\n注意書き`
// の形で記録される（1 レコードに複数ブロックのこともある）。本文は平文か、`{"type":"idle_notification", result?, summary?, idleReason?}` の JSON。
// 該当すれば [{from, summary, body}]、しなければ null
export const PEER_MESSAGE_PREFIX = 'Another Claude session sent a message:';
export function parseTeammateMessages(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(PEER_MESSAGE_PREFIX)) return null;
  const blocks = [...trimmed.matchAll(/<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g)];
  if (blocks.length === 0) return null;
  return blocks.map(([, attrs, inner]) => {
    const attr = (name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || '';
    const raw = inner.trim();
    let body = raw;
    let summary = attr('summary');
    if (raw.startsWith('{')) {
      try {
        const json = JSON.parse(raw);
        summary = summary || (typeof json.summary === 'string' ? json.summary : '');
        body =
          (typeof json.result === 'string' && json.result.trim()) ||
          (typeof json.failureReason === 'string' && json.failureReason.trim()) ||
          summary ||
          (json.type === 'idle_notification' ? '（待機中）' : raw);
      } catch {
        // 平文として扱う
      }
    }
    return { from: attr('teammate_id'), summary, body };
  });
}

// スラッシュコマンド（スキル呼び出し含む）の user レコード本文から `{name: '/ship', args}` を取り出す。
// 本文は `<command-message>ship</command-message>\n<command-name>/ship</command-name>\n<command-args>…</command-args>`
// の形（順序は版で違う）。チャットでタグのまま見せないため。該当しなければ null
export function parseSlashCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^<command-(name|message)>/.test(trimmed)) return null;
  const name = trimmed.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return null;
  const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() || '';
  return { name: name.startsWith('/') ? name : `/${name}`, args };
}

// スキル呼び出しで Claude Code が差し込む SKILL.md の展開（isMeta、本文が `Base directory for this skill: <dir>`）の
// スキル名。人が打った指示ではないので「You」と分けて畳んで見せる。該当しなければ null
const SKILL_BODY_PREFIX = 'Base directory for this skill:';
export function skillNameOf(record) {
  if (!record || record.type !== 'user' || !record.isMeta) return null;
  const text = extractTextContent(record.message, 0).trimStart();
  if (!text.startsWith(SKILL_BODY_PREFIX)) return null;
  const dir = text.slice(SKILL_BODY_PREFIX.length).split('\n')[0].trim().replace(/\/+$/, '');
  return dir.split('/').pop() || 'skill';
}

// user レコード（本文あり）をチャットの human メッセージの属性にする。履歴読み込みと JSONL 監視で共用
export function humanMessageFields(record, text) {
  const command = parseSlashCommand(text);
  const sender = injectedSenderOf(record);
  const teammate = parseTeammateMessages(text);
  return {
    // サブエージェントの報告は枠と注意書きを外した本文、スラッシュコマンドはタグを外した `/ship args`
    content:
      extractHandbackReport(record) ||
      (teammate ? teammate.map((m) => m.body).join('\n\n---\n\n') : null) ||
      (sender?.kind === 'summary' ? sender.tools.join(', ') : null) ||
      (command ? `${command.name}${command.args ? ` ${command.args}` : ''}` : text),
    ...(command ? { command } : {}),
    // タグ注入・isMeta（人が打っていない）ときだけ付ける。リンク一覧で「自分が渡した」と数えないため
    ...(isInjectedUserRecord(record) ? { injected: true } : {}),
    // 送り手（サブエージェントの報告・タスク通知・スキルの展開など）。「You」と区別して見せるため。人の発言には付けない
    ...(sender ? { sender } : {}),
  };
}

// 人が打っていない user レコードの送り手。チャットで「You」と区別して見せるため。
// Claude Code は注入元を `origin.kind` に書く（human / peer / task-notification / coordinator 等）。
// サブエージェントの完了報告は `kind: 'peer'` + `handback: true`（`name` はエージェント種別。無いこともある）、
// 送り合い（SendMessage）は `handback` なしの peer。人の発言なら null
export function injectedSenderOf(record) {
  if (!record || record.type !== 'user') return null;
  const origin = record.origin && typeof record.origin === 'object' ? record.origin : null;
  const name = typeof origin?.name === 'string' && origin.name ? origin.name : undefined;
  if (origin?.kind === 'peer') return { kind: origin.handback ? 'subagent' : 'peer', ...(name ? { name } : {}) };
  if (!origin) {
    const teammate = parseTeammateMessages(extractTextContent(record.message, 0));
    if (teammate) {
      const from = [...new Set(teammate.map((m) => m.from).filter(Boolean))].join(', ');
      const summary = teammate.find((m) => m.summary)?.summary;
      return { kind: 'subagent', ...(from ? { name: from } : {}), ...(summary ? { summary } : {}) };
    }
  }
  if (origin?.kind === 'human' || !isInjectedUserRecord(record)) return null;
  if (origin?.kind === 'task-notification') return { kind: 'task-notification' };
  // コンテキストが尽きて会話を要約したときの続きの冒頭（「This session is being continued …」）
  if (record.isCompactSummary) return { kind: 'compact' };
  const skill = skillNameOf(record);
  if (skill) return { kind: 'skill', name: skill };
  const summaryTools = parseSummaryTools(extractTextContent(record.message, 0));
  if (summaryTools) return { kind: 'summary', tools: summaryTools };
  return { kind: 'system' };
}

// 古いツール結果を Claude Code が要約に置き換えたときに差し込む isMeta の user レコード
// （`<system-reminder><tools-used-before-summary>Read, Grep</tools-used-before-summary></system-reminder>`）の
// ツール名の配列。会話の発言ではないので、チャットでは吹き出しにせず 1 行の注記で見せる。該当しなければ null
export function parseSummaryTools(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(
    /^\s*<system-reminder>\s*<tools-used-before-summary>([\s\S]*?)<\/tools-used-before-summary>\s*<\/system-reminder>\s*$/,
  );
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// サブエージェントの完了報告（peer + handback）の本文だけを取り出す。
// 記録される本文は「Another Claude session sent a message:」+ <agent-message> の枠 + 注意書き +
// 2 スペース字下げの報告、という形なので、`origin.body` の「The report follows:」以降を字下げを戻して返す。
// 形が合わなければ null（呼び出し側は元の本文をそのまま出す）
export function extractHandbackReport(record) {
  const origin = record?.origin;
  if (origin?.kind !== 'peer' || !origin.handback || typeof origin.body !== 'string') return null;
  const marker = 'The report follows:\n';
  const at = origin.body.indexOf(marker);
  if (at < 0) return null;
  const report = origin.body
    .slice(at + marker.length)
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
  return report || null;
}

// message オブジェクトから tool_use ブロックを抽出
export function extractToolUses(msg) {
  if (!msg || typeof msg === 'string') return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input,
      summary: toolUseSummary(b.name, b.input),
    }));
}

function toolUseSummary(name, input) {
  if (!input) return name;
  switch (name) {
    case 'Bash':
      return input.description || input.command?.slice(0, 120) || 'Bash';
    case 'Read':
    case 'Edit':
    case 'Write':
      return shortPath(input.file_path);
    case 'Grep':
    case 'Glob':
      return `${input.pattern}${input.path ? ' in ' + shortPath(input.path) : ''}`;
    case 'Agent':
      return input.description || 'Agent';
    case 'Artifact':
      // publish 以外（read/list 等）は action 名、publish は対象ファイルを出す
      return input.action && input.action !== 'publish' ? input.action : `publish ${shortPath(input.file_path)}`.trim();
    case 'AskUserQuestion':
      // 回答済みの選択肢は会話ログに残るので、何を聞かれたかが分かるようにする
      return (
        (input.questions || [])
          .map((q) => q?.question)
          .filter(Boolean)
          .join(' / ') || 'AskUserQuestion'
      );
    default:
      return name;
  }
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

// コンテキスト窓の上限。JSONL には窓サイズが書かれないので、モデル ID からのヒューリスティック。
// - `[1m]` 付き（Claude Code の 1M 設定）は 1M
// - opus 4.6 以降・opus 5 以降・fable / mythos 系は 1M（この環境の JSONL で `[1m]` 表記なしに
//   700k〜900k の文脈量が実測されたため。200k にすると常時 100% にクランプされて意味を失う）
// - sonnet / haiku / それ以外（不明）は 200k
// さらに実測の文脈量が窓を超えていれば 1M に繰り上げる（表が古くなっても 100% 張り付きにはならない）。
const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_1M = 1_000_000;
const MODELS_1M = /claude-(opus-4-(?:[6-9]|[1-9]\d)|opus-(?:[5-9]|[1-9]\d)|fable|mythos)/;

export function contextWindowFor(model, contextTokens = 0) {
  const id = typeof model === 'string' ? model : '';
  if (id.includes('[1m]') || MODELS_1M.test(id)) return CONTEXT_WINDOW_1M;
  return contextTokens > CONTEXT_WINDOW_DEFAULT ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT;
}

// assistant レコードから「今そのセッションが使っているコンテキスト量」を取り出す。
// Claude Code の statusline と同じ考え方で、直近の assistant の
// input + cache_creation + cache_read が現在の文脈量（output は次ターンの入力になるまで含まれない）。
// usage を持たないレコード（API エラー等）は null を返すので、呼び出し側が末尾から遡って探す。
export function extractContextUsage(record) {
  if (!record || record.type !== 'assistant') return null;

  const usage = record.message?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const inputTokens = num(usage.input_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const model = typeof record.message?.model === 'string' ? record.message.model : '';
  const contextTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  // 全部 0 は API を呼んでいない合成レコード（`<synthetic>` のエラー表示等）。文脈量としては無効
  if (contextTokens === 0) return null;

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    contextTokens,
    contextWindow: contextWindowFor(model, contextTokens),
    model,
  };
}
