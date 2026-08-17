// 選択肢プロンプトを操作するためのキー表現。
//
// クライアントからは抽象キー名（"1"〜"9" / "Enter" / "Escape" / "Tab" ...）だけを受け取り、
// tmux（send-keys のキー名）と内蔵 PTY（端末のエスケープシーケンス）で変換して送る。
// 任意の文字列をシェルや PTY に流さないためのホワイトリストも兼ねる。

// 内蔵 PTY へ書き込むバイト列
export const PTY_KEY_SEQUENCES = {
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  BTab: "\x1b[Z",
  Space: " ",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
};

export function isValidChoiceKey(key) {
  if (typeof key !== "string") return false;
  return /^[0-9]$/.test(key) || Object.hasOwn(PTY_KEY_SEQUENCES, key);
}

export function assertValidChoiceKeys(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (!isValidChoiceKey(key)) {
      throw new Error(`Invalid choice key: ${key}`);
    }
  }
  return list;
}

// 抽象キー名 → 内蔵 PTY へ書き込む文字列
export function toPtySequence(key) {
  return /^[0-9]$/.test(key) ? key : PTY_KEY_SEQUENCES[key];
}

// TUI の再描画より速く続けて送ると入力を取りこぼすので、キーの間に少し待つ
export const CHOICE_KEY_DELAY_MS = 90;

const MAX_CHOICE_TEXT_LEN = 2000;

// 自由入力（"Type something"）のテキストを整える。
// 改行はそのまま送ると Enter（＝確定）として解釈されるので空白に潰す。
export function sanitizeChoiceText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_CHOICE_TEXT_LEN);
}
