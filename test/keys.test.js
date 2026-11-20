import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isEnterKey,
  isConfirmShortcut,
  isSubmitAllShortcut,
  vimNavKey,
  isDeleteItemShortcut,
  halfPageScrollKey,
  tabNavKey,
  isFocusInputShortcut,
  isShareModeShortcut,
  isPickModeShortcut,
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

describe('keys: isFocusInputShortcut（Alt+I）', () => {
  it('Alt+I は真', () => assert.equal(isFocusInputShortcut(ev({ key: 'i', code: 'KeyI', altKey: true })), true));
  it('レイアウトで key が別文字でも code（KeyI）で拾う', () =>
    assert.equal(isFocusInputShortcut(ev({ key: 'ˆ', code: 'KeyI', altKey: true })), true));
  it('Ctrl+I（Alt なし）は偽', () =>
    assert.equal(isFocusInputShortcut(ev({ key: 'i', code: 'KeyI', ctrlKey: true })), false));
  it('Alt+Shift+I は偽', () =>
    assert.equal(isFocusInputShortcut(ev({ key: 'i', code: 'KeyI', altKey: true, shiftKey: true })), false));
  it('I 単体（Alt なし）は偽', () => assert.equal(isFocusInputShortcut(ev({ key: 'i', code: 'KeyI' })), false));
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

describe('keys: isShareModeShortcut（Alt+Shift+S）', () => {
  it('Alt+Shift+S は真', () =>
    assert.equal(isShareModeShortcut(ev({ key: 'S', code: 'KeyS', altKey: true, shiftKey: true })), true));
  it('レイアウトで key が別文字でも code（KeyS）で拾う', () =>
    assert.equal(isShareModeShortcut(ev({ key: 'Í', code: 'KeyS', altKey: true, shiftKey: true })), true));
  it('Shift なしの Alt+S は偽', () =>
    assert.equal(isShareModeShortcut(ev({ key: 's', code: 'KeyS', altKey: true })), false));
  it('Ctrl 併用は偽', () =>
    assert.equal(
      isShareModeShortcut(ev({ key: 'S', code: 'KeyS', altKey: true, shiftKey: true, ctrlKey: true })),
      false,
    ));
  it('null は偽', () => assert.equal(isShareModeShortcut(null), false));
});

describe('keys: isPickModeShortcut（Alt+R）', () => {
  it('Alt+R は真', () => assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true })), true));
  it('code が取れなくても key の r / R で拾う（大文字小文字は問わない）', () => {
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: '', altKey: true })), true);
    assert.equal(isPickModeShortcut(ev({ key: 'R', code: '', altKey: true })), true);
  });
  it('Alt+R 以外のキー・key を持たないイベントは偽', () => {
    assert.equal(isPickModeShortcut(ev({ key: 'x', code: 'KeyX', altKey: true })), false);
    assert.equal(isPickModeShortcut({ code: 'KeyX', altKey: true }), false);
  });
  it('Ctrl / Cmd 併用・Alt なし・null は偽', () => {
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true, ctrlKey: true })), false);
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true, metaKey: true })), false);
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR' })), false);
    assert.equal(isPickModeShortcut(null), false);
  });
});

describe('keys: Alt 系ショートカットの key による判定', () => {
  it('Alt+I は code が取れなくても key の i / I で拾い、他のキーは偽', () => {
    assert.equal(isFocusInputShortcut(ev({ key: 'i', code: '', altKey: true })), true);
    assert.equal(isFocusInputShortcut(ev({ key: 'I', code: '', altKey: true })), true);
    assert.equal(isFocusInputShortcut(ev({ key: 'x', code: 'KeyX', altKey: true })), false);
    assert.equal(isFocusInputShortcut({ code: 'KeyX', altKey: true }), false);
  });
  it('Alt+Shift+S は code が取れなくても key の s / S で拾い、他のキーは偽', () => {
    assert.equal(isShareModeShortcut(ev({ key: 's', code: '', altKey: true, shiftKey: true })), true);
    assert.equal(isShareModeShortcut(ev({ key: 'S', code: '', altKey: true, shiftKey: true })), true);
    assert.equal(isShareModeShortcut(ev({ key: 'x', code: 'KeyX', altKey: true, shiftKey: true })), false);
    assert.equal(isShareModeShortcut({ code: 'KeyX', altKey: true, shiftKey: true }), false);
  });
});

