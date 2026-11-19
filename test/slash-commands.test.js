import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
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

  it('ブリッジが処理する /diff は同名のユーザースキルより優先して出す', async () => {
    const dir = join(root, 'bridge-diff');
    await mkdir(join(dir, 'skills', 'diff'), { recursive: true });
    await writeFile(join(dir, 'skills', 'diff', 'SKILL.md'), '---\ndescription: user diff\n---\n');
    const commands = await listSlashCommands({ claudeDir: dir });
    assert.equal(find(commands, 'diff').source, 'bridge');
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

describe('listSlashCommands の静的な候補と読み取りの細部', () => {
  async function writePlugins(claudeDir, plugins) {
    await mkdir(join(claudeDir, 'plugins'), { recursive: true });
    await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  }

  it('claudeDir が空なら組み込み・同梱・ブリッジの候補を説明文つきでそのまま返す', async () => {
    const commands = await listSlashCommands({ claudeDir: join(root, 'missing') });
    assert.deepEqual(commands, [
      { name: 'artifact-capabilities', description: 'Artifact の実行時機能ガイド', source: 'bundled' },
      { name: 'artifact-design', description: 'Artifact のデザインガイド', source: 'bundled' },
      { name: 'artifact-diagramming', description: 'Artifact の図の作り方ガイド', source: 'bundled' },
      { name: 'claude-api', description: 'Claude API / SDK のリファレンス', source: 'bundled' },
      { name: 'clear', description: '空のコンテキストで新しいセッションを始める', source: 'builtin' },
      { name: 'code-review', description: '現在の diff や PR をレビューする', source: 'bundled' },
      { name: 'compact', description: '会話を要約してコンテキストを空ける', source: 'builtin' },
      { name: 'context', description: 'コンテキストの使用状況を表示する', source: 'builtin' },
      { name: 'dataviz', description: 'グラフ・可視化の設計ガイド', source: 'bundled' },
      { name: 'design', description: 'デザインキャンバスを作る', source: 'bundled' },
      { name: 'diff', description: '未コミットの差分を見る（ブリッジのドロワー）', source: 'bridge' },
      { name: 'fewer-permission-prompts', description: '許可プロンプトを減らす allowlist を作る', source: 'bundled' },
      // 同梱スキルの init が組み込みコマンドの init より優先される
      { name: 'init', description: 'CLAUDE.md を初期生成する', source: 'bundled' },
      { name: 'keybindings-help', description: 'キーバインドをカスタマイズする', source: 'bundled' },
      { name: 'loop', description: 'プロンプトを定期実行する', source: 'bundled' },
      { name: 'run', description: 'プロジェクトのアプリを起動して動作確認する', source: 'bundled' },
      { name: 'schedule', description: 'cron 実行のクラウドエージェントを管理する', source: 'bundled' },
      { name: 'security-review', description: 'ブランチの変更をセキュリティ観点でレビューする', source: 'bundled' },
      { name: 'simplify', description: '変更コードの簡素化・重複排除を適用する', source: 'bundled' },
      { name: 'update-config', description: 'settings.json の設定を変更する', source: 'bundled' },
    ]);
  });

  it('cwd が違えば別々にキャッシュする', async () => {
    const claudeDir = join(root, 'claude');
    const a = join(root, 'a');
    const b = join(root, 'b');
    await writeSkill(join(a, '.claude'), 'only-a', 'A のスキル');
    await writeSkill(join(b, '.claude'), 'only-b', 'B のスキル');
    assert.ok(find(await listSlashCommands({ cwd: a, claudeDir }), 'only-a'));
    const fromB = await listSlashCommands({ cwd: b, claudeDir });
    assert.ok(find(fromB, 'only-b'));
    assert.equal(find(fromB, 'only-a'), undefined);
  });

  it('プロジェクトのコマンドは project-command で、ユーザーの同名コマンドより優先する', async () => {
    const claudeDir = join(root, 'claude');
    const cwd = join(root, 'project');
    await writeCommand(claudeDir, 'release.md', '---\ndescription: ユーザー側\n---\n');
    await writeCommand(join(cwd, '.claude'), 'release.md', '---\ndescription: プロジェクト側\n---\n');
    const commands = await listSlashCommands({ cwd, claudeDir });
    assert.deepEqual(find(commands, 'release'), {
      name: 'release',
      description: 'プロジェクト側',
      source: 'project-command',
    });
  });

  it('同名ならユーザーのスキル > ユーザーのコマンド > プラグイン > 同梱スキルの順で残す', async () => {
    const claudeDir = join(root, 'claude');
    const installPath = join(root, 'plugin-cache', 'p');
    await writeSkill(claudeDir, 'dup', 'スキル');
    await writeCommand(claudeDir, 'dup.md', '---\ndescription: コマンド\n---\n');
    // サブディレクトリのコマンド p/run.md は p:run になり、プラグイン p の run と同名になる
    await writeCommand(claudeDir, join('p', 'run.md'), '---\ndescription: ユーザーのコマンド\n---\n');
    await writeCommand(installPath, 'run.md', '---\ndescription: プラグインのコマンド\n---\n');
    await writeCommand(installPath, 'only.md', '---\ndescription: プラグインだけ\n---\n');
    await writePlugins(claudeDir, { 'p@market': [{ installPath }] });
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'dup').source, 'user-skill');
    assert.equal(find(commands, 'p:run').source, 'user-command');
    assert.equal(find(commands, 'p:only').source, 'plugin');
  });

  it('スキルのディレクトリでないもの・SKILL.md の無いディレクトリ・壊れたリンクは候補にしない', async () => {
    const claudeDir = join(root, 'claude');
    await mkdir(join(claudeDir, 'skills', 'empty-dir'), { recursive: true });
    await writeFile(join(claudeDir, 'skills', 'stray.md'), '---\ndescription: ファイル\n---\n');
    await symlink(join(root, 'nowhere'), join(claudeDir, 'skills', 'broken-link'));
    await writeSkill(claudeDir, 'ok', '残る');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'empty-dir'), undefined);
    assert.equal(find(commands, 'stray.md'), undefined);
    assert.equal(find(commands, 'stray'), undefined);
    assert.equal(find(commands, 'broken-link'), undefined);
    assert.equal(find(commands, 'ok').description, '残る');
  });

  it('commands は .md だけを拾い、3 階層より深いものと壊れたリンクは拾わない', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'notes.txt', 'テキスト\n');
    await writeCommand(claudeDir, join('a', 'b', 'deep.md'), '深さ 3\n');
    await writeCommand(claudeDir, join('a', 'b', 'c', 'deeper.md'), '深さ 4\n');
    await symlink(join(root, 'nowhere'), join(claudeDir, 'commands', 'broken.md'));
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(
      commands.find((c) => c.description === 'テキスト'),
      undefined,
    );
    assert.equal(find(commands, 'a:b:deep').description, '深さ 3');
    assert.equal(find(commands, 'a:b:c:deeper'), undefined);
    assert.equal(find(commands, 'broken'), undefined);
  });

  it('description は空白を潰し、120 文字で切る', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'spaces.md', '---\ndescription:   前後   と  途中の   空白  \n---\n');
    await writeCommand(claudeDir, 'long.md', `---\ndescription: ${'あ'.repeat(130)}\n---\n`);
    await writeCommand(claudeDir, 'exact.md', `---\ndescription: ${'い'.repeat(120)}\n---\n`);
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'spaces').description, '前後 と 途中の 空白');
    assert.equal(find(commands, 'long').description, 'あ'.repeat(120));
    assert.equal(find(commands, 'exact').description, 'い'.repeat(120));
  });

  it('description の引用符を外し、対になっていない引用符は残す', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'dq.md', '---\ndescription: "二重引用符"\n---\n');
    await writeCommand(claudeDir, 'sq.md', "---\ndescription: '一重引用符'\n---\n");
    await writeCommand(claudeDir, 'mixed.md', '---\ndescription: "混ざった\'\n---\n');
    await writeCommand(claudeDir, 'inner.md', '---\ndescription: 中に "引用" がある\n---\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'dq').description, '二重引用符');
    assert.equal(find(commands, 'sq').description, '一重引用符');
    assert.equal(find(commands, 'mixed').description, '"混ざった\'');
    assert.equal(find(commands, 'inner').description, '中に "引用" がある');
  });

  it('description のキーは行頭のものだけを見て、コロン前の空白は許す', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'spaced-key.md', '---\ndescription  : 空白つきのキー\n---\n');
    await writeCommand(claudeDir, 'nested.md', '---\nmeta:\n  description: 入れ子\n---\n本文の行\n');
    await writeCommand(claudeDir, 'other-key.md', '---\nshort_description: 別のキー\n---\n本文\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'spaced-key').description, '空白つきのキー');
    assert.equal(find(commands, 'nested').description, '本文の行');
    assert.equal(find(commands, 'other-key').description, '本文');
  });

  it('折り返し記法は | と >+ も扱い、空行を飛ばしてインデントの切れ目で止める', async () => {
    const claudeDir = join(root, 'claude');
    // 空白だけの行は飛ばす
    await writeCommand(claudeDir, 'pipe.md', '---\ndescription: |\n  一行目\n  \n  二行目\nname: x\n  後ろ\n---\n');
    await writeCommand(claudeDir, 'keep.md', '---\ndescription: >+\n  保持\n---\n');
    await writeCommand(claudeDir, 'tab.md', '---\ndescription: >\n\tタブ字下げ\n---\n');
    await writeCommand(claudeDir, 'notfold.md', '---\ndescription: >x\n  続き\n---\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'pipe').description, '一行目 二行目');
    assert.equal(find(commands, 'keep').description, '保持');
    assert.equal(find(commands, 'tab').description, 'タブ字下げ');
    assert.equal(find(commands, 'notfold').description, '>x');
  });

  it('frontmatter に description が無ければ本文の見出し以外の最初の行、無ければ空文字', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'body.md', '---\nname: body\n---\n\n# 見出し\n\n本文の最初\n次の行\n');
    await writeCommand(claudeDir, 'headonly.md', '---\nname: h\n---\n# 見出しだけ\n');
    await writeCommand(claudeDir, 'empty.md', '');
    await writeCommand(claudeDir, 'crlf.md', '---\r\ndescription: 改行が CRLF\r\n---\r\n');
    await writeCommand(claudeDir, 'emptydesc.md', '---\ndescription:\n---\n本文に逃げる\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'body').description, '本文の最初');
    assert.equal(find(commands, 'headonly').description, '');
    assert.equal(find(commands, 'empty').description, '');
    assert.equal(find(commands, 'crlf').description, '改行が CRLF');
    assert.equal(find(commands, 'emptydesc').description, '本文に逃げる');
  });

  it('frontmatter の外側の行は frontmatter の中身として読まない', async () => {
    const claudeDir = join(root, 'claude');
    // 閉じの --- が無ければ frontmatter とみなさず、先頭の --- 自体を本文の最初の行とする
    await writeCommand(claudeDir, 'unclosed.md', '---\ndescription: 閉じていない\n');
    // 先頭が --- でなければ frontmatter ではない
    await writeCommand(claudeDir, 'late.md', '前置き\n---\ndescription: 遅い\n---\n');
    // 閉じの --- の次の行から本文を探す
    await writeCommand(claudeDir, 'after.md', '---\nname: a\n---\n直後の本文\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'unclosed').description, '---');
    assert.equal(find(commands, 'late').description, '前置き');
    assert.equal(find(commands, 'after').description, '直後の本文');
  });

  it('プラグインの commands も plugin:name で拾い、installPath の無いもの・名前の無いものは飛ばす', async () => {
    const claudeDir = join(root, 'claude');
    const installPath = join(root, 'plugin-cache', 'tools');
    await writeCommand(installPath, 'run.md', '---\ndescription: 走らせる\n---\n');
    await writeSkill(join(root, 'plugin-cache', 'noname'), 'hidden', '名前なし');
    await writePlugins(claudeDir, {
      'tools@market': [{ installPath }, { installPath: join(root, 'unused') }],
      'no-path@market': [{ scope: 'user' }],
      'not-array@market': { installPath },
      '@market': [{ installPath: join(root, 'plugin-cache', 'noname') }],
    });
    const commands = await listSlashCommands({ claudeDir });
    assert.deepEqual(find(commands, 'tools:run'), { name: 'tools:run', description: '走らせる', source: 'plugin' });
    assert.equal(find(commands, 'not-array:run'), undefined);
    assert.equal(find(commands, ':hidden'), undefined);
    assert.equal(find(commands, 'hidden'), undefined);
    assert.equal(commands.filter((c) => c.source === 'plugin').length, 1);
  });

  it('配列でない・空のインストール情報は飛ばす', async () => {
    const claudeDir = join(root, 'claude');
    const installPath = join(root, 'plugin-cache', 'tools');
    await writeCommand(installPath, 'run.md', '---\ndescription: 走らせる\n---\n');
    await writePlugins(claudeDir, {
      'indexed@market': { 0: { installPath } },
      'empty@market': [],
    });
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(commands.filter((c) => c.source === 'plugin').length, 0);
  });

  it('読めない .md のコマンドは候補にせず、他の候補は返す', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'secret.md', '---\ndescription: 読めない\n---\n');
    await chmod(join(claudeDir, 'commands', 'secret.md'), 0o000);
    await writeCommand(claudeDir, 'ok.md', '---\ndescription: 読める\n---\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'secret'), undefined);
    assert.equal(find(commands, 'ok').description, '読める');
  });

  it('claudeDir を省くとホームの .claude を読む', async () => {
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await writeSkill(join(root, '.claude'), 'from-home', 'ホームのスキル');
      const commands = await listSlashCommands();
      assert.equal(find(commands, 'from-home').source, 'user-skill');
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it('30 秒経ったらキャッシュを捨てて読み直す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const claudeDir = join(root, 'claude');
      await writeSkill(claudeDir, 'first', '最初');
      await listSlashCommands({ claudeDir });
      await writeSkill(claudeDir, 'second', 'あとから');
      vi.setSystemTime(1_000_000 + 29_999);
      assert.equal(find(await listSlashCommands({ claudeDir }), 'second'), undefined);
      vi.setSystemTime(1_000_000 + 30_000);
      assert.equal(find(await listSlashCommands({ claudeDir }), 'second').description, 'あとから');
    } finally {
      vi.useRealTimers();
    }
  });

  it('本文の行は空白だけの行と字下げした見出しを飛ばし、前後の空白を落とす', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'ws.md', '   \n  # 字下げした見出し\n   本文   \n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'ws').description, '本文');
  });

  it('frontmatter の区切り行は前後の空白を許す', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'pad.md', '---  \ndescription: 区切りに空白\n  ---  \n本文\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'pad').description, '区切りに空白');
  });

  it('値の途中や末尾以外にある記号・引用符はそのまま残す', async () => {
    const claudeDir = join(root, 'claude');
    await writeCommand(claudeDir, 'pipe-end.md', '---\ndescription: a |\n  続き\n---\n');
    await writeCommand(claudeDir, 'quote-tail.md', '---\ndescription: 前置き"引用"\n---\n');
    await writeCommand(claudeDir, 'quote-head.md', '---\ndescription: "引用"後ろ\n---\n');
    const commands = await listSlashCommands({ claudeDir });
    assert.equal(find(commands, 'pipe-end').description, 'a |');
    assert.equal(find(commands, 'quote-tail').description, '前置き"引用"');
    assert.equal(find(commands, 'quote-head').description, '"引用"後ろ');
  });

  it('installed_plugins.json が壊れている・plugins が無いときはプラグインを出さない', async () => {
    const claudeDir = join(root, 'claude');
    await mkdir(join(claudeDir, 'plugins'), { recursive: true });
    for (const content of ['{ not json', 'null', '{"plugins":"x"}', '{"plugins":null}', '{"version":2}']) {
      clearSlashCommandsCache();
      await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), content);
      const commands = await listSlashCommands({ claudeDir });
      assert.equal(commands.filter((c) => c.source === 'plugin').length, 0);
      assert.ok(find(commands, 'clear'));
    }
  });
});
