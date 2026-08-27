// セッションカードの cwd 表示用。
// git worktree のパスは「プロジェクト名」が worktree 名に埋もれて見えなくなるため、
// マーカー（.claude/worktrees, .worktrees, worktrees）を手がかりに両方を取り出す。

// 単独の "worktrees" より前に ".claude/worktrees" を試す
// （後者が一致するパスで ".claude" を project と誤認しないため）
const WORKTREE_MARKERS = [['.claude', 'worktrees'], ['.worktrees'], ['worktrees']];

/**
 * cwd を { parent, project, worktree } に分解する。
 * parent は project の一つ上のディレクトリ名（同名プロジェクトの識別用。無ければ null）。
 * @param {string} cwd
 * @returns {{ parent: string | null, project: string, worktree: string | null }}
 */
export function parseCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return { parent: null, project: '', worktree: null };

  const segments = cwd.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { parent: null, project: '', worktree: null };

  // 末尾側から探すため逆順に走査する
  for (let i = segments.length - 1; i >= 0; i--) {
    for (const marker of WORKTREE_MARKERS) {
      const markerLen = marker.length;
      const start = i - markerLen + 1;
      if (start < 0) continue;
      const matched = marker.every((m, idx) => segments[start + idx] === m);
      if (!matched) continue;

      const worktreeIdx = start + markerLen;
      const projectIdx = start - 1;
      if (worktreeIdx < segments.length && projectIdx >= 0) {
        return {
          parent: projectIdx >= 1 ? segments[projectIdx - 1] : null,
          project: segments[projectIdx],
          worktree: segments[worktreeIdx],
        };
      }
    }
  }

  return {
    parent: segments.length >= 2 ? segments[segments.length - 2] : null,
    project: segments[segments.length - 1],
    worktree: null,
  };
}
