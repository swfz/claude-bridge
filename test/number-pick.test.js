import { describe, it } from 'vitest';
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
  it('数字で始まる・終わるだけの複数文字のキーは数字扱いしない', () => {
    assert.equal(keyToPickAction(ev({ key: 'F1' })), null);
    assert.equal(keyToPickAction(ev({ key: '1a' })), null);
  });
});

describe('pickReducer: 境界と不正な入力', () => {
  it('初期 state はピックしていない空の状態', () => {
    assert.deepEqual(INITIAL_PICK_STATE, { active: false, buffer: '', sub: null });
    assert.deepEqual(pickReducer(undefined, { type: 'unknown' }), { active: false, buffer: '', sub: null });
  });
  it('action が無ければ state をそのまま返す', () => {
    const s = one('3');
    assert.equal(pickReducer(s, undefined), s);
  });
  it('1 文字の数字以外の digit は無視する', () => {
    const s = one('1');
    assert.equal(pickReducer(s, { type: 'digit', digit: 'x' }), s);
    assert.equal(pickReducer(s, { type: 'digit', digit: 'a1' }), s);
    assert.equal(pickReducer(s, { type: 'digit', digit: '1a' }), s);
    assert.equal(pickReducer(s, { type: 'digit', digit: '12' }), s);
  });
  it('桁数の上限に達していてもピック中になる（数字は増えない）', () => {
    const s = { active: false, buffer: '123456', sub: null };
    assert.deepEqual(pickReducer(s, { type: 'digit', digit: '7' }), { active: true, buffer: '123456', sub: null });
  });
  it('空の 1 段目で Backspace しても同じ state を返す（再描画させない）', () => {
    const s = one('');
    assert.equal(pickReducer(s, { type: 'backspace' }), s);
  });
  it('Backspace は末尾の 1 桁だけ消す', () => {
    assert.equal(pickReducer(one('123'), { type: 'backspace' }).buffer, '12');
  });
  it('step は max が 1 でも 1 に着地する', () => {
    assert.equal(pickReducer(one(''), { type: 'step', delta: 1, max: 1 }).buffer, '1');
  });
  it('未入力からの step は移動量に関わらず 1 に着地する', () => {
    assert.equal(pickReducer(one(''), { type: 'step', delta: 3, max: 9 }).buffer, '1');
    assert.equal(pickReducer(two('2', ''), { type: 'step', delta: 3, max: 9 }).sub, '1');
  });
  it('step はピックしていない state からでもピック中にする', () => {
    assert.deepEqual(pickReducer({ active: false, buffer: '2', sub: null }, { type: 'step', delta: 1, max: 9 }), {
      active: true,
      buffer: '3',
      sub: null,
    });
  });
  it('set は max が 1 なら 1 に丸める', () => {
    assert.equal(pickReducer(one(''), { type: 'set', value: 5, max: 1 }).buffer, '1');
  });
  it('set はピックしていない state からでもピック中にする（1 段目・2 段目とも）', () => {
    assert.deepEqual(pickReducer({ active: false, buffer: '', sub: null }, { type: 'set', value: 4, max: 9 }), {
      active: true,
      buffer: '4',
      sub: null,
    });
    assert.deepEqual(pickReducer({ active: false, buffer: '2', sub: '1' }, { type: 'set', value: 4, max: 9 }), {
      active: true,
      buffer: '2',
      sub: '4',
    });
  });
});

describe('resolveTarget: 境界と不正な入力', () => {
  it('max が 1 なら 1 に丸める', () => assert.equal(resolveTarget('3', 1), 1));
  it('数値にならない入力は null', () => assert.equal(resolveTarget('abc', 5), null));
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
