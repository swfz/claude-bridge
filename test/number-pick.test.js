import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_PICK_STATE, keyToPickAction, pickReducer, resolveTarget } from '../client/src/utils/numberPick.js';
import { isPickModeShortcut } from '../client/src/utils/keys.js';

const ev = (o) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
// 1 段目だけ / 2 段目に入った state を作るヘルパー
const one = (buffer) => ({ active: true, buffer, sub: null });
const two = (buffer, sub) => ({ active: true, buffer, sub });

describe('numberPick: pickReducer', () => {
  it('start でピックモードに入り buffer と sub は空', () => {
    assert.deepEqual(pickReducer({ active: false, buffer: '9', sub: '3' }, { type: 'start' }), one(''));
  });

  it('digit は buffer に追記し、非アクティブからでも始まる', () => {
    const s1 = pickReducer(INITIAL_PICK_STATE, { type: 'digit', digit: '1' });
    assert.deepEqual(s1, one('1'));
    assert.deepEqual(pickReducer(s1, { type: 'digit', digit: '2' }), one('12'));
  });

  it('先頭の 0 単独も許可する', () => {
    assert.deepEqual(pickReducer(INITIAL_PICK_STATE, { type: 'digit', digit: '0' }), one('0'));
  });

  it('6 桁を超える digit は無視する', () => {
    const s = pickReducer(one('123456'), { type: 'digit', digit: '7' });
    assert.equal(s.buffer, '123456');
  });

  it('backspace は末尾を消し、空なら変化しない', () => {
    assert.deepEqual(pickReducer(one('12'), { type: 'backspace' }), one('1'));
    const empty = one('');
    assert.deepEqual(pickReducer(empty, { type: 'backspace' }), empty);
  });

  it('step は 1〜max にクランプする', () => {
    assert.equal(pickReducer(one('3'), { type: 'step', delta: 1, max: 10 }).buffer, '4');
    assert.equal(pickReducer(one('1'), { type: 'step', delta: -1, max: 10 }).buffer, '1');
    assert.equal(pickReducer(one('10'), { type: 'step', delta: 1, max: 10 }).buffer, '10');
  });

  it('buffer が空の step は方向に関わらず 1 に着地する（最新／先頭から始める）', () => {
    assert.equal(pickReducer(one(''), { type: 'step', delta: 1, max: 7 }).buffer, '1');
    assert.equal(pickReducer(one(''), { type: 'step', delta: -1, max: 7 }).buffer, '1');
  });

  it('max が 0 の step は何もしない', () => {
    const s = one('');
    assert.deepEqual(pickReducer(s, { type: 'step', delta: 1, max: 0 }), s);
  });

  it('set は番号を直接置き換え、max にクランプする（2 段目なら sub）', () => {
    assert.equal(pickReducer(one('2'), { type: 'set', value: 5, max: 10 }).buffer, '5');
    assert.equal(pickReducer(one('2'), { type: 'set', value: 99, max: 10 }).buffer, '10');
    assert.equal(pickReducer(two('3', '1'), { type: 'set', value: 4, max: 10 }).sub, '4');
    assert.deepEqual(pickReducer(one('2'), { type: 'set', value: 5, max: 0 }), one('2'));
  });

  it('clear で初期状態に戻る', () => {
    assert.deepEqual(pickReducer({ active: true, buffer: '42', sub: '7' }, { type: 'clear' }), INITIAL_PICK_STATE);
  });

  it('未知の action では state をそのまま返す', () => {
    const s = one('5');
    assert.equal(pickReducer(s, { type: 'nope' }), s);
  });
});

