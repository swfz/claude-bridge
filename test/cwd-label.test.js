import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCwd } from '../client/src/utils/cwdLabel.js';

describe('parseCwd', () => {
  it('handles missing input', () => {
    assert.deepEqual(parseCwd(null), { parent: null, project: '', worktree: null });
    assert.deepEqual(parseCwd(undefined), { parent: null, project: '', worktree: null });
    assert.deepEqual(parseCwd(''), { parent: null, project: '', worktree: null });
    assert.deepEqual(parseCwd(42), { parent: null, project: '', worktree: null });
  });

  it('extracts project and worktree from a .claude/worktrees path', () => {
    assert.deepEqual(parseCwd('/home/sawafuji/gh/claude-bridge/.claude/worktrees/optimized-cooking-garden'), {
      parent: 'gh',
      project: 'claude-bridge',
      worktree: 'optimized-cooking-garden',
    });
  });

  it('ignores subdirectories inside a worktree', () => {
    assert.deepEqual(parseCwd('/home/u/gh/claude-bridge/.claude/worktrees/foo/server'), {
      parent: 'gh',
      project: 'claude-bridge',
      worktree: 'foo',
    });
  });

  it('recognizes a bare .worktrees marker segment', () => {
    assert.deepEqual(parseCwd('/home/u/proj/.worktrees/x'), {
      parent: 'u',
      project: 'proj',
      worktree: 'x',
    });
  });

  it('recognizes a bare worktrees marker segment', () => {
    assert.deepEqual(parseCwd('/home/u/repo/worktrees/bar'), {
      parent: 'u',
      project: 'repo',
      worktree: 'bar',
    });
  });

  it('falls back to the last segment for a normal path', () => {
    assert.deepEqual(parseCwd('/home/u/gh/claude-bridge'), {
      parent: 'gh',
      project: 'claude-bridge',
      worktree: null,
    });
  });

  it('ignores trailing slashes and empty segments', () => {
    assert.deepEqual(parseCwd('/a/b/'), { parent: 'a', project: 'b', worktree: null });
    assert.deepEqual(parseCwd('/a//b//'), { parent: 'a', project: 'b', worktree: null });
  });

  it('returns null parent for a single-segment path', () => {
    assert.deepEqual(parseCwd('/repo'), { parent: null, project: 'repo', worktree: null });
  });

  it('returns null parent when the project is directly under the root', () => {
    assert.deepEqual(parseCwd('/proj/worktrees/x'), {
      parent: null,
      project: 'proj',
      worktree: 'x',
    });
  });

  it('falls back to the last segment when the marker has no preceding project segment', () => {
    assert.deepEqual(parseCwd('/worktrees/bar'), {
      parent: 'worktrees',
      project: 'bar',
      worktree: null,
    });
  });
});
