import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitivePath } from '../server/sensitive-paths.js';

describe('isSensitivePath', () => {
  it('資格情報の置き場として知られているディレクトリ配下を拒否する', () => {
    for (const p of [
      '/home/u/.ssh/id_ed25519',
      '/home/u/.ssh/config',
      '/home/u/.aws/credentials',
      '/home/u/.gnupg/private-keys-v1.d/x.key',
      '/home/u/.kube/config',
      '/home/u/.docker/config.json',
      '/home/u/.azure/accessTokens.json',
      '/home/u/gh/repo/.ssh/deploy_key', // home 直下でなくても
      '/home/u/.terraform.d/credentials.tfrc.json',
      '/home/u/.local/share/keyrings/login.keyring',
      '/Users/u/.SSH/id_rsa', // 大文字小文字を区別しない FS
    ]) {
      assert.equal(isSensitivePath(p), true, p);
    }
  });

  it('資格情報のファイル名を拒否する', () => {
    for (const p of [
      '/home/u/.netrc',
      '/home/u/.git-credentials',
      '/home/u/.npmrc',
      '/home/u/.pypirc',
      '/home/u/.claude/.credentials.json',
      '/home/u/.claude.json',
      '/home/u/.pgpass',
      '/home/u/.my.cnf',
      '/home/u/.zsh_history',
      '/home/u/gh/repo/.git/config',
      '/home/u/gh/repo/.env',
      '/home/u/gh/repo/.env.local',
      '/home/u/gh/repo/.env.production',
    ]) {
      assert.equal(isSensitivePath(p), true, p);
    }
  });

  it('.config / .local は決まったサブディレクトリだけ拒否する', () => {
    assert.equal(isSensitivePath('/home/u/.config/gh/hosts.yml'), true);
    assert.equal(isSensitivePath('/home/u/.config/gcloud/credentials.db'), true);
    assert.equal(isSensitivePath('/home/u/.config/hub'), true);
    assert.equal(isSensitivePath('/home/u/.config/nvim/init.lua'), false);
    assert.equal(isSensitivePath('/home/u/.local/share/nvim/x'), false);
  });

  it('ドット配下でも普通に見たいファイルは通す', () => {
    for (const p of [
      '/home/u/gh/repo/.claude/worktrees/foo/README.md',
      '/home/u/.claude/CLAUDE.md',
      '/home/u/.claude/skills/x/SKILL.md',
      '/home/u/.claude/settings.json',
      '/home/u/gh/repo/.github/workflows/ci.yml',
      '/home/u/gh/repo/.env.example', // 値の入っていない雛形は .env.* でも…
      '/home/u/gh/repo/src/env.js',
      '/home/u/gh/repo/.envrc',
      '/home/u/gh/repo/.git/HEAD', // .git 配下は config だけ拒否
      '/home/u/gh/repo/config/database.yml',
    ]) {
      // .env.example は .env.* に当たるので拒否される（雛形でも値が入っていることがあるため許容）
      const expected = p.endsWith('.env.example');
      assert.equal(isSensitivePath(p), expected, p);
    }
  });

  it('不正な入力は拒否しない（サンドボックス判定が先に弾く）', () => {
    assert.equal(isSensitivePath(''), false);
    assert.equal(isSensitivePath(null), false);
    assert.equal(isSensitivePath('/'), false);
  });
});
