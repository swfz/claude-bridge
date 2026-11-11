// 再起動（ブリッジ / PC・WSL）の後に「開いていたもの」を再現するための保存と突き合わせ。
//
// 保存先は <dataDir>/open-tabs.json で、中身は { tabs, panes, pending }。
// - tabs:    ブリッジで開いているタブ（tmux / readonly）。ブリッジ ID も持ち、復元時に同じ ID で開き直す
//            （activeSessionId・historyBoundary:<id>・threads-<id>.json がブリッジ ID に紐づいているため）
// - panes:   tmux 上で動いている claude のスナップショット（ブリッジのタブにしていないものも含む）。
//            tmux セッション名・window 名・window 番号を持ち、作り直すときに同じ場所へ置く
// - pending: 起動時に「動いていない」と分かったもの（PC/WSL 再起動で tmux ごと消えた等）。
//            ホームの「まとめて tmux で再開」か「破棄」でしか消さない（直後の再起動で失わないため）
//
// 突き合わせのキーは claudeSessionId だけ。paneId（%N）は tmux サーバーを立て直すと振り直されるので使わない。
// 内蔵 PTY のタブは session.js の sessions.json（pastSessions）が扱うのでここでは持たない。
import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './storage.js';
import { cwdToProjectDir } from './jsonl-utils.js';
import { isValidProjectDir } from './resume-cwd.js';

export const OPEN_TABS_FILE = join(DATA_DIR, 'open-tabs.json');

const ID_RE = /^[\w-]{1,64}$/;
// tmux セッション名は target 記法（`:` `.`）と衝突しないものだけ。合わなければ再開先は既定の選び方に任せる
const TMUX_SESSION_RE = /^[\w.-]{1,64}$/;
const MAX_ENTRIES = 100;
// スナップショットから消すまでの「見えなかった回数」。終了処理中に claude が先に落ちて
// スナップショットが空になるのを避けるため、1 回見えないだけでは消さない
export const MISSING_LIMIT = 2;

function str(v, max = 1000) {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function projectDirOf(e, cwd) {
  if (typeof e.projectDir === 'string' && isValidProjectDir(e.projectDir)) return e.projectDir;
  return cwd ? cwdToProjectDir(cwd) : null;
}

function sanitizeTab(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.type !== 'tmux' && e.type !== 'readonly') return null;
  if (!ID_RE.test(e.claudeSessionId || '')) return null;
  const cwd = str(e.cwd);
  return {
    type: e.type,
    id: ID_RE.test(e.id || '') ? e.id : null,
    name: str(e.name, 300),
    cwd,
    projectDir: projectDirOf(e, cwd),
    claudeSessionId: e.claudeSessionId,
  };
}

function sanitizeLocation(e) {
  return {
    tmuxSession: TMUX_SESSION_RE.test(e.tmuxSession || '') ? e.tmuxSession : null,
    windowName: str(e.windowName, 64),
    windowIndex: Number.isInteger(e.windowIndex) && e.windowIndex >= 0 ? e.windowIndex : null,
  };
}

function sanitizePane(e) {
  if (!e || typeof e !== 'object' || !ID_RE.test(e.claudeSessionId || '')) return null;
  const cwd = str(e.cwd);
  return {
    claudeSessionId: e.claudeSessionId,
    cwd,
    projectDir: projectDirOf(e, cwd),
    ...sanitizeLocation(e),
    missing: Number.isInteger(e.missing) && e.missing > 0 ? e.missing : 0,
  };
}

function sanitizePending(e) {
  if (!e || typeof e !== 'object' || !ID_RE.test(e.claudeSessionId || '')) return null;
  const cwd = str(e.cwd);
  const tab =
    e.tab && typeof e.tab === 'object'
      ? { id: ID_RE.test(e.tab.id || '') ? e.tab.id : null, name: str(e.tab.name, 300) }
      : null;
  return {
    claudeSessionId: e.claudeSessionId,
    name: str(e.name, 300),
    cwd,
    projectDir: projectDirOf(e, cwd),
    ...sanitizeLocation(e),
    tab,
  };
}

function sanitizeList(list, fn) {
  if (!Array.isArray(list)) return [];
  return list.map(fn).filter(Boolean).slice(0, MAX_ENTRIES);
}

export function sanitizeOpenTabs(data) {
  return {
    tabs: sanitizeList(data?.tabs, sanitizeTab),
    panes: sanitizeList(data?.panes, sanitizePane),
    pending: sanitizeList(data?.pending, sanitizePending),
  };
}

