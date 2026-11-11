import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
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
});

describe('isVimEditorEnabled', () => {
  beforeEach(() => clearVimEditorCache());

  it('reads editorMode from ~/.claude/settings.json', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'vim-mode-'));
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home }), true);
  });

  it('falls back to ~/.claude.json and treats missing files as disabled', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'vim-mode-'));
    assert.equal(await isVimEditorEnabled({ home }), false);
    clearVimEditorCache();
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ editorMode: 'vim' }));
    assert.equal(await isVimEditorEnabled({ home }), true);
  });
});
