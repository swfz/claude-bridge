import {
  existsSync,
  readdirSync,
  statSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'fs';
import { join, dirname, relative, sep } from 'path';
import { CLAUDE_PROJECTS_DIR } from './jsonl-utils.js';
import { DATA_DIR } from './storage.js';
import { readFirstLines, summarizeHead } from './session-summary.js';
import { turnPrompt } from './session-turns.js';

// GitHub の草に相当する「日別の活動量」を JSONL から集計する。
// ~/.claude/projects 以下は数百 MB あるので、ファイル単位で日別集計をキャッシュし、
// 2 回目以降は「追記された分」だけを読み足す（JSONL は追記のみ）。

// 2: 週間カレンダー用に 10 分枠の集計（slots）を追加
// 3: カレンダーの点（指示した時刻）用に、人の指示の時刻を分単位で持つ（prompts）
// 4: 同じ API 応答の行を 1 回だけ数えるため、最後に加算した応答のキー（lastUsageKey）を持つ
// 5: サブエージェント・チームメイトからの送信（`Another Claude session sent a message:`）を指示（prompts）から外す
// 6: 10 分枠に AI 稼働時間・自動ツール・許可回数・縮める対象のツールの列を追加し、再開用の状態（busy・costStates・lastConvMs）を持つ。
//    上げないと main の v5 キャッシュ（slots が 4 列）がそのまま受け入れられ、再走査されず過去の稼働が 0 のままになる
const CACHE_VERSION = 6;
const MINUTE_MS = 60 * 1000;
const CACHE_FILE = join(DATA_DIR, 'activity-heatmap.json');
const DAY_MS = 24 * 60 * 60 * 1000;
// 日別セルの持ち方。JSON に落とすので配列で持つ（キー名の重複を避けて小さくする）
const PROMPTS = 0;
const REPLIES = 1;
const INPUT = 2;
const OUTPUT = 3;
const CACHE_CREATE = 4;
const CACHE_READ = 5;
const CELL_SIZE = 6;

const emptyCell = () => new Array(CELL_SIZE).fill(0);

// 週間カレンダー用の 10 分枠。キーはエポックからの枠番号（ローカル時刻への変換は表示側）。
export const SLOT_MS = 10 * 60 * 1000;
const SLOT_PROMPTS = 0;
const SLOT_REPLIES = 1;
const SLOT_RESEARCH = 2;
const SLOT_EDIT = 3;
// AI 稼働時間（推論＋ツール実行、ms）。Datadog の AI 稼働時間（api_request と tool_result の duration_ms を
// 呼び出しごとに足し上げる）に揃え、JSONL のタイムスタンプから呼び出しごとに推定して、開始〜終了を跨ぐ枠に按分する。
// 並列のツール・並行セッション・サブエージェントも壁時計にせずそのまま足す（1 枠に 10 分を超えて積まれ得る）
const SLOT_BUSY = 4;
// 自動で数えたツール時間（ms。config・auto モード・上限付きの分で、人の許可ツールと推論は含めない）。
// 人の許可ツールに cost-state の実測を配分するとき「実測のうち自動ツールで説明できる分」を引くのに使う
const SLOT_AUTO_TOOL = 5;
// 人がツールの実行を許可した回数（結果の時刻の枠。拒否・AskUserQuestion / ExitPlanMode は数えない。
// 判定の記録 permissionDecision は Claude Code v2.1.293＝2026-10-08 以降にしか無いので、それ以前は 0）
const SLOT_HUMAN_APPROVALS = 6;
// 実測に合わせて縮める対象のツール時間（ms）。自動で数えたツールのうち durationMs（実測）の無いもの、つまり
// config（10/8 以降の自動許可）と未検証（permissionDecision の無い 10/7 以前）の呼び出し。タイムスタンプ差には
// 許可待ち・auto モードの判定待ち（1 呼び出しあたり 1〜2 秒。cost-state にも Datadog の tool_result にも入らない）
// が入るので、走査時は全体を数え、集計時に cost-state の実測に合わせて縮める（adjustAutoTools）
const SLOT_SHRINKABLE_TOOL = 7;
const SLOT_SIZE = 8;
// 1 回の呼び出しとして数える上限。推論（API 応答 1 回）には常にかけ、ツール実行には
// 許可待ちを含み得るのに実測（cost-state）で縮められないとき（adjustAutoTools。未検証ツールだけ）にかける。
// 許可判定の記録（permissionDecision）が無い 10/7 以前の default モード等では、タイムスタンプ差に
// 許可待ちが入り得る。この上限はその膨らみを抑えるためのもの（推論は cost-state の実測とほぼ一致: 0.98 倍）
export const MAX_CALL_MS = 600 * 1000;
// 人がツールの実行を拒否したときの tool_result の定型文（permissionDecision が無い古い記録用）
const USER_REJECT_TEXT = "doesn't want to proceed";
// 結果が返るまで人の回答を待つツール。待ち時間が実行時間に見えるので数えない
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// 未解決の tool_use を持ちすぎない（中断などで結果の来ないものが溜まるため）
const MAX_PENDING_TOOLS = 200;
// 更新が止まってからこれだけ経ったファイルは、保留中のツール（held）を応答の最後の行で確定させる。
// サブエージェントは完了報告の tool_result で終わり、強制終了した本体もツールの結果で終わり得るので、
// 後続の行が来ず保留のまま永久に数えられないのを防ぐ
const STALE_FILE_MS = 10 * 60 * 1000;
// 応答の生成が終わってから 1 件ずつ順に実行されるツール。2 件目以降は直前の結果から数える（順番待ちを除く）。
// Bash と MCP は並列に実行され得るので含めない
const SEQUENTIAL_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// 「調査していたのか、手を動かしていたのか」を枠ごとに見るためのツールの分類
const RESEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function slotCellOf(slots, timestamp) {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return slotCellAt(slots, Math.floor(ms / SLOT_MS));
}

function slotCellAt(slots, index) {
  let cell = slots[index];
  if (!cell) {
    cell = new Array(SLOT_SIZE).fill(0);
    slots[index] = cell;
  }
  return cell;
}

function countTools(content, slot) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    if (RESEARCH_TOOLS.has(block.name)) slot[SLOT_RESEARCH] += 1;
    else if (EDIT_TOOLS.has(block.name)) slot[SLOT_EDIT] += 1;
  }
}

