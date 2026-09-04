import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEnterKey,
  isConfirmShortcut,
  isSubmitAllShortcut,
  vimNavKey,
  isDeleteItemShortcut,
  halfPageScrollKey,
  tabNavKey,
} from '../client/src/utils/keys.js';

const ev = (o) => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...o });

describe('keys: isEnterKey', () => {
  it('key が Enter なら真', () => assert.equal(isEnterKey(ev({ key: 'Enter' })), true));
  it('IME 経由で key が Process でも code が Enter なら真', () =>
    assert.equal(isEnterKey(ev({ key: 'Process', code: 'Enter' })), true));
  it('テンキーの Enter も真', () => assert.equal(isEnterKey(ev({ key: 'Process', code: 'NumpadEnter' })), true));
  it('変換中（isComposing）の Enter は偽', () =>
    assert.equal(isEnterKey(ev({ key: 'Enter', code: 'Enter', isComposing: true })), false));
  it('Enter 以外は偽', () => assert.equal(isEnterKey(ev({ key: 'a', code: 'KeyA' })), false));
});

describe('keys: レビューのショートカット', () => {
  it('Ctrl+Enter は確定（次の欄）で、一括送信ではない', () => {
    const e = ev({ key: 'Enter', ctrlKey: true });
    assert.equal(isConfirmShortcut(e), true);
    assert.equal(isSubmitAllShortcut(e), false);
  });
  it('Cmd+Shift+Enter は一括送信で、確定ではない', () => {
    const e = ev({ key: 'Enter', metaKey: true, shiftKey: true });
    assert.equal(isSubmitAllShortcut(e), true);
    assert.equal(isConfirmShortcut(e), false);
  });
  it('修飾キーなしの Enter はどちらでもない（改行）', () => {
    const e = ev({ key: 'Enter' });
    assert.equal(isConfirmShortcut(e), false);
    assert.equal(isSubmitAllShortcut(e), false);
  });
  it('Shift+Enter だけ（Ctrl なし）もどちらでもない', () => {
    const e = ev({ key: 'Enter', shiftKey: true });
    assert.equal(isConfirmShortcut(e), false);
    assert.equal(isSubmitAllShortcut(e), false);
  });
});

describe('keys: isDeleteItemShortcut', () => {
  it('Ctrl+Shift+Backspace は真', () =>
    assert.equal(isDeleteItemShortcut(ev({ key: 'Backspace', ctrlKey: true, shiftKey: true })), true));
  it('Cmd+Shift+Delete も真', () =>
    assert.equal(isDeleteItemShortcut(ev({ key: 'Delete', metaKey: true, shiftKey: true })), true));
  it('Ctrl+Backspace 単体（単語削除）は偽', () =>
    assert.equal(isDeleteItemShortcut(ev({ key: 'Backspace', ctrlKey: true })), false));
  it('Shift+Backspace だけ（Ctrl/Cmd なし）は偽', () =>
    assert.equal(isDeleteItemShortcut(ev({ key: 'Backspace', shiftKey: true })), false));
  it('Ctrl+Shift+Enter は偽', () =>
    assert.equal(isDeleteItemShortcut(ev({ key: 'Enter', ctrlKey: true, shiftKey: true })), false));
});

describe('keys: vimNavKey（Alt+HJKL → 矢印）', () => {
  const alt = (code, key) => ({ key, code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
  it('Alt+H/J/K/L を ← ↓ ↑ → に対応づける', () => {
    assert.equal(vimNavKey(alt('KeyH', 'h')), 'ArrowLeft');
    assert.equal(vimNavKey(alt('KeyJ', 'j')), 'ArrowDown');
    assert.equal(vimNavKey(alt('KeyK', 'k')), 'ArrowUp');
    assert.equal(vimNavKey(alt('KeyL', 'l')), 'ArrowRight');
  });
  it('レイアウトで key が別文字（Mac の Option 併用等）でも code で拾う', () => {
    assert.equal(vimNavKey(alt('KeyJ', '∆')), 'ArrowDown');
  });
  it('Alt なし・Ctrl/Cmd 混在・他のキーは null', () => {
    assert.equal(vimNavKey({ key: 'j', code: 'KeyJ', altKey: false }), null);
    assert.equal(vimNavKey({ key: 'j', code: 'KeyJ', altKey: true, ctrlKey: true }), null);
    assert.equal(vimNavKey(alt('KeyR', 'r')), null);
  });
});

describe('keys: halfPageScrollKey（Ctrl+D / Ctrl+U）', () => {
  const ctrl = (code, key) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  it('Ctrl+D は down、Ctrl+U は up', () => {
    assert.equal(halfPageScrollKey(ctrl('KeyD', 'd')), 'down');
    assert.equal(halfPageScrollKey(ctrl('KeyU', 'u')), 'up');
  });
  it('Shift や Alt が混ざる・Ctrl なしは null', () => {
    assert.equal(halfPageScrollKey({ ...ctrl('KeyD', 'D'), shiftKey: true }), null);
    assert.equal(halfPageScrollKey({ key: 'd', code: 'KeyD', ctrlKey: false }), null);
  });
});

describe('keys: tabNavKey（Alt+Shift+J/K・Alt+数字）', () => {
  const alt = (code, key, shift = false) => ({
    key,
    code,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: shift,
  });
  it('Alt+Shift+J で次、Alt+Shift+K で前', () => {
    assert.deepEqual(tabNavKey(alt('KeyJ', 'J', true)), { type: 'next' });
    assert.deepEqual(tabNavKey(alt('KeyK', 'K', true)), { type: 'prev' });
  });
  it('Alt+数字は index（0 はホーム用）。テンキーも同じ', () => {
    assert.deepEqual(tabNavKey(alt('Digit3', '3')), { type: 'index', n: 3 });
    assert.deepEqual(tabNavKey(alt('Numpad0', '0')), { type: 'index', n: 0 });
  });
  it('Alt なし・Ctrl 混在・Shift なしの J は null（Alt+J はピックの移動）', () => {
    assert.equal(tabNavKey({ key: '3', code: 'Digit3', altKey: false }), null);
    assert.equal(tabNavKey({ ...alt('Digit3', '3'), ctrlKey: true }), null);
    assert.equal(tabNavKey(alt('KeyJ', 'j')), null);
  });
});
