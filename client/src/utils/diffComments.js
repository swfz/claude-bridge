// 差分ドロワーの行への指摘（書きかけ・未送信）の置き場。
//
// ドロワーはタブ切替・Esc・閉じるでアンマウントされ、取り直し・範囲切替でファイルの要素も作り直されるので、
// InputBar の drafts / PreviewDrawer の reviewDrafts と同じくモジュールレベルに置く（リロードで消えるのは許容）。
// 送信結果（submit_review_result）はドロワーが閉じた後に届くこともあるので、App からも同じ store を触る。
//
// 指摘: {key, path, oldPath, side: 'new'|'old', start, end, quote, text, sendingId}
// キーは配列の添字ではなく「sessionKey + パス + 側 + 行番号（範囲は開始-終了）」。差分を取り直して
// 行の並びが変わっても、同じ行を指す指摘と対応が崩れないようにするため（scope は入れない。
// 全体／このセッションで同じファイルの行番号は変わらない）。

// パスは | を含み得るので最後に置く（DOM の属性・セレクタにも使うので NUL などの区切りは使わない）
export function diffCommentKey({ sessionKey, path, side, start, end }) {
  return [sessionKey, side, `${start}-${end}`, path].join('|');
}

// 送る対象（本文があり、送信中でないもの）
export function isUnsent(comment) {
  return !!comment && !comment.sendingId && !!(comment.text || '').trim();
}

const EMPTY_ENTRY = Object.freeze({ list: Object.freeze([]), byPath: Object.freeze({}), status: null });

function sameArray(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

// list から path ごとの配列を作る。中身の変わらない path は前の配列の参照を保つ
// （ファイル単位で memo した描画が、別ファイルの打鍵で再描画されないように）
export function groupByPath(list, prev = {}) {
  const groups = {};
  for (const c of list) (groups[c.path] ||= []).push(c);
  for (const path of Object.keys(groups)) {
    if (sameArray(prev[path], groups[path])) groups[path] = prev[path];
  }
  return groups;
}

// 送信結果（「N件送信しました」など）を出しておく時間。ドロワーが閉じていても store 側で消す
export const STATUS_MS = 3000;

export function createDiffCommentStore({ statusMs = STATUS_MS } = {}) {
  const entries = new Map();
  const listeners = new Set();

  const get = (sessionKey) => entries.get(sessionKey) || EMPTY_ENTRY;
  const emit = () => listeners.forEach((fn) => fn());
  const commit = (sessionKey, list, status = get(sessionKey).status) => {
    const prev = get(sessionKey);
    if (list.length === 0 && !status) entries.delete(sessionKey);
    else entries.set(sessionKey, { list, byPath: groupByPath(list, prev.byPath), status });
    emit();
  };
  const clearStatus = (sessionKey) => {
    if (!get(sessionKey).status) return;
    commit(sessionKey, get(sessionKey).list, null);
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // useSyncExternalStore の getSnapshot。変化が無ければ同じ参照を返す
    snapshot: get,
    // 同じキーがあれば置き換え、無ければ末尾に足す
    upsert(sessionKey, comment) {
      const list = get(sessionKey).list;
      const i = list.findIndex((c) => c.key === comment.key);
      commit(sessionKey, i < 0 ? [...list, comment] : list.map((c, j) => (j === i ? comment : c)));
    },
    // oldKey の指摘を comment に差し替える（範囲を広げたときなど。位置は保つ）。
    // 差し替え先のキーが別に既にあれば、そちらは捨てる
    replace(sessionKey, oldKey, comment) {
      const list = get(sessionKey).list.filter((c) => c.key === oldKey || c.key !== comment.key);
      const i = list.findIndex((c) => c.key === oldKey);
      commit(sessionKey, i < 0 ? [...list, comment] : list.map((c, j) => (j === i ? comment : c)));
    },
    update(sessionKey, key, patch) {
      const list = get(sessionKey).list;
      if (!list.some((c) => c.key === key)) return;
      commit(
        sessionKey,
        list.map((c) => (c.key === key ? { ...c, ...patch } : c)),
      );
    },
    remove(sessionKey, key) {
      const list = get(sessionKey).list;
      if (!list.some((c) => c.key === key)) return;
      commit(
        sessionKey,
        list.filter((c) => c.key !== key),
      );
    },
    // 送信した指摘に requestId を付ける（結果が来るまで二重に送らない）
    markSending(sessionKey, keys, requestId) {
      const set = new Set(keys);
      commit(
        sessionKey,
        get(sessionKey).list.map((c) => (set.has(c.key) ? { ...c, sendingId: requestId } : c)),
        null,
      );
    },
    // 送信結果。成功ならその指摘を消し、失敗なら送信中を外して残す。該当が無ければ false
    resolveSending(requestId, ok) {
      for (const [sessionKey, entry] of entries) {
        const sent = entry.list.filter((c) => c.sendingId === requestId);
        if (sent.length === 0) continue;
        const list = ok
          ? entry.list.filter((c) => c.sendingId !== requestId)
          : entry.list.map((c) => (c.sendingId === requestId ? { ...c, sendingId: null } : c));
        const status = { ok, count: sent.length };
        commit(sessionKey, list, status);
        // 送ってすぐ閉じても、次に開いたときに古い結果を出さない（同じ結果のままなら消す）
        setTimeout(() => {
          if (get(sessionKey).status === status) clearStatus(sessionKey);
        }, statusMs);
        return true;
      }
      return false;
    },
    // from（ブリッジ ID）に置いた指摘を to（claudeSessionId）へ移す。tmux タブは claudeSessionId が
    // 後から決まり、保存キー（sessionKey）が途中で変わるため。同じキーが to に既にあれば to を残す
    migrateSession(from, to) {
      if (!from || !to || from === to || !entries.has(from)) return false;
      const moving = get(from).list;
      const target = get(to).list;
      const have = new Set(target.map((c) => c.key));
      const moved = moving
        .map((c) => ({ ...c, key: diffCommentKey({ ...c, sessionKey: to }) }))
        .filter((c) => !have.has(c.key));
      entries.delete(from);
      commit(to, [...target, ...moved]);
      return true;
    },
    clearStatus,
  };
}

// アプリ全体で 1 つ（DiffDrawer と App の送信結果の受け側が共有する）
export const diffCommentStore = createDiffCommentStore();
