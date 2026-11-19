import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { isVimNormalMode, isVimEditorEnabled, clearVimEditorCache } from '../server/vim-mode.js';

const RULE = '─'.repeat(60);

describe('isVimNormalMode', () => {
  it('is true when the footer has no INSERT indicator', () => {
    const screen = ['● 応答', RULE, '❯ ', RULE, '  0m | $1', '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');
    assert.equal(isVimNormalMode(screen), true);
  });

  it('is false in INSERT mode', () => {
    const screen = ['● 応答', RULE, '❯ hello', RULE, '  -- INSERT -- ⏵⏵ auto mode on'].join('\n');
    assert.equal(isVimNormalMode(screen), false);
  });

  it('is false when the input box is not visible (choice prompt etc.)', () => {
    const screen = [RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n');
    assert.equal(isVimNormalMode(screen), false);
  });

  it('is false when there is no footer', () => {
    assert.equal(isVimNormalMode([RULE, '❯ ', RULE].join('\n')), false);
    assert.equal(isVimNormalMode(''), false);
  });

  it('is false when the footer is only whitespace', () => {
    assert.equal(isVimNormalMode([RULE, '❯ ', RULE, '    ', '  '].join('\n')), false);
  });

  it('looks at the last two rules (the input box), not rules earlier in the response', () => {
    const screen = [RULE, '表の中身', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(isVimNormalMode(screen), true);
  });

  it('accepts indented rules', () => {
    const screen = ['  ' + RULE, '❯ ', '  ' + RULE, '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(isVimNormalMode(screen), true);
  });

  it('does not treat a short line of 9 box characters as a rule', () => {
    const short = '─'.repeat(9);
    assert.equal(isVimNormalMode([short, '❯ ', short, '  ⏵⏵ auto mode on'].join('\n')), false);
    assert.equal(isVimNormalMode(['─'.repeat(10), '❯ ', '─'.repeat(10), '  footer'].join('\n')), true);
  });

  it('needs two rules around the prompt line', () => {
    assert.equal(isVimNormalMode(['❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n')), false);
  });

  it('requires the prompt mark at the start of a line inside the box', () => {
    assert.equal(isVimNormalMode([RULE, '  ❯ 1. Yes', RULE, '  footer'].join('\n')), false);
  });

  it('looks for the INSERT indicator line by line in the footer', () => {
    assert.equal(isVimNormalMode([RULE, '❯ ', RULE, '  -- INS', 'ERT --'].join('\n')), true);
  });

  it('treats a missing screen as not NORMAL', () => {
    assert.equal(isVimNormalMode(undefined), false);
    assert.equal(isVimNormalMode(null), false);
  });
});

describe('isVimEditorEnabled', () => {
  const homes = [];
  const makeHome = async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'vim-mode-'));
    homes.push(home);
    return home;
  };
  beforeEach(() => clearVimEditorCache());
  afterEach(async () => {
    while (homes.length) await rm(homes.pop(), { recursive: true, force: true });
  });

  it('reads editorMode from ~/.claude/settings.json', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home }), true);
  });

  it('falls back to ~/.claude.json and treats missing files as disabled', async () => {
    const home = await makeHome();
    assert.equal(await isVimEditorEnabled({ home }), false);
    clearVimEditorCache();
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home }), true);
  });

  it('caches the result for 30 seconds per home directory', async () => {
    const home = await makeHome();
    assert.equal(await isVimEditorEnabled({ home, now: 1000 }), false);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    // 30 秒未満はキャッシュのまま
    assert.equal(await isVimEditorEnabled({ home, now: 30_999 }), false);
    // 30 秒経つと読み直す
    assert.equal(await isVimEditorEnabled({ home, now: 31_000 }), true);
  });

  it('does not reuse the cache of another home directory', async () => {
    const homeA = await makeHome();
    const homeB = await makeHome();
    await writeFile(path.join(homeB, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home: homeA, now: 1000 }), false);
    assert.equal(await isVimEditorEnabled({ home: homeB, now: 1001 }), true);
  });

  it('clearVimEditorCache forces a re-read', async () => {
    const home = await makeHome();
    assert.equal(await isVimEditorEnabled({ home, now: 1000 }), false);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    clearVimEditorCache();
    assert.equal(await isVimEditorEnabled({ home, now: 1001 }), true);
  });

  it('checks ~/.claude.json when settings.json has another editorMode or is broken', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ editorMode: 'normal' }));
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home, now: 1000 }), true);
    clearVimEditorCache();
    await writeFile(path.join(home, '.claude', 'settings.json'), '{broken');
    assert.equal(await isVimEditorEnabled({ home, now: 1000 }), true);
  });

  it('is false when editorMode is not exactly "vim"', async () => {
    const home = await makeHome();
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'emacs' }));
    assert.equal(await isVimEditorEnabled({ home, now: 1000 }), false);
  });
});