export function loadOpenTabs(file = OPEN_TABS_FILE) {
  try {
    return sanitizeOpenTabs(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return { tabs: [], panes: [], pending: [] };
  }
}

// PC が落ちる場面こそ対象なので、書きかけで壊れないよう tmp + rename で置き換える
export function saveOpenTabs(state, file = OPEN_TABS_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

// allSessions() の結果（watcher の meta 込み）から保存するタブを作る。
// claudeSessionId が未解決の tmux タブは突き合わせようがないので保存しない
export function tabsFromSessions(sessions) {
  return sanitizeList(
    sessions
      .filter((s) => s.alive !== false && (s.type === 'tmux' || s.type === 'readonly'))
      .map((s) => ({
        type: s.type,
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        projectDir: s.projectDir,
        claudeSessionId: s.claudeSessionId,
      })),
    sanitizeTab,
  );
}

// listClaudeTmuxPanes() の target（`sess:win.pane`）から tmux セッション名と window 番号を取る
// （tmux セッション名も target から取る。enrichPanesWithSessionMeta() が sessionName を
// Claude 側のセッション名（/rename）で上書きするため、pane.sessionName は tmux の名前ではない）
function parseTarget(target) {
  const m = /^(.*):(\d+)\.\d+$/.exec(target || '');
  return m ? { tmuxSession: m[1], windowIndex: Number(m[2]) } : { tmuxSession: null, windowIndex: null };
}

function paneToSnapshot(p) {
  return sanitizePane({
    claudeSessionId: p.claudeSessionId,
    cwd: p.cwd,
    ...parseTarget(p.target),
    windowName: p.windowName,
  });
}

// 一括再開で起こしたペインをスナップショットに入れる。claude のセッションメタが書かれて
// 次の定期更新で拾えるまでの間に再起動しても、記録から漏れないようにする
export function upsertPaneSnapshot(prev, pane) {
  const snap = paneToSnapshot(pane);
  if (!snap) return prev;
  return [snap, ...prev.filter((p) => p.claudeSessionId !== snap.claudeSessionId)].slice(0, MAX_ENTRIES);
}

// ブラウザから終了した claude をスナップショットから外す。残すと、次の定期更新より前に
// 再起動したとき「動いていなかったもの」として再開待ちに入ってしまう
export function removePaneSnapshot(prev, claudeSessionId) {
  if (!claudeSessionId) return prev;
  return prev.filter((p) => p.claudeSessionId !== claudeSessionId);
}

// tmux 上の claude のスナップショットを更新する。
// - livePanes: enrichPanesWithSessionMeta() 済みの claude ペイン
// - tmuxAlive: tmux サーバーが応答したか。応答しない（終了処理中・未起動）ときは前回の内容を保つ
export function updatePaneSnapshot(prev, livePanes, { tmuxAlive }) {
  if (!tmuxAlive) return prev;
  const next = [];
  const seen = new Set();
  for (const p of livePanes) {
    const snap = p.claudeSessionId ? paneToSnapshot(p) : null;
    if (!snap || seen.has(snap.claudeSessionId)) continue;
    seen.add(snap.claudeSessionId);
    next.push(snap);
  }
  for (const old of prev) {
    if (seen.has(old.claudeSessionId)) continue;
    const missing = old.missing + 1;
    if (missing < MISSING_LIMIT) next.push({ ...old, missing });
  }
  return next.slice(0, MAX_ENTRIES);
}

function sortPending(list) {
  return [...list].sort((a, b) => {
    const sa = a.tmuxSession ?? '￿';
    const sb = b.tmuxSession ?? '￿';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.windowIndex ?? Infinity) - (b.windowIndex ?? Infinity);
  });
}

// 保存内容と「いま生きているもの」から、起動時に何をするかを決める純粋関数。
// - livePanes: enrichPanesWithSessionMeta() 済みの claude ペイン（claudeSessionId 付き）
// - running:   listRunningSessions() 相当（{sessionId}）。tmux 外で動いているものの判定に使う
// 戻り値:
// - attach:   [{tab, pane}] ブリッジのタブだったもの（tab）を生きているペインに繋ぎ直す
// - readonly: [tab] 閲覧タブとして開き直す（元が閲覧、または tmux 外で動いている）
// - pending:  再開待ち（tmux の置き場所と、ブリッジのタブだったなら tab: {id, name}）。tmux セッション・window 番号順
export function planRestore({ tabs = [], panes = [], pending = [] }, livePanes = [], running = []) {
  const liveBySid = new Map();
  for (const p of livePanes) {
    if (p.claudeSessionId && !liveBySid.has(p.claudeSessionId)) liveBySid.set(p.claudeSessionId, p);
  }
  const runningIds = new Set(running.map((r) => r.sessionId).filter(Boolean));
  const isLive = (sid) => liveBySid.has(sid) || runningIds.has(sid);

  const attach = [];
  const readonly = [];
  const readonlySids = new Set();
  const tmuxTabSids = new Set();
  const addReadonly = (tab) => {
    if (readonlySids.has(tab.claudeSessionId)) return;
    readonlySids.add(tab.claudeSessionId);
    readonly.push(tab);
  };

  // 再開待ちの候補（sid ごとにまとめる。置き場所は panes / 前回の pending、タブ情報は tabs / 前回の pending から）
  const candidates = new Map();
  const candidate = (sid) => {
    if (!candidates.has(sid)) candidates.set(sid, { claudeSessionId: sid, tab: null });
    return candidates.get(sid);
  };
  const merge = (target, src) => {
    for (const k of ['name', 'cwd', 'projectDir', 'tmuxSession', 'windowName', 'windowIndex']) {
      if (target[k] == null && src[k] != null) target[k] = src[k];
    }
  };

  const placeTmuxTab = (tab) => {
    const sid = tab.claudeSessionId;
    if (tmuxTabSids.has(sid)) return;
    tmuxTabSids.add(sid);
    const pane = liveBySid.get(sid);
    if (pane) attach.push({ tab, pane });
    // tmux 外（素のターミナル等）で動いている。resume すると 2 本立つので閲覧で開く
    else if (runningIds.has(sid)) addReadonly(tab);
    else {
      const c = candidate(sid);
      c.tab = c.tab || { id: tab.id, name: tab.name };
      merge(c, tab);
    }
  };

  for (const tab of tabs) {
    if (tab.type === 'tmux') placeTmuxTab(tab);
    else addReadonly(tab);
  }
  // 前回の再開待ちも毎回見直す（手で resume 済みなら、タブだったものは繋ぐだけにする）
  for (const p of pending) {
    if (p.tab) {
      placeTmuxTab({ type: 'tmux', id: p.tab.id, name: p.tab.name, ...pick(p) });
      if (candidates.has(p.claudeSessionId)) merge(candidates.get(p.claudeSessionId), p);
    } else if (!isLive(p.claudeSessionId)) {
      merge(candidate(p.claudeSessionId), p);
    }
  }
  for (const s of panes) {
    if (!isLive(s.claudeSessionId)) merge(candidate(s.claudeSessionId), s);
  }
  // 候補のうち、どこかで動いているものは外す（tab 付きは上で attach / readonly に回っている）
  const nextPending = [...candidates.values()].filter((c) => !isLive(c.claudeSessionId));
  return { attach, readonly, pending: sortPending(nextPending) };
}

function pick(p) {
  return { claudeSessionId: p.claudeSessionId, cwd: p.cwd, projectDir: p.projectDir };
}

// 一括再開の直前に、すでに動き出しているものを外す（同じセッションに claude を 2 本立てない）
// - attach:   タブだったもので、もう tmux で動いている → 繋ぐだけ
// - readonly: タブだったもので、tmux 外で動いている → 閲覧で開く
// - skip:     タブではなかったもので、もうどこかで動いている → 何もしない
// - resume:   まだ動いていない → tmux で起こす
export function splitPending(pending, livePanes = [], running = []) {
  const liveBySid = new Map(livePanes.filter((p) => p.claudeSessionId).map((p) => [p.claudeSessionId, p]));
  const runningIds = new Set(running.map((r) => r.sessionId).filter(Boolean));
  const out = { attach: [], readonly: [], skip: [], resume: [] };
  for (const p of pending) {
    const pane = liveBySid.get(p.claudeSessionId);
    const tab = p.tab ? { type: 'tmux', id: p.tab.id, name: p.tab.name, ...pick(p) } : null;
    if (pane) {
      if (tab) out.attach.push({ tab, pane });
      else out.skip.push(p);
    } else if (runningIds.has(p.claudeSessionId)) {
      if (tab) out.readonly.push({ ...tab, type: 'readonly' });
      else out.skip.push(p);
    } else {
      out.resume.push(p);
    }
  }
  return out;
}
