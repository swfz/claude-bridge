// Markdown 先頭の YAML frontmatter (--- で挟まれた領域) を切り出す。
// remark-gfm は frontmatter を解釈せず `---` を水平線にしてしまうため、
// 表示前に分離してテーブル化できるようにする。
// 簡易パーサのため、ネストや複数行値は文字列としてそのまま扱う。
export function splitFrontmatter(md) {
  if (typeof md !== "string") {
    return { frontmatter: null, body: md || "" };
  }
  const match = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: null, body: md };
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    // 値の前後のクォートを外す。配列やネストはそのまま文字列として表示する。
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    data[key] = value;
  }

  return {
    frontmatter: Object.keys(data).length > 0 ? data : null,
    body: md.slice(match[0].length),
  };
}
