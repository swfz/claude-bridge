// ホームの「やり残し判定」。サーバーが summary に乗せる turnState（最後のターンの終わり方）と
// completion（このセッションが編集したファイルの git 状態）、起動中なら status / waitingFor から、
// セッションを 1 つの状態にまとめる。
// 「完了」は「編集して → コミットして → push して終わった」もの（PR を作ったならそれがマージされたもの）
// だけにし、相談だけで終わったもの・コミット止まり・PR がマージ待ちのものは別の状態として分ける。

export const COMPLETION_STATES = {
  working: { label: '作業中', title: 'Claude が応答を生成中' },
  waiting: { label: '返事待ち', title: '選択肢・ツール許可の回答を待っている' },
  interrupted: { label: '途中で終了', title: 'ターンの途中で止まった・中断した・エラーで終わった' },
  unfinished: { label: 'やり残し', title: 'ターンは終わったが、編集したファイルに未コミットの変更がある' },
  merging: { label: 'マージ待ち', title: 'PR を作ったが、まだマージされていない' },
  unpushed: { label: '反映前', title: 'コミットはあるが、このセッションで push も PR 作成もしていない' },
  asking: { label: '回答待ち', title: '編集はなく、最後の応答が質問で終わっている（返事をしていない）' },
  consult: { label: '相談のみ', title: '編集はなく、調査・相談で終わった' },
  done: { label: '完了', title: '編集をコミットして push まで済んでいる（PR を作ったならマージ済み）' },
};

// 絞り込みチップに出す順（作業中・返事待ちは起動中の上段にしか出ないので含めない）
export const FILTERABLE_STATES = ['unfinished', 'unpushed', 'merging', 'interrupted', 'asking', 'consult', 'done'];

const TURN_NOT_ENDED = new Set(['midway', 'prompt', 'interrupted', 'error']);

const TURN_LABELS = {
  ended: 'ターン終了',
  midway: 'ツールの実行中に止まった',
  prompt: '最後の指示に応答が無い',
  interrupted: 'ユーザーが中断',
  error: 'API エラーで終了',
};

function isBusy(status) {
  return status === 'busy' || status === 'working';
}

function hasNoEdits(completion) {
  return !completion || completion.git === 'none';
}

// セッションが作った PR のまとめ。null（PR なし）/ 'open'（未マージがある）/
// 'unknown'（確認できないものがある）/ 'resolved'（全部マージ済みかクローズ済み）
export function prOutcome(completion) {
  const prs = completion?.prs;
  if (!Array.isArray(prs) || prs.length === 0) return null;
  if (prs.some((pr) => pr.state === 'open')) return 'open';
  if (prs.some((pr) => pr.state !== 'merged' && pr.state !== 'closed')) return 'unknown';
  return 'resolved';
}

const PR_CHECKS = {
  merged: { text: 'マージ済み', ok: true },
  open: { text: '未マージ', ok: false },
  closed: { text: 'マージせずクローズ', ok: true },
};

function prNumber(url) {
  return String(url || '').split('/').pop();
}

// running: 起動中のセッションなら true（上段のカード）。終了したセッションは status を見ない
export function classifyCompletion(session, { running = false } = {}) {
  if (!session) return null;
  if (running && session.waitingFor) return 'waiting';
  if (running && isBusy(session.status)) return 'working';
  if (TURN_NOT_ENDED.has(session.turnState)) return 'interrupted';
  const completion = session.completion;
  const prs = prOutcome(completion);
  if (hasNoEdits(completion) && !prs) return session.lastAssistantQuestion ? 'asking' : 'consult';
  if (completion.git === 'dirty') return 'unfinished';
  if (prs === 'open') return 'merging';
  // PR の状態を確認できない（gh のアカウントが合わない等）ときは、git unknown と同じく完了に倒す
  if (prs) return 'done';
  // cwd が読めない（worktree 削除済み・git 管理外）。未コミットがあると git は worktree の
  // 削除を拒否するので、マージ後とみなして完了に倒す
  if (completion.git === 'unknown') return 'done';
  // リモートの無いローカル専用リポジトリは push しようがないので、コミットで完了とみなす
  return completion.pushed || completion.hasRemote === false ? 'done' : 'unpushed';
}

