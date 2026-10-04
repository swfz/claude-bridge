// ホームの「やり残し判定」。サーバーが summary に乗せる turnState（最後のターンの終わり方）と
// completion（このセッションが編集したファイルの git 状態）、起動中なら status / waitingFor から、
// セッションを 1 つの状態にまとめる。

export const COMPLETION_STATES = {
  working: { label: '作業中', title: 'Claude が応答を生成中' },
  waiting: { label: '返事待ち', title: '選択肢・ツール許可の回答を待っている' },
  interrupted: { label: '途中で終了', title: 'ターンの途中で止まった・中断した・エラーで終わった' },
  unfinished: { label: 'やり残し', title: 'ターンは終わったが、編集したファイルに未コミットの変更がある' },
  done: { label: '完了', title: 'ターンが終わり、編集したファイルもコミット済み' },
};

// 絞り込みチップに出す順（作業中・返事待ちは起動中の上段にしか出ないので含めない）
export const FILTERABLE_STATES = ['unfinished', 'interrupted', 'done'];

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

// running: 起動中のセッションなら true（上段のカード）。終了したセッションは status を見ない
export function classifyCompletion(session, { running = false } = {}) {
  if (!session) return null;
  if (running && session.waitingFor) return 'waiting';
  if (running && isBusy(session.status)) return 'working';
  if (TURN_NOT_ENDED.has(session.turnState)) return 'interrupted';
  if (session.completion?.git === 'dirty') return 'unfinished';
  return 'done';
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
  if (!completion || completion.git === 'none') {
    checks.push({ label: '編集なし', ok: true });
  } else if (completion.git === 'unknown') {
    // worktree を消した後など。未コミットがあれば git は worktree の削除を拒否するので、
    // 状態は「完了」寄りに倒しつつ、確認できていないことは見せる
    checks.push({ label: 'コミット状況を確認できず（cwd が無い / git 管理外）', ok: null });
  } else if (completion.git === 'clean') {
    checks.push({ label: `コミット済み（編集 ${completion.edited} ファイル）`, ok: true });
  } else {
    checks.push({ label: `未コミット ${completion.uncommittedCount} ファイル`, ok: false });
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