describe('keys: vimNavKey の code / key それぞれでの判定', () => {
  const alt = (code, key) => ({ key, code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
  it('key が別文字でも code（KeyH/J/K/L）だけで 4 方向とも拾う', () => {
    assert.equal(vimNavKey(alt('KeyH', '˙')), 'ArrowLeft');
    assert.equal(vimNavKey(alt('KeyJ', '∆')), 'ArrowDown');
    assert.equal(vimNavKey(alt('KeyK', '˚')), 'ArrowUp');
    assert.equal(vimNavKey(alt('KeyL', '¬')), 'ArrowRight');
  });
  it('code が取れなくても key（h/j/k/l）だけで 4 方向とも拾う', () => {
    assert.equal(vimNavKey(alt('', 'h')), 'ArrowLeft');
    assert.equal(vimNavKey(alt('', 'j')), 'ArrowDown');
    assert.equal(vimNavKey(alt('', 'k')), 'ArrowUp');
    assert.equal(vimNavKey(alt('', 'l')), 'ArrowRight');
  });
  it('key が大文字（CapsLock 等）でも拾う', () => {
    assert.equal(vimNavKey(alt('', 'H')), 'ArrowLeft');
  });
  it('key を持たないイベントは null', () => {
    assert.equal(vimNavKey({ code: 'KeyX', altKey: true }), null);
  });
});

describe('keys: halfPageScrollKey の code / key それぞれでの判定', () => {
  const ctrl = (code, key) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  it('key が別文字でも code（KeyD / KeyU）で拾う', () => {
    assert.equal(halfPageScrollKey(ctrl('KeyD', '∂')), 'down');
    assert.equal(halfPageScrollKey(ctrl('KeyU', '¨')), 'up');
  });
  it('code が取れなくても key（d / u、大文字も）で拾う', () => {
    assert.equal(halfPageScrollKey(ctrl('', 'd')), 'down');
    assert.equal(halfPageScrollKey(ctrl('', 'D')), 'down');
    assert.equal(halfPageScrollKey(ctrl('', 'u')), 'up');
    assert.equal(halfPageScrollKey(ctrl('', 'U')), 'up');
  });
  it('D / U 以外のキー・key を持たないイベントは null', () => {
    assert.equal(halfPageScrollKey(ctrl('KeyX', 'x')), null);
    assert.equal(halfPageScrollKey({ code: 'KeyX', ctrlKey: true }), null);
  });
});

describe('keys: tabNavKey の code / key それぞれでの判定', () => {
  const alt = (code, key, shift = false) => ({
    key,
    code,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: shift,
  });
  it('Alt+Shift+J / K は key が別文字でも code で拾う', () => {
    assert.deepEqual(tabNavKey(alt('KeyJ', 'Ô', true)), { type: 'next' });
    assert.deepEqual(tabNavKey(alt('KeyK', '', true)), { type: 'prev' });
  });
  it('Alt+Shift+J / K は code が取れなくても key（大小文字）で拾う', () => {
    assert.deepEqual(tabNavKey(alt('', 'J', true)), { type: 'next' });
    assert.deepEqual(tabNavKey(alt('', 'j', true)), { type: 'next' });
    assert.deepEqual(tabNavKey(alt('', 'K', true)), { type: 'prev' });
    assert.deepEqual(tabNavKey(alt('', 'k', true)), { type: 'prev' });
  });
  it('Alt+Shift+他のキー・key を持たないイベントは null', () => {
    assert.equal(tabNavKey(alt('KeyX', 'X', true)), null);
    assert.equal(tabNavKey({ code: 'KeyX', altKey: true, shiftKey: true }), null);
  });
  it('Alt+数字は key が記号（Mac の Option 併用等）でも code の数字で拾う', () => {
    assert.deepEqual(tabNavKey(alt('Digit3', '£')), { type: 'index', n: 3 });
    assert.deepEqual(tabNavKey(alt('Numpad7', '¶')), { type: 'index', n: 7 });
  });
  it('code が取れなくても key の数字 1 文字で拾う', () => {
    assert.deepEqual(tabNavKey(alt('', '5')), { type: 'index', n: 5 });
    assert.deepEqual(tabNavKey({ key: '5', altKey: true }), { type: 'index', n: 5 });
  });
  it('数字 1 文字ちょうどでない code / key は null', () => {
    assert.equal(tabNavKey(alt('XDigit3', 'a')), null);
    assert.equal(tabNavKey(alt('Digit3x', 'a')), null);
    assert.equal(tabNavKey(alt('', '13')), null);
    assert.equal(tabNavKey(alt('', '3a')), null);
    assert.equal(tabNavKey({ code: 'KeyX', altKey: true }), null);
  });
});