// ~/.claude/projects 以下の JSONL を全部集める。
// 本体（<projectDir>/<sessionId>.jsonl）に加えサブエージェント
// （<projectDir>/<sessionId>/subagents/agent-*.jsonl）も対象にする。
// サブエージェントの発話は本体側には書かれないので二重計上にはならない。
function collectJsonlFiles(dir) {
  const files = [];
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const fileStat = statSync(child);
          files.push({ path: child, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  };
  walk(dir);
  return files;
}

// ローカルタイムの YYYY-MM-DD（草は「自分の1日」で切りたいので UTC ではない）
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ISO タイムスタンプ → ローカル日付。数百万行を捌くので
// 「同じ時（YYYY-MM-DDTHH）なら同じ日付」を使って Date の生成を減らす。
function makeDateKeyResolver() {
  const cache = new Map();
  return (timestamp) => {
    if (typeof timestamp !== 'string' || timestamp.length < 13) return null;
    const hourKey = timestamp.slice(0, 13);
    let key = cache.get(hourKey);
    if (key === undefined) {
      const date = new Date(timestamp);
      key = Number.isNaN(date.getTime()) ? null : localDateKey(date);
      cache.set(hourKey, key);
    }
    return key;
  };
}

// ユーザーの「実際の入力」かどうか。tool_result（ツールの実行結果）は
// user レコードとして書かれるが人が打ったものではないので数えない。
function isUserPrompt(record) {
  if (record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  if (content.some((block) => block?.type === 'tool_result')) return false;
  return content.some((block) => block?.type === 'text');
}

// 1 回の API 応答は content ブロック（thinking / text / tool_use …）ごとに別行で書かれ、
// 各行の message.usage には応答全体の usage がそのままコピーされる。行ごとに足すと
// ツールを並列に呼ぶ応答ほど何倍にも数えるので、(message.id, requestId) が同じ行は
// 最初の 1 行だけ加算する（ccusage などと同じ名寄せ）。message.id の無い古い形式は null。
function usageKeyOf(record) {
  const id = record.message?.id;
  if (typeof id !== 'string' || !id) return null;
  return `${id}\t${typeof record.requestId === 'string' ? record.requestId : ''}`;
}

// [startMs, endMs) の稼働を跨ぐ 10 分枠に按分して足す（40 分のツール実行を 1 枠に積まない・日付境界をまたぐ）
// field で足す先の要素を選べる（自動ツール時間も同じ按分で持つ）。scale を掛けて足す（負なら引く）
export function addBusy(slots, startMs, endMs, field = SLOT_BUSY, scale = 1) {
  for (let index = Math.floor(startMs / SLOT_MS); index * SLOT_MS < endMs; index++) {
    const from = Math.max(startMs, index * SLOT_MS);
    const to = Math.min(endMs, (index + 1) * SLOT_MS);
    if (to > from) slotCellAt(slots, index)[field] += (to - from) * scale;
  }
}

export function emptyBusyState() {
  // request: 進行中の API 応答 {key, startMs, lastMs}。tools: 未解決の tool_use id → [時刻, 名前, 応答のキー]
  // requests: ツールの補正に使う応答ごとの情報 キー → {endMs（確定した最後の行の時刻。未確定なら null）,
  //   lastResultMs（その応答のツールの結果の行の最新時刻）}。参照するツールが無くなったら消す
  // held: 応答の終わりが確定するまで保留したツールの [応答のキー, 呼び出し時刻, 結果時刻, 名前, 種類, 直前の結果時刻]
  // seq: キーの無い応答（requestId も message.id も無い古い形式）に振る連番
  // lastUserMs / lastAssistantMs: 直前の非 assistant（user・tool_result）/ assistant レコードの時刻
  // approved: 人の許可ツールの [tool_use 時刻, tool_result 時刻]。走査時は数えず、集計時に cost-state の
  // 実測から実行時間を配分する（allocateApprovedTools）
  // autoTools: 縮める対象のツール（config・未検証で durationMs の無いもの）の [開始, 結果時刻, 未検証なら 1]。
  // 走査時は全体を数え、集計時に cost-state の実測に合わせて縮める（adjustAutoTools）
  return {
    request: null,
    tools: {},
    requests: {},
    held: [],
    seq: 0,
    lastUserMs: null,
    lastAssistantMs: null,
    approved: [],
    autoTools: [],
  };
}

function toolResultText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

// tool_result 1 件のツール時間をどう数えるか: 'skip'（数えない）/ 'full'（全体）/ 'unverified'（全体を数え、
// 集計時に実測で縮める）。
// - permissionDecision（Claude Code v2.1.293＝2026-10-08 以降の記録）がある:
//   source が 'config'（設定・モード・auto モードの判定。人は関わらない）なら許可待ちを含まないので全体、
//   'user' で始まる（人が許可・拒否した。AskUserQuestion の回答も）なら待ちと実行を分けられないので数えない
// - 無い（主に 10/7 以前）: 人の拒否の定型文があれば数えない。それ以外は権限モードに関わらず未検証
//   （当時は auto モードでも git switch 145 秒のような人への確認待ちが多く、モードでは見分けられなかった）
// permissionDecision はレコード単位なので、1 レコードに複数の tool_result があれば全部に同じ判定を当てる
export function toolCountMode(record, block) {
  const source = record.permissionDecision?.source;
  if (typeof source === 'string') {
    if (source === 'config') return 'full';
    if (source.startsWith('user')) return 'skip';
  }
  if (toolResultText(block).includes(USER_REJECT_TEXT)) return 'skip';
  return 'unverified';
}

// user / assistant レコード 1 件を稼働時間に反映する。状態はキャッシュのエントリに持ち、
// 差分走査がどこで切れても一度に読んだのと同じ結果になる。
// - 推論: requestId（無ければ message.id）ごとに 1 回。1 回の応答は content ブロックごとに別行で書かれるので、
//   開始＝最初の行の直前の非 assistant レコードの時刻（直前が別の応答の assistant ならその時刻を下限）、
//   終了＝同じ応答の最後の行の時刻。最後の行は次の行が来るまで分からないので、行が来るたびに
//   伸びた分だけ足す（按分の結果は [開始, 開始 + min(終了 - 開始, 上限)) を一度に足すのと同じ）。
//   生成の途中で実行された（Read など）ツールの結果の行が同じ応答の行の間に挟まっても、応答は切らない。
//   応答が確定するのは、別の応答の行か、tool_result を含まない user レコード（人の指示・中断・注入など）が来たとき
// - ツール実行: tool_use ごとに 1 回。終了＝tool_result の user レコードの時刻。開始は推論との二重計上と
//   順番待ちを除くよう補正する（補正は応答の最後の行が確定するまで保留し、held に持つ）:
//   - 結果がその応答の最後の行より前に来た（生成中に実行された）なら、呼び出しの行
//   - そうでなければ max(呼び出しの行, 応答の最後の行)（生成が終わってから実行された）
//   - Edit / MultiEdit / Write / NotebookEdit は順に実行されるので、さらに同じ応答の直前の結果の行以降
//   - 開始が結果より後になれば 0
//   toolUseResult.durationMs が数値ならそちらを優先する（実測なので上限・補正はかけず、すぐ足す）。
//   除外・未検証の扱いは toolCountMode() の判定（許可判定の記録）に従う
// system:turn_duration の durationMs は AskUserQuestion の回答待ちを含むので使わない
// stats を渡すと検算用に、600 秒を超えて数えた分（uncappedMs＝config / uncappedUnverifiedMs＝未検証）と
// user_* で除外した分（userSkippedMs）を足し、stats.onTool があれば補正後のツールごとに (名前, 開始, 終了) で呼ぶ
export function accumulateBusy(record, state, slots, stats) {
  const ms = Date.parse(record.timestamp);
  if (Number.isNaN(ms)) return;
  const content = Array.isArray(record.message?.content) ? record.message.content : [];

  if (record.type === 'assistant') {
    const key = record.requestId || record.message?.id || null;
    let request = state.request;
    if (!request || !key || request.key !== key) {
      finishRequest(state, slots, stats);
      const prev = Math.max(state.lastUserMs ?? -Infinity, state.lastAssistantMs ?? -Infinity);
      const start = Number.isFinite(prev) ? Math.min(prev, ms) : ms;
      request = { key: key || `#${state.seq++}`, startMs: start, lastMs: start };
      state.request = request;
      // 注入などで一度確定した応答の続きが来たら、終わりを未確定に戻す（古い終わりを使い回さない）
      if (state.requests[request.key]) state.requests[request.key].endMs = null;
    }
    // 伸びた分のうち上限（開始から MAX_CALL_MS）までを足す
    const capEnd = request.startMs + MAX_CALL_MS;
    const from = Math.min(request.lastMs, capEnd);
    const to = Math.min(ms, capEnd);
    if (to > from) addBusy(slots, from, to);
    request.lastMs = Math.max(request.lastMs, ms);
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      state.tools[block.id] = [ms, block.name || '', request.key];
      state.requests[request.key] ||= { endMs: null, lastResultMs: null };
    }
    const ids = Object.keys(state.tools);
    if (ids.length > MAX_PENDING_TOOLS) {
      for (const id of ids.slice(0, ids.length - MAX_PENDING_TOOLS)) delete state.tools[id];
      pruneRequests(state);
    }
    state.lastAssistantMs = ms;
    return;
  }

  if (record.type !== 'user') return;
  state.lastUserMs = ms;
  const results = content.filter((block) => block?.type === 'tool_result');
  // tool_result を含まない user（人の指示・中断・注入）が来たら進行中の応答は確定（以後は伸ばさない）
  if (results.length === 0) {
    finishRequest(state, slots, stats);
    state.request = null;
    return;
  }
  // toolUseResult はレコード単位なので、結果が 1 件のときだけそのツールの実行時間として使う
  const reported = record.toolUseResult?.durationMs;
  for (const block of results) {
    const pending = state.tools[block.tool_use_id];
    if (!pending) continue;
    delete state.tools[block.tool_use_id];
    const [usedAt, name, key] = pending;
    const info = state.requests[key];
    // 順に実行されるツール用に、同じ応答で自分より前に書かれた最新の結果の時刻を覚えてから更新する
    const prevResultMs = info?.lastResultMs ?? null;
    if (info) info.lastResultMs = ms;
    if (WAIT_TOOLS.has(name)) continue;
    const countMode = toolCountMode(record, block);
    const hasReported = results.length === 1 && typeof reported === 'number' && reported >= 0;
    let kind = countMode;
    if (countMode === 'skip') {
      const decision = record.permissionDecision;
      if (String(decision?.source).startsWith('user') && decision.decision === 'accept') {
        // 人の許可ツール。待ちと実行を分けられないので稼働には数えず、補正後の区間と回数だけ残す
        slotCellAt(slots, Math.floor(ms / SLOT_MS))[SLOT_HUMAN_APPROVALS] += 1;
        kind = 'approved';
      }
      if (stats && String(decision?.source).startsWith('user') && ms - usedAt > 0) {
        stats.userSkippedMs += ms - usedAt;
      }
      if (kind === 'skip') continue;
    }
    if (hasReported && kind !== 'approved') {
      // durationMs（実測）は補正せず、検証済みとして扱う
      addToolTime(state, slots, stats, 'reported', name, ms - reported, ms);
      continue;
    }
    const held = [key, usedAt, ms, name, kind, prevResultMs];
    if (info && info.endMs !== null) settleTool(state, slots, stats, held, info.endMs);
    else state.held.push(held);
  }
  pruneRequests(state);
}

// 進行中の応答を確定し、保留していたそのツールの時間を足す
function finishRequest(state, slots, stats) {
  const request = state.request;
  if (!request) return;
  state.request = null;
  const info = state.requests[request.key];
  if (!info) return;
  info.endMs = request.lastMs;
  const rest = [];
  for (const held of state.held) {
    if (held[0] === request.key) settleTool(state, slots, stats, held, info.endMs);
    else rest.push(held);
  }
  state.held = rest;
  pruneRequests(state);
}

// 補正した開始時刻でツールの時間を足す
function settleTool(state, slots, stats, held, endMs) {
  const [, usedAt, resultAt, name, kind, prevResultMs] = held;
  let start = resultAt < endMs ? usedAt : Math.max(usedAt, endMs);
  if (SEQUENTIAL_TOOLS.has(name) && prevResultMs !== null) start = Math.max(start, prevResultMs);
  start = Math.min(start, resultAt);
  if (kind === 'approved') {
    state.approved.push([start, resultAt]);
    stats?.onTool?.(name, start, resultAt);
    return;
  }
  addToolTime(state, slots, stats, kind, name, start, resultAt);
}

function addToolTime(state, slots, stats, kind, name, start, end) {
  stats?.onTool?.(name, start, end);
  if (end <= start) return;
  if (stats && end - start > MAX_CALL_MS) {
    const key = kind === 'unverified' ? 'uncappedUnverifiedMs' : 'uncappedMs';
    stats[key] = (stats[key] || 0) + end - start - MAX_CALL_MS;
  }
  addBusy(slots, start, end);
  addBusy(slots, start, end, SLOT_AUTO_TOOL);
  if (kind === 'unverified' || kind === 'full') {
    addBusy(slots, start, end, SLOT_SHRINKABLE_TOOL);
    state.autoTools.push(kind === 'unverified' ? [start, end, 1] : [start, end, 0]);
  }
}

// 更新が止まったファイルの保留中のツールを、応答の最後の行の時刻で確定させて数える（確定させたものは held から消える）
export function settleStaleBusy(state, slots, stats) {
  if (!state || state.held.length === 0) return;
  finishRequest(state, slots, stats);
  for (const held of state.held) {
    const endMs = state.requests[held[0]]?.endMs ?? state.lastAssistantMs ?? held[2];
    settleTool(state, slots, stats, held, endMs);
  }
  state.held = [];
  pruneRequests(state);
}

// 参照するツール（未解決・保留中）も進行中の応答でもない応答の情報を消す
function pruneRequests(state) {
  const used = new Set(Object.values(state.tools).map((tool) => tool[2]));
  for (const held of state.held) used.add(held[0]);
  if (state.request) used.add(state.request.key);
  for (const key of Object.keys(state.requests)) if (!used.has(key)) delete state.requests[key];
}

// cost-state（Claude Code がプロセス終了時に書く実測。同じ startTime で何度も書かれるので最後の値）を拾う。
// totalToolDuration は許可待ちを含まないプロセス累計（サブエージェント分も含むらしい）。
// resume したプロセスは前のプロセスの cost-state（startTime と合計）を引き継いで書き直す。合計が増えていれば
// 累積なのでそのまま使うが、会話を挟んで合計が全く増えないまま書き直されることがある（後のプロセスの分が
// 入っていない）。その場合はウィンドウの終わりを「合計が最後に増えた書き込みの直前の会話レコードの時刻」で
// 打ち切り（totalDuration を鵜呑みにしない）、それより後は cost-state の無いプロセスとして扱う。
// cost-state には timestamp が無いので、直前の会話レコードの時刻（lastConvMs）でファイル内の位置を表す。
// 値は [totalToolDuration, totalDuration, 打ち切る時刻 | null, totalAPIDuration,
//   合計が最後に増えた書き込みの lastConvMs, 最後の書き込みの lastConvMs]
export function noteCostState(record, costStates, lastConvMs = null) {
  const { startTime, totalToolDuration, totalDuration, totalAPIDuration } = record;
  if (typeof startTime !== 'number' || typeof totalToolDuration !== 'number') return;
  const duration = typeof totalDuration === 'number' ? totalDuration : 0;
  const api = typeof totalAPIDuration === 'number' ? totalAPIDuration : 0;
  const prev = costStates[startTime];
  if (!prev || prev[0] !== totalToolDuration || (prev[3] ?? api) !== api) {
    costStates[startTime] = [totalToolDuration, duration, null, api, lastConvMs, lastConvMs];
    return;
  }
  // 合計が同じ書き直し。間に会話を挟んでいれば、後のプロセスの分が入っていないので打ち切る
  const conversed = lastConvMs !== null && typeof prev[5] === 'number' && lastConvMs > prev[5];
  const cut = conversed ? (prev[4] ?? null) : (prev[2] ?? null);
  costStates[startTime] = [totalToolDuration, cut === null ? duration : prev[1], cut, api, prev[4] ?? null, lastConvMs];
}

// cost-state のプロセスのウィンドウ。重なったら startTime が最大（最も内側・最新）の 1 つにだけ割り当てる（下の説明）
function costWindows(costStates) {
  const windows = Object.entries(costStates)
    .map(([key, [toolMs, durationMs, cutMs]]) => {
      const start = Number(key);
      const end = typeof cutMs === 'number' ? cutMs : start + durationMs;
      return { start, end, toolMs, auto: 0, tools: [] };
    })
    .sort((a, b) => b.start - a.start); // 内側（新しい）ウィンドウが先
  const ownerOf = (ms) => windows.find((w) => ms >= w.start && ms <= w.end);
  return { windows, ownerOf };
}

// 自動で数えたツール（config と未検証。durationMs の無いもの）を cost-state の実測に合わせて縮める。
// タイムスタンプ差には許可待ち（未検証）や auto モードの判定待ち（1 呼び出しあたり 1〜2 秒）が入るが、
// cost-state の totalToolDuration にも Datadog の tool_result の duration にも入らないので、それに揃える。
// 戻り値は稼働・自動ツール・縮める対象のツールの各列に足す差分（負の値）の枠。
// - プロセスのウィンドウごとに（重なりは最も内側の 1 つに割り当て）、本体 JSONL の対象ツールの区間の
//   和集合 U（並列呼び出しの重なりは 1 回。cost-state の totalToolDuration も重なりを 1 回しか数えないため）を
//   totalToolDuration と比べ、U が大きければ f = totalToolDuration / U を掛けた値に置き換える（縮めるだけで増やさない）。
//   呼び出しごとに合計する方針は保つ（並列の各呼び出しにそれぞれ f を掛ける）。
//   U に入れるのは本体のツールだけ。cost-state にはサブエージェント分も一部入るらしいが、その場合は f ≥ 1 に
//   なって縮めないだけなので構わない。サブエージェントのツールは cost-state との対応が取れないので縮めない
// - どのウィンドウにも入らない区間（cost-state の無いプロセス＝動作中・強制終了など。走査時にはどのプロセスか
//   分からないので集計時に判断する）は、config はそのまま（動作中のセッションは、終わって cost-state が書かれると縮む）、
//   未検証は許可待ちを含み得るので従来どおり 1 回 MAX_CALL_MS までにする（本体・サブエージェントとも）
// 区間は [開始, 結果時刻, 未検証なら 1 / config なら 0]（3 つ目が無ければ未検証として扱う）。
// stats を渡すと検算用の件数・時間を足す
export function adjustAutoTools({ main = [], sub = [], costStates, stats }) {
  const { windows, ownerOf } = costWindows(costStates);
  const delta = {};
  const shrink = (startMs, endMs, scale) => {
    for (const field of [SLOT_BUSY, SLOT_AUTO_TOOL, SLOT_SHRINKABLE_TOOL]) addBusy(delta, startMs, endMs, field, scale);
  };
  const isUnverified = (interval) => interval[2] !== 0;
  const outside = [];
  for (const interval of main) {
    const owner = ownerOf(interval[0]);
    if (owner) owner.tools.push(interval);
    else outside.push(interval);
  }
  for (const interval of sub) if (!ownerOf(interval[0])) outside.push(interval);
  for (const window of windows) {
    if (window.tools.length === 0) continue;
    const union = unionLength(window.tools);
    if (union <= window.toolMs) {
      if (stats) stats.keptProcesses += 1;
      continue;
    }
    const f = window.toolMs / union;
    let removed = 0;
    let unverifiedCalls = 0;
    for (const interval of window.tools) {
      const [usedAt, resultAt] = interval;
      if (isUnverified(interval)) unverifiedCalls += 1;
      if (resultAt <= usedAt) continue;
      shrink(usedAt, resultAt, -(1 - f));
      removed += (resultAt - usedAt) * (1 - f);
    }
    if (stats) {
      stats.shrunkProcesses += 1;
      stats.shrunkCalls += window.tools.length;
      stats.shrunkMs += removed;
      stats.factors.push(f);
      stats.windows?.push({ start: window.start, f, calls: window.tools.length, unverifiedCalls, removedMs: removed });
    }
  }
  for (const interval of outside) {
    if (!isUnverified(interval)) continue;
    const [usedAt, resultAt] = interval;
    if (stats) stats.outsideCalls += 1;
    if (resultAt - usedAt <= MAX_CALL_MS) continue;
    // 足したのは [開始, 結果]。上限版は [結果 − 上限, 結果] なので、その前の部分を引く
    shrink(usedAt, resultAt - MAX_CALL_MS, -1);
    if (stats) {
      stats.cappedCalls += 1;
      stats.cappedMs += resultAt - usedAt - MAX_CALL_MS;
    }
  }
  return delta;
}

// 区間の和集合の長さ（重なりは 1 回）
function unionLength(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [a, b] of sorted) {
    if (curEnd === null || a > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

// 人の許可ツールに cost-state の実測から実行時間を配る。プロセス（[startTime, startTime + totalDuration]）ごとに、
// R = max(0, totalToolDuration − そのプロセスの自動ツール時間) を、そのプロセスの人の許可ツールへ
// 間隔（結果 − 呼び出し）の比で、1 件あたり自分の間隔を超えないよう配り、[結果 − 配分, 結果] として
// 稼働に足す（実行は許可の後＝結果の直前に起きる）。自動ツール時間は枠の粒度で数えるので端は粗い。
// cost-state の totalToolDuration は並列に呼んだツールの重なりを 1 回しか数えないのに対し、自動ツール時間は
// Datadog に揃えて呼び出しごとに足しているので、並列呼び出しのあるプロセスでは A が大きく出て R が 0 に潰れることがある。
// cost-state のまだ無いプロセス（動作中・異常終了）の分は配らない（書かれたら次の集計で反映される）。
// 同じ JSONL に 2 つのプロセスが書く（起動中のセッションを resume して claude が 2 本立った等）とウィンドウが重なる。
// 許可ツールも自動ツールの枠も、含まれるウィンドウのうち startTime が最大（最も内側・最新）の 1 つにだけ割り当てる。
// 許可ツールを両方に入れると二重に配分され、外側のプロセスの totalToolDuration には内側のプロセスの分が
// 入っていないので、外側の差し引き（A）に内側の自動ツールを入れると外側の R が過小になるため。
// autoToolBySlot は枠番号 → 自動ツール ms。戻り値は配分を足した枠（slots と同じ形）
export function allocateApprovedTools({ approved, costStates, autoToolBySlot }) {
  const { windows, ownerOf } = costWindows(costStates);
  for (const tool of approved) ownerOf(tool[0])?.tools.push(tool);
  if (!windows.some((w) => w.tools.length > 0)) return {};
  for (const [index, ms] of autoToolBySlot) {
    // 枠の粒度: 枠がウィンドウの端の枠に掛かっていれば含める
    const owner = windows.find((w) => index >= Math.floor(w.start / SLOT_MS) && index <= Math.floor(w.end / SLOT_MS));
    if (owner) owner.auto += ms;
  }
  const slots = {};
  for (const window of windows) {
    if (window.tools.length === 0) continue;
    const rest = Math.max(0, window.toolMs - window.auto);
    const intervals = window.tools.map(([usedAt, resultAt]) => Math.max(0, resultAt - usedAt));
    const sum = intervals.reduce((a, b) => a + b, 0);
    if (rest <= 0 || sum <= 0) continue;
    const ratio = Math.min(1, rest / sum);
    window.tools.forEach(([, resultAt], i) => {
      const share = intervals[i] * ratio;
      if (share > 0) addBusy(slots, resultAt - share, resultAt);
    });
  }
  return slots;
}

// 1 行を日別集計と 10 分枠の集計に足す
function accumulateLine(line, entry, dateKeyOf) {
  const { daily, slots } = entry;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const type = record.type;
  if (type === 'cost-state') noteCostState(record, entry.costStates, entry.lastConvMs ?? null);
  if (type !== 'user' && type !== 'assistant') return;
  const convMs = Date.parse(record.timestamp);
  if (!Number.isNaN(convMs)) entry.lastConvMs = Math.max(entry.lastConvMs ?? convMs, convMs);
  // tool_result もツール実行の終端になるので、isUserPrompt で落とす前に処理する
  accumulateBusy(record, entry.busy, slots);
  if (type === 'user' && !isUserPrompt(record)) return;

  const date = dateKeyOf(record.timestamp);
  if (!date) return;

  let cell = daily[date];
  if (!cell) {
    cell = emptyCell();
    daily[date] = cell;
  }
  const slot = slotCellOf(slots, record.timestamp);
  if (type === 'user') {
    cell[PROMPTS] += 1;
    if (slot) slot[SLOT_PROMPTS] += 1;
    // カレンダーの点は「人が指示した時刻」だけにする（タスク通知などの注入は除き、
    // スラッシュコマンドは含める。ターン詳細の区切りと同じ判定）
    const ms = Date.parse(record.timestamp);
    if (!Number.isNaN(ms) && turnPrompt(record)) entry.prompts.push(Math.floor(ms / MINUTE_MS));
    return;
  }
  cell[REPLIES] += 1;
  if (slot) {
    slot[SLOT_REPLIES] += 1;
    countTools(record.message?.content, slot);
  }
  const usage = record.message?.usage;
  if (!usage) return;
  // 同じ応答の行は連続して書かれる（間に挟まるのは tool_result などの非 assistant 行）ので、
  // 直前に加算したキーを覚えておけば足りる。キーが無い行は従来どおり毎回足す
  const usageKey = usageKeyOf(record);
  if (usageKey && usageKey === entry.lastUsageKey) return;
  entry.lastUsageKey = usageKey;
  cell[INPUT] += usage.input_tokens || 0;
  cell[OUTPUT] += usage.output_tokens || 0;
  cell[CACHE_CREATE] += usage.cache_creation_input_tokens || 0;
  cell[CACHE_READ] += usage.cache_read_input_tokens || 0;
}

// offset 以降を読み、完全な行だけを集計する。
// 戻り値は「取り込み済みバイト数」＝次回の開始位置（書きかけの末尾行は含めない）。
async function scanFrom(path, offset, entry, dateKeyOf) {
  let consumed = offset;
  let buffer = '';
  const stream = createReadStream(path, { start: offset, encoding: 'utf-8' });
  for await (const chunk of stream) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      consumed += Buffer.byteLength(line, 'utf-8') + 1;
      if (line.trim()) accumulateLine(line, entry, dateKeyOf);
    }
  }
  return consumed;
}

function loadCache(cacheFile) {
  try {
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (cache?.version === CACHE_VERSION && cache.files && typeof cache.files === 'object') return cache;
  } catch {
    // 壊れていたら作り直す（集計は再走査すれば復元できる）
  }
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(cacheFile, cache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, cacheFile);
  } catch {
    // キャッシュは無くても動く（次回また走査するだけ）ので握りつぶす
  }
}

