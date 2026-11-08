import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// /preview は Express の res.sendFile で返す。sendFile の dotfiles 既定は 'ignore' で、
// パスのどこかにドット始まりのセグメント（.claude など）があると 404 になる。
// git worktree は `.claude/worktrees/` 配下に作られるので、そこで開いたセッションから
// 参照したファイルが全部プレビューできなかった（/file-exists は true なのでボタンは出る）。
test('ドット始まりのディレクトリ配下（worktree 相当）のファイルもプレビューできる', async ({ request }) => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-e2e-preview-'));
  const dir = join(base, '.claude', 'worktrees', 'some-worktree');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'README.md');
  writeFileSync(file, '# worktree preview\n');
  try {
    const exists = await request.get(`/file-exists?path=${encodeURIComponent(file)}`);
    expect(await exists.json()).toEqual({ exists: true });

    const res = await request.get(`/preview?path=${encodeURIComponent(file)}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe('# worktree preview\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// dotfiles を許可した代わりに、資格情報の置き場として知られているパスは明示的に拒否する
test('資格情報の置き場（.ssh / .env）は home 配下でもプレビューできない', async ({ request }) => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-e2e-preview-'));
  mkdirSync(join(base, '.ssh'), { recursive: true });
  const key = join(base, '.ssh', 'id_ed25519');
  const env = join(base, '.env');
  writeFileSync(key, 'PRIVATE KEY\n');
  writeFileSync(env, 'TOKEN=secret\n');
  try {
    for (const file of [key, env]) {
      const res = await request.get(`/preview?path=${encodeURIComponent(file)}`);
      expect(res.status()).toBe(403);
      const exists = await request.get(`/file-exists?path=${encodeURIComponent(file)}`);
      expect(await exists.json()).toEqual({ exists: false });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