describe('numberPick: pickReducer の 2 段目（sub）', () => {
  it('sep は buffer があるときだけ 2 段目に入る', () => {
    assert.deepEqual(pickReducer(one('3'), { type: 'sep' }), two('3', ''));
    assert.deepEqual(pickReducer(one(''), { type: 'sep' }), one(''));
  });

  it('2 段目で sep をもう一度打っても打鍵済みの行番号は消えない', () => {
    assert.deepEqual(pickReducer(two('3', '12'), { type: 'sep' }), two('3', '12'));
  });

  it('2 段目の digit は sub に追記され buffer は変わらない', () => {
    const s = pickReducer(two('3', ''), { type: 'digit', digit: '1' });
    assert.deepEqual(s, two('3', '1'));
    assert.deepEqual(pickReducer(s, { type: 'digit', digit: '2' }), two('3', '12'));
  });

  it('2 段目でも 6 桁で打ち切る', () => {
    assert.deepEqual(pickReducer(two('3', '123456'), { type: 'digit', digit: '7' }), two('3', '123456'));
  });

  it('2 段目の backspace は sub を削り、空なら 1 段目に戻る', () => {
    assert.deepEqual(pickReducer(two('3', '12'), { type: 'backspace' }), two('3', '1'));
    assert.deepEqual(pickReducer(two('3', '1'), { type: 'backspace' }), two('3', ''));
    assert.deepEqual(pickReducer(two('3', ''), { type: 'backspace' }), one('3'));
  });

  it('2 段目の step は sub を max の範囲で動かす', () => {
    assert.deepEqual(pickReducer(two('3', '4'), { type: 'step', delta: 1, max: 10 }), two('3', '5'));
    assert.deepEqual(pickReducer(two('3', '10'), { type: 'step', delta: 1, max: 10 }), two('3', '10'));
    assert.deepEqual(pickReducer(two('3', ''), { type: 'step', delta: 1, max: 10 }), two('3', '1'));
    // 2 段目も未入力からの step は方向に関わらず先頭（1 行目）に着地する
    assert.deepEqual(pickReducer(two('3', ''), { type: 'step', delta: -1, max: 10 }), two('3', '1'));
  });

  it('start / clear は sub も初期化する', () => {
    assert.deepEqual(pickReducer(two('3', '12'), { type: 'start' }), one(''));
    assert.deepEqual(pickReducer(two('3', '12'), { type: 'clear' }), INITIAL_PICK_STATE);
  });
});

describe('numberPick: resolveTarget', () => {
  it('buffer が空なら null', () => assert.equal(resolveTarget('', 10), null));
  it('max が 0 なら null', () => assert.equal(resolveTarget('3', 0), null));
  it('範囲内はそのまま', () => assert.equal(resolveTarget('3', 10), 3));
  it('範囲外は max に丸める', () => assert.equal(resolveTarget('999', 10), 10));
  it('0 は 1 に丸める', () => assert.equal(resolveTarget('0', 10), 1));
});

describe('numberPick: keyToPickAction', () => {
  it('数字は digit', () => assert.deepEqual(keyToPickAction(ev({ key: '5' })), { type: 'digit', digit: '5' }));
  it('Backspace は backspace', () =>
    assert.deepEqual(keyToPickAction(ev({ key: 'Backspace' })), { type: 'backspace' }));
  it('. は sep', () => assert.deepEqual(keyToPickAction(ev({ key: '.' })), { type: 'sep' }));
  it('ArrowUp は delta -1（番号を減らす）', () =>
    assert.deepEqual(keyToPickAction(ev({ key: 'ArrowUp' }), { max: 9 }), { type: 'step', delta: -1, max: 9 }));
  it('ArrowDown は delta +1', () =>
    assert.deepEqual(keyToPickAction(ev({ key: 'ArrowDown' }), { max: 9 }), { type: 'step', delta: 1, max: 9 }));
  it('修飾キー付きは null', () => {
    assert.equal(keyToPickAction(ev({ key: '5', ctrlKey: true })), null);
    assert.equal(keyToPickAction(ev({ key: '5', metaKey: true })), null);
    assert.equal(keyToPickAction(ev({ key: 'ArrowUp', altKey: true })), null);
  });
  it('対象外のキーは null', () => assert.equal(keyToPickAction(ev({ key: 'a' })), null));
});

describe('keys: isPickModeShortcut', () => {
  it('Alt+R は真', () => assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true })), true));
  it('レイアウトで key が別文字でも code が KeyR なら真', () =>
    assert.equal(isPickModeShortcut(ev({ key: '®', code: 'KeyR', altKey: true })), true));
  it('Alt なしは偽', () => assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR' })), false));
  it('Ctrl / Cmd 併用は偽', () => {
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true, ctrlKey: true })), false);
    assert.equal(isPickModeShortcut(ev({ key: 'r', code: 'KeyR', altKey: true, metaKey: true })), false);
  });
  it('別のキーは偽', () => assert.equal(isPickModeShortcut(ev({ key: 'a', code: 'KeyA', altKey: true })), false));
});