// 直近 days 日分の空セルを日付順に用意する（活動のない日も草の升目として出す）
function buildDateRange(days, now) {
  const dates = [];
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDateKey(new Date(end.getTime() - i * DAY_MS)));
  }
  return dates;
}

// activeMs は AI 稼働時間（推論＋ツール実行の ms。dailyActiveMs）。キャッシュの日別セルとは別に集計時に出す
function toDay(date, cell, activeMs = 0) {
  const [prompts, replies, input, output, cacheCreation, cacheRead] = cell;
  return {
    date,
    prompts,
    replies,
    messages: prompts + replies,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    tokens: input + output + cacheCreation + cacheRead,
    activeMs,
  };
}

// 同じ走査を並行に走らせない（ホームのリロードで二重に読み直さないため）
let inflight = null;

// ファイル単位のキャッシュを更新し、日付 -> セルの全体集計を返す
async function refreshDaily({ dir, cacheFile, now = Date.now() }) {
  const cache = loadCache(cacheFile);
  const files = collectJsonlFiles(dir);
  const dateKeyOf = makeDateKeyResolver();
  const nextFiles = {};
  let scannedFiles = 0;

  for (const file of files) {
    const cached = cache.files[file.path];
    // 追記のみ前提。縮んでいたら別物（ローテート等）なので先頭から読み直す
    const reusable = cached && typeof cached.offset === 'number' && cached.offset <= file.size;
    const entry = reusable
      ? {
          offset: cached.offset,
          daily: { ...cached.daily },
          slots: { ...cached.slots },
          prompts: [...(cached.prompts || [])],
          // 差分走査の切れ目が同じ応答の途中に来ても二重に足さないよう引き継ぐ
          lastUsageKey: cached.lastUsageKey ?? null,
          // 稼働時間も、進行中の応答・未解決の tool_use・直前の時刻を引き継いで続きから数える
          busy: cached.busy
            ? {
                ...emptyBusyState(),
                ...cached.busy,
                tools: { ...(cached.busy.tools || {}) },
                requests: Object.fromEntries(
                  Object.entries(cached.busy.requests || {}).map(([key, info]) => [key, { ...info }]),
                ),
                held: (cached.busy.held || []).map((held) => [...held]),
                approved: [...(cached.busy.approved || [])],
                autoTools: [...(cached.busy.autoTools || [])],
              }
            : emptyBusyState(),
          costStates: Object.fromEntries(
            Object.entries(cached.costStates || {}).map(([key, value]) => [key, [...value]]),
          ),
          lastConvMs: cached.lastConvMs ?? null,
        }
      : {
          offset: 0,
          daily: {},
          slots: {},
          prompts: [],
          lastUsageKey: null,
          busy: emptyBusyState(),
          costStates: {},
          lastConvMs: null,
        };

    if (entry.offset < file.size) {
      try {
        entry.offset = await scanFrom(file.path, entry.offset, entry, dateKeyOf);
        scannedFiles++;
      } catch {
        // 読めないファイルはこのラウンドでは諦める（次回また試す）
      }
    }
    // 更新が止まったファイルの保留中のツールを確定させる（追記が来ても held から消えているので二重にならない）
    if (entry.busy.held.length > 0 && now - file.mtimeMs >= STALE_FILE_MS) settleStaleBusy(entry.busy, entry.slots);
    nextFiles[file.path] = entry;
  }

  cache.files = nextFiles; // 消えたファイルはキャッシュからも落とす
  saveCache(cacheFile, cache);

  const totals = {};
  for (const entry of Object.values(nextFiles)) {
    for (const [date, cell] of Object.entries(entry.daily)) {
      let target = totals[date];
      if (!target) {
        target = emptyCell();
        totals[date] = target;
      }
      for (let i = 0; i < CELL_SIZE; i++) target[i] += cell[i];
    }
  }
  return { totals, files: nextFiles, scannedFiles, fileCount: files.length };
}

