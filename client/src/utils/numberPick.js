// 「数字キーで対象を選ぶ」ピックモードの状態遷移（純粋関数）。
// プレビューの行ピック（PreviewDrawer）とチャットのメッセージピック（ChatView）で共用する。
// state = { active: ピック中か, buffer: 1 段目の数字列, sub: 2 段目の数字列（null なら 1 段目） }
//
// 2 段目はチャットの「メッセージ番号 . 行番号」用。`.` で入り、Backspace で 1 段目に戻る。

export const INITIAL_PICK_STATE = { active: false, buffer: '', sub: null };

// 6 桁あれば行数・メッセージ数としては十分。打ち間違いで無限に伸びないよう打ち切る
const MAX_DIGITS = 6;

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

export function pickReducer(state = INITIAL_PICK_STATE, action) {
  switch (action?.type) {
    case 'start':
      return { active: true, buffer: '', sub: null };
    case 'sep': {
      // 1 段目が空のまま 2 段目には入れない。既に 2 段目なら打鍵済みの数字を壊さない
      if (!state.buffer) return state;
      if (state.sub != null) return state;
      return { ...state, active: true, sub: '' };
    }
    case 'digit': {
      if (!/^[0-9]$/.test(action.digit)) return state;
      if (state.sub != null) {
        if (state.sub.length >= MAX_DIGITS) return state;
        return { ...state, active: true, sub: state.sub + action.digit };
      }
      if (state.buffer.length >= MAX_DIGITS) return { ...state, active: true, buffer: state.buffer };
      return { ...state, active: true, buffer: state.buffer + action.digit };
    }
    case 'backspace': {
      if (state.sub != null) {
        // 2 段目が空なら 1 段目へ戻る（メッセージ番号は消さない）
        if (!state.sub) return { ...state, sub: null };
        return { ...state, sub: state.sub.slice(0, -1) };
      }
      if (!state.buffer) return state;
      return { ...state, buffer: state.buffer.slice(0, -1) };
    }
    case 'step': {
      const max = Math.floor(action.max || 0);
      if (max < 1) return state;
      const delta = action.delta || 0;
      // 未入力から上下キーで動かし始めたときは、方向に関わらず 1（チャットなら最新・行なら先頭）に着地させる。
      // 上方向で末尾（一番古いメッセージや最終行）に飛ばされると、そこから戻る手間の方が大きい
      const cur = state.sub != null ? state.sub : state.buffer;
      const next = cur === '' ? 1 : clamp(Number(cur) + delta, 1, max);
      if (state.sub != null) return { ...state, active: true, sub: String(next) };
      return { ...state, active: true, buffer: String(next) };
    }
    case 'set': {
      // 番号を直接指定する（Ctrl+D/U の半画面ジャンプ等）。2 段目に入っていれば sub を書き換える
      const max = Math.floor(action.max || 0);
      if (max < 1 || !Number.isFinite(action.value)) return state;
      const v = String(clamp(Math.floor(action.value), 1, max));
      if (state.sub != null) return { ...state, active: true, sub: v };
      return { ...state, active: true, buffer: v };
    }
    case 'clear':
      return INITIAL_PICK_STATE;
    default:
      return state;
  }
}

// 打鍵中の数字列を「1〜max の対象番号」に解決する。未入力・対象なしは null
export function resolveTarget(buffer, max) {
  const limit = Math.floor(max || 0);
  if (!buffer || limit < 1) return null;
  const n = Number(buffer);
  if (!Number.isFinite(n)) return null;
  return clamp(n, 1, limit);
}

// keydown イベントをピックモードの action に変換する（該当しなければ null）。
// 修飾キー付きはアプリ側のショートカットなので触らない。
// 矢印は「ArrowUp = 番号を減らす」で返すだけにし、番号の並び（上が大きいか小さいか）に
// 応じた反転は呼び出し側（useNumberPick の invertArrows）に任せる。
export function keyToPickAction(e, { max = 0 } = {}) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key;
  if (/^[0-9]$/.test(key)) return { type: 'digit', digit: key };
  if (key === '.') return { type: 'sep' };
  if (key === 'Backspace') return { type: 'backspace' };
  if (key === 'ArrowUp') return { type: 'step', delta: -1, max };
  if (key === 'ArrowDown') return { type: 'step', delta: 1, max };
  return null;
}
