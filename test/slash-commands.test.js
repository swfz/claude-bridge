import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSlashCommands, clearSlashCommandsCache } from '../server/slash-commands.js';

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slash-commands-'));
  clearSlashCommandsCache();
});

afterEach(async () => {
  clearSlashCommandsCache();
  await rm(root, { recursive: true, force: true });
});

// <base>/skills/<name>/SKILL.md を作る
async function writeSkill(base, name, description) {
  const dir = join(base, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n本文\n`);
  return dir;
}

async function writeCommand(base, relPath, contents) {
  const path = join(base, 'commands', relPath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

const find = (commands, name) => commands.find((c) => c.name === name);

describe('listSlashCommands', () => {
  it('ユーザースキルの frontmatter から description を読む', async () => {
    const claudeDir = join(root, 'claude');
    await writeSkill(claudeDir, 'blog', '記事化する');

    const commands = await listSlashCommands({ claudeDir });
    assert.deepEqual(find(commands, 'blog'), {
      name: 'blog',
      description: '記事化する',
      source: 'user-skill',
    });
  });

  it('シンボリックリンクされたスキルディレクトリを追従する', async () => {
    const claudeDir = join(root, 'claude');
    const real = join(root, 'dotfiles', 'commit');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\ndescription: commit する\n---\n');
    await mkdir(join(claudeDir, 'skills'), { recursive: true });
    await symlink(real, join(claudeDir, 'skills', 'commit'));

    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'commit').description, 'commit する');
  });

  it('description が折り返し記法（>-）でも連結して読む', async () => {
    const claudeDir = join(root, 'claude');
    await mkdir(join(claudeDir, 'skills', 'ship'), { recursive: true });
    await writeFile(
      join(claudeDir, 'skills', 'ship', 'SKILL.md'),
      '---\ndescription: >-\n  commit から PR 作成まで\n  一気にやる\nname: ship\n---\n',
    );

    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'ship').description, 'commit から PR 作成まで 一気にやる');
  });

  it('commands のサブディレクトリは dir:name になる', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, join('gh', 'pr.md'), '---\ndescription: PR を作る\n---\n');
    await writeCommand(claudeDir, 'note.md', '\nメモを残す\n');

    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'gh:pr').description, 'PR を作る');
    assert.equal(find(commands, 'gh:pr').source, 'user-command');
    // frontmatter が無ければ本文の最初の非空行
    assert.equal(find(commands, 'note').description, 'メモを残す');
  });

  it('プロジェクト（cwd）側のスキルを拾い、同名はプロジェクトを優先する', async () => {
    const claudeDir = join(root, 'claude');
    const cwd = join(root, 'project');
    await writeSkill(claudeDir, 'deploy', 'ユーザー側');
    await writeSkill(join(cwd, '.claude'), 'deploy', 'プロジェクト側');
    await writeSkill(join(cwd, '.claude'), 'migrate', 'マイグレーションする');

    const commands = await listSlashCommands({ cwd, claudeDir });
    assert.equal(find(commands, 'deploy').description, 'プロジェクト側');
    assert.equal(find(commands, 'deploy').source, 'project-skill');
    assert.equal(find(commands, 'migrate').source, 'project-skill');
  });

  it('installed_plugins.json からプラグインスキルを plugin:name で拾う', async () => {
    const claudeDir = join(root, 'claude');
    const installPath = join(root, 'plugin-cache', 'slack');
    await writeSkill(installPath, 'block-kit', 'Block Kit を組む');
    await mkdir(join(claudeDir, 'plugins'), { recursive: true });
    await writeFile(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'slack@marketplace': [{ scope: 'user', installPath }] },
      }),
    );

    const commands = await listSlashCommands({ claudeDir });
    assert.deepEqual(find(commands, 'slack:block-kit'), {
      name: 'slack:block-kit',
      description: 'Block Kit を組む',
      source: 'plugin',
    });
  });

  it('claudeDir が存在しなくても組み込みコマンドは返る', async () => {
    const commands = await listSlashCommands({ claudeDir: join(root, 'missing') });
    assert.equal(find(commands, 'clear').source, 'builtin');
    assert.ok(find(commands, 'compact'));
    // name 昇順
    const names = commands.map((c) => c.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('ブラウザから操作できない組み込みコマンドは候補に出さない', async () => {
    const commands = await listSlashCommands({ claudeDir: join(root, 'missing') });
    // モーダルを開くもの（ブラウザ側に何も出ない）と実在しないもの
    for (const name of ['model', 'help', 'cost', 'usage', 'config', 'permissions', 'resume', 'todos']) {
      assert.equal(find(commands, name), undefined, `${name} は候補に出さない`);
    }
    // 会話に結果が出る／そのまま動くものは残す
    assert.equal(find(commands, 'context').source, 'builtin');
    assert.equal(find(commands, 'clear').source, 'builtin');
  });

  it('同梱スキル（バイナリ埋め込みの静的リスト）が候補に含まれる', async () => {
    const commands = await listSlashCommands({ claudeDir: join(root, 'missing') });
    assert.equal(find(commands, 'code-review').source, 'bundled');
    assert.equal(find(commands, 'security-review').source, 'bundled');
    assert.ok(find(commands, 'artifact-design'));
  });

  it('同梱スキルと同名のユーザースキルがあればユーザー側が勝つ', async () => {
    const claudeDir = join(root, 'claude');
    await writeSkill(claudeDir, 'code-review', '自作のレビュー手順');

    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'code-review').source, 'user-skill');
    assert.equal(find(commands, 'code-review').description, '自作のレビュー手順');
    // name が完全一致するものは 1 件に畳まれる
    assert.equal(commands.filter((c) => c.name === 'code-review').length, 1);
  });

  it('同じ引数ならキャッシュを返し、clearSlashCommandsCache で作り直す', async () => {
    const claudeDir = join(root, 'claude');
    await writeSkill(claudeDir, 'first', '最初のスキル');
    const before = await listSlashCommands({ claudeDir });
    assert.ok(find(before, 'first'));

    await writeSkill(claudeDir, 'second', 'あとから足したスキル');
    const cached = await listSlashCommands({ claudeDir });
    assert.equal(find(cached, 'second'), undefined);

    clearSlashCommandsCache();
    const fresh = await listSlashCommands({ claudeDir });
    assert.equal(find(fresh, 'second').description, 'あとから足したスキル');
  });
});