// 走査は重いので、同時に来た要求は 1 回の走査を共有する
function sharedRefresh({ dir, cacheFile }) {
  if (!inflight) {
    inflight = refreshDaily({ dir, cacheFile }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// ホーム画面のヒートマップ用。直近 days 日の日別集計を返す。activeMs（AI 稼働時間）は週間カレンダーと同じ
// セッション単位の縮小・配分（sessionBusyCorrections）を通した値で、カレンダーの日別合計と一致する。
export async function getActivityHeatmap({
  days = 365,
  dir = CLAUDE_PROJECTS_DIR,
  cacheFile = CACHE_FILE,
  now = Date.now(),
} = {}) {
  const { totals, files, scannedFiles, fileCount } = await sharedRefresh({ dir, cacheFile });
  const active = dailyActiveMs(dir, files);

  const range = buildDateRange(days, now);
  const cells = range.map((date) => toDay(date, totals[date] || emptyCell(), active[date] || 0));
  const total = cells.reduce(
    (acc, day) => {
      acc.prompts += day.prompts;
      acc.replies += day.replies;
      acc.messages += day.messages;
      acc.tokens += day.tokens;
      acc.inputTokens += day.inputTokens;
      acc.outputTokens += day.outputTokens;
      acc.cacheCreationTokens += day.cacheCreationTokens;
      acc.cacheReadTokens += day.cacheReadTokens;
      acc.activeMs += day.activeMs;
      if (day.messages > 0) acc.activeDays += 1;
      return acc;
    },
    {
      prompts: 0,
      replies: 0,
      messages: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      activeMs: 0,
      activeDays: 0,
    },
  );

  return { days: cells, total, generatedAt: new Date(now).toISOString(), scannedFiles, fileCount };
}

// JSONL のパスからセッション ID を取る。
// <projectDir>/<sessionId>.jsonl か、サブエージェントの
// <projectDir>/<sessionId>/subagents/agent-*.jsonl（活動は親セッションに帰属させる）。
function sessionIdFromPath(dir, path) {
  const parts = relative(dir, path).split(sep);
  if (parts.length < 2) return null;
  const second = parts[1];
  return second.endsWith('.jsonl') ? second.slice(0, -'.jsonl'.length) : second;
}

// 期間（ローカル日付 YYYY-MM-DD の from〜to）に活動があったセッション ID の集合。
// ホームの「直近のセッション」を活動グラフの棒でクリック絞り込みするためのデータ源。
// JSONL の mtime ではなくこの日別集計を使うのは、mtime は「最後に更新した日」でしかなく、
// その日に活動して後日また続けたセッションが期間から漏れるため。棒グラフと同じ集計で
// 絞れば「その棒に数えられたセッション」と一覧が一致する。
export async function listActiveSessionIds({ from, to, dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE } = {}) {
  const { files } = await sharedRefresh({ dir, cacheFile });
  const ids = new Set();
  for (const [path, entry] of Object.entries(files)) {
    const sessionId = sessionIdFromPath(dir, path);
    if (!sessionId || ids.has(sessionId)) continue;
    for (const [date, cell] of Object.entries(entry.daily)) {
      // 日付キーは固定長の YYYY-MM-DD なので文字列比較で範囲判定できる
      if (date < from || date > to) continue;
      if (cell[PROMPTS] + cell[REPLIES] > 0) {
        ids.add(sessionId);
        break;
      }
    }
  }
  return ids;
}

// キャッシュのファイル単位の集計をセッションごとにまとめる（サブエージェントの JSONL は親セッションへ）。
// 自動ツールの縮小と人の許可ツールへの配分は、同じセッションの本体・サブエージェントと cost-state を
// 合わせて見る必要があるため、この単位で行う（sessionBusyCorrections）
function groupFilesBySession(dir, files) {
  const groups = new Map();
  for (const [path, entry] of Object.entries(files)) {
    const sessionId = sessionIdFromPath(dir, path);
    if (!sessionId) continue;
    const parts = relative(dir, path).split(sep);
    let group = groups.get(sessionId);
    if (!group) {
      group = {
        sessionId,
        projectDir: parts[0],
        entries: [],
        mainEntries: [],
        approved: [],
        autoMain: [],
        autoSub: [],
        costStates: {},
      };
      groups.set(sessionId, group);
    }
    group.entries.push(entry);
    if (parts.length === 2) group.mainEntries.push(entry);
    group.approved.push(...(entry.busy?.approved || []));
    (parts.length === 2 ? group.autoMain : group.autoSub).push(...(entry.busy?.autoTools || []));
    Object.assign(group.costStates, entry.costStates || {});
  }
  return groups;
}

// セッション 1 つ分の AI 稼働の補正。走査時の枠（entries の slots）に足す差分を返す。
// delta: 自動ツールを cost-state の実測に合わせて縮める差分（adjustAutoTools。稼働・自動ツール・縮める対象の列が負）
// allocated: 人の許可ツールに実測から配った時間（allocateApprovedTools。稼働の列だけ）
// 週間カレンダーとヒートマップの日別稼働時間の両方がこれを使うので、2 つの数字は一致する。
export function sessionBusyCorrections(group) {
  const hasAuto = group.autoMain.length + group.autoSub.length > 0;
  const delta = hasAuto
    ? adjustAutoTools({ main: group.autoMain, sub: group.autoSub, costStates: group.costStates })
    : {};
  if (group.approved.length === 0 || Object.keys(group.costStates).length === 0) return { delta, allocated: {} };
  // 人の許可ツールの差し引き（A）には縮めた後の自動ツール時間を使う。縮める前の値は判定待ち・許可待ちを含む
  // 推定で、実測（totalToolDuration）と比べる相手としては縮めた後の方が実測に近いため
  const autoToolBySlot = new Map();
  const addAuto = (key, ms) => {
    if (ms) autoToolBySlot.set(Number(key), (autoToolBySlot.get(Number(key)) || 0) + ms);
  };
  for (const entry of group.entries) {
    for (const [key, cell] of Object.entries(entry.slots || {})) addAuto(key, cell[SLOT_AUTO_TOOL] || 0);
  }
  for (const [key, cell] of Object.entries(delta)) addAuto(key, cell[SLOT_AUTO_TOOL]);
  const allocated = allocateApprovedTools({ approved: group.approved, costStates: group.costStates, autoToolBySlot });
  return { delta, allocated };
}

// セッションごとの最終的な AI 稼働（枠番号 → ms）。走査時の枠＋縮小＋配分を足し、カレンダーと同じく
// セッション × 枠の単位で ms に丸めて負を 0 にする（日別に足す前に丸めるのでカレンダーの日別合計と一致する）
function sessionBusyBySlot(group) {
  const busy = new Map();
  const add = (key, ms) => {
    if (ms) busy.set(Number(key), (busy.get(Number(key)) || 0) + ms);
  };
  for (const entry of group.entries) {
    for (const [key, cell] of Object.entries(entry.slots || {})) add(key, cell[SLOT_BUSY]);
  }
  const { delta, allocated } = sessionBusyCorrections(group);
  for (const [key, cell] of Object.entries(delta)) add(key, cell[SLOT_BUSY]);
  for (const [key, cell] of Object.entries(allocated)) add(key, cell[SLOT_BUSY]);
  for (const [index, ms] of busy) busy.set(index, Math.max(0, Math.round(ms)));
  return busy;
}

// 日別（ローカル日付）の AI 稼働 ms。枠はその開始時刻の日に入れる（カレンダーの dailyBusyMs と同じ切り方）
export function dailyActiveMs(dir, files) {
  // 枠番号 → 日付。複数のセッションが同じ枠を持つので使い回す（30 分ずれのタイムゾーンもあるので枠単位で引く）
  const dateKeyOfSlot = new Map();
  const totals = {};
  for (const group of groupFilesBySession(dir, files).values()) {
    for (const [index, ms] of sessionBusyBySlot(group)) {
      if (ms <= 0) continue;
      let date = dateKeyOfSlot.get(index);
      if (date === undefined) {
        date = localDateKey(new Date(index * SLOT_MS));
        dateKeyOfSlot.set(index, date);
      }
      totals[date] = (totals[date] || 0) + ms;
    }
  }
  return totals;
}

// 週間カレンダー用。[fromMs, toMs) に活動があったセッションごとに、10 分枠の集計を返す。
// slots は [枠番号, 発言, 応答, 調査系ツール, 編集系ツール, AI 稼働 ms, 自動ツール ms, 人の許可回数,
// 縮める対象のツール ms] の配列（枠番号の昇順）。AI 稼働・自動ツール・縮める対象のツールは cost-state の実測に
// 合わせて縮めた後の値（adjustAutoTools）。
// AI 稼働には、人の許可ツールに cost-state の実測から配分した時間も足してある（allocateApprovedTools）。
// AI 稼働は呼び出しごとの推定時間を跨ぐ枠に按分した値で、レコードの無い枠（長いツール実行の途中）にも
// 乗るので、発言・応答が 0 で稼働だけの枠もある（帯の組み立てではその枠を無視する）。
// サブエージェントの稼働も他の要素と同じく親に足す（Datadog の AI 稼働時間と同じく呼び出しごとに合算）。
// prompts は人が指示した時刻の [分番号（エポックからの分）, その分の指示数] の配列（昇順）。
// サブエージェントの JSONL の「指示」は親が渡したタスクで人の発言ではないので、prompts は本体からだけ取る。
// サブエージェントの活動は親セッションの枠に足す（その間も親は作業中なので帯をつなげる）。
// タイトルと cwd は本体 JSONL の先頭だけ読んで取る（summary 全体は Artifact の全文走査を伴うので使わない）。
export async function getActivityCalendar({ fromMs, toMs, dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE } = {}) {
  const { files } = await sharedRefresh({ dir, cacheFile });
  const fromSlot = Math.floor(fromMs / SLOT_MS);
  const toSlot = Math.ceil(toMs / SLOT_MS);
  const bySession = new Map();
  const groups = groupFilesBySession(dir, files);

  for (const group of groups.values()) {
    const sessionOf = () => {
      let session = bySession.get(group.sessionId);
      if (!session) {
        session = { sessionId: group.sessionId, projectDir: group.projectDir, slots: new Map(), prompts: new Map() };
        bySession.set(group.sessionId, session);
      }
      return session;
    };
    group.sessionOf = sessionOf;
    for (const entry of group.entries) {
      for (const [key, cell] of Object.entries(entry.slots || {})) {
        const index = Number(key);
        if (index < fromSlot || index >= toSlot) continue;
        const session = sessionOf();
        const target = session.slots.get(index);
        if (target) for (let i = 0; i < SLOT_SIZE; i++) target[i] += cell[i];
        else session.slots.set(index, [...cell]);
      }
    }
    for (const entry of group.mainEntries) {
      for (const minute of entry.prompts || []) {
        const ms = minute * MINUTE_MS;
        if (ms < fromMs || ms >= toMs) continue;
        const session = sessionOf();
        session.prompts.set(minute, (session.prompts.get(minute) || 0) + 1);
      }
    }
  }

  // 自動ツールの縮小と、人の許可ツールへの実測の配分。期間の外の呼び出し・自動ツールも同じプロセスの
  // ウィンドウ内なら計算に入れ（週の境目で値が変わらないように）、返すのは期間内の枠だけ。
  // 期間内に活動の無いセッションも縮小は計算する（配分の差し引きに縮めた後の自動ツール時間を使うので、
  // 省くと期間の端に掛かる配分がヒートマップの日別稼働時間とずれる）
  for (const group of groups.values()) {
    const { delta, allocated } = sessionBusyCorrections(group);
    for (const [key, cell] of Object.entries(delta)) {
      const index = Number(key);
      if (index < fromSlot || index >= toSlot) continue;
      const target = group.sessionOf().slots.get(index);
      if (target) for (let i = 0; i < SLOT_SIZE; i++) target[i] += cell[i];
    }
    for (const [key, cell] of Object.entries(allocated)) {
      const index = Number(key);
      if (index < fromSlot || index >= toSlot) continue;
      const session = group.sessionOf();
      const target = session.slots.get(index);
      if (target) target[SLOT_BUSY] += cell[SLOT_BUSY];
      else session.slots.set(index, [...cell]);
    }
  }

  const sessions = await Promise.all(
    [...bySession.values()].map(async (session) => {
      // 本体が消えていてもサブエージェント側の活動は出す（タイトル無し）
      const mainPath = join(dir, session.projectDir, `${session.sessionId}.jsonl`);
      const head = existsSync(mainPath) ? summarizeHead(await readFirstLines(mainPath, 40)) : { title: '', cwd: '' };
      return {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        cwd: head.cwd || '',
        title: head.title || '',
        // 縮小・配分で小数になるので ms に丸める（回数の列はもともと整数）
        slots: [...session.slots.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, cell]) => [index, ...cell.map((value) => Math.max(0, Math.round(value)))]),
        prompts: [...session.prompts.entries()].sort((a, b) => a[0] - b[0]),
      };
    }),
  );
  return { fromMs, toMs, slotMs: SLOT_MS, minuteMs: MINUTE_MS, sessions };
}

// 起動直後に裏で 1 回だけ走査してキャッシュを温める（初回にホームを開いたときの全走査の待ちを無くす）。
// 走査中に来た要求は同じ走査を共有する（sharedRefresh）
export function warmActivityCache({ dir = CLAUDE_PROJECTS_DIR, cacheFile = CACHE_FILE } = {}) {
  return sharedRefresh({ dir, cacheFile }).then(({ fileCount, scannedFiles }) => ({ fileCount, scannedFiles }));
}

// テスト用（モジュールキャッシュをまたいだ状態を残さない）
export function resetActivityHeatmapState() {
  inflight = null;
}