// ツールチップの内訳。ok は true（満たす）/ false（満たさない）/ null（判定できない）
export function completionChecks(session, { running = false } = {}) {
  const checks = [];
  const turn = session.turnState;
  checks.push({
    label: turn && turn !== 'ended' ? TURN_LABELS[turn] : 'ターン終了',
    ok: turn ? turn === 'ended' : null,
  });
  if (running) checks.push({ label: '返事待ちなし', ok: !session.waitingFor });

  const completion = session.completion;
  const hasPrs = prOutcome(completion) !== null;
  if (hasNoEdits(completion)) {
    checks.push({ label: '編集なし', ok: true });
    if (!hasPrs) {
      const asking = !!session.lastAssistantQuestion;
      checks.push({ label: asking ? '最後の応答が質問で終わっている' : '最後の応答は質問ではない', ok: !asking });
    }
  } else if (completion.git === 'unknown') {
    // worktree を消した後など。未コミットがあれば git は worktree の削除を拒否するので、
    // 状態は「完了」寄りに倒しつつ、確認できていないことは見せる
    checks.push({ label: 'コミット状況を確認できず（cwd が無い / git 管理外）', ok: null });
  } else if (completion.git === 'clean') {
    checks.push({ label: `コミット済み（編集 ${completion.edited} ファイル）`, ok: true });
    // PR があるときは下の PR ごとの行で示すので、push / リモートの行は出さない
    if (!hasPrs && completion.hasRemote === false) {
      checks.push({ label: 'リモート無し（コミット＝反映）', ok: true });
    } else if (!hasPrs) {
      const pushed = !!completion.pushed;
      checks.push({
        label: pushed ? (completion.prCount > 0 ? 'PR 作成済み' : 'push 済み') : 'push / PR の記録なし（このセッション内）',
        ok: pushed,
      });
    }
  } else {
    checks.push({ label: `未コミット ${completion.uncommittedCount} ファイル`, ok: false });
  }
  if (hasPrs) {
    for (const pr of completion.prs.slice(0, 5)) {
      const check = PR_CHECKS[pr.state] || { text: '状態を確認できず', ok: null };
      checks.push({ label: `PR #${prNumber(pr.url)} ${check.text}`, ok: check.ok });
    }
  }
  return checks;
}

const MARK = { true: '✓', false: '✗', null: '?' };

export function completionTooltip(session, options = {}) {
  const state = classifyCompletion(session, options);
  const lines = [`${COMPLETION_STATES[state].label}: ${COMPLETION_STATES[state].title}`];
  for (const check of completionChecks(session, options)) lines.push(`${MARK[check.ok]} ${check.label}`);
  const files = session.completion?.uncommitted || [];
  if (files.length > 0) {
    lines.push('', ...files.map((f) => `  ${f}`));
    const rest = (session.completion.uncommittedCount || 0) - files.length;
    if (rest > 0) lines.push(`  …ほか ${rest} ファイル`);
  }
  if (session.awaySummary?.text) lines.push('', `現状: ${session.awaySummary.text}`);
  return lines.join('\n');
}

// 状態ごとの件数（絞り込みチップ用）
export function countByCompletion(sessions, options = {}) {
  const counts = {};
  for (const s of sessions || []) {
    const state = classifyCompletion(s, options);
    counts[state] = (counts[state] || 0) + 1;
  }
  return counts;
}

export function filterByCompletion(sessions, state, options = {}) {
  if (!state) return sessions;
  return (sessions || []).filter((s) => classifyCompletion(s, options) === state);
}
