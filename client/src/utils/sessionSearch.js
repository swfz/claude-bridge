// ホーム画面のセッション検索（純粋関数のみ）。
// タイトル・依頼内容・パス・ブランチなど複数フィールドを横断してテキスト絞り込みする。

import { parseCwd } from "./cwdLabel.js";

// 絞り込み対象の既定フィールド
const DEFAULT_FIELDS = [
  "title",
  "name",
  "cwd",
  "gitBranch",
  "firstUserMessage",
  "lastUserMessage",
  "lastAssistantMessage",
  "sessionId",
];

// 検索語の分解: 小文字化し、半角/全角スペースで分割。空なら []
export function parseSearchQuery(query) {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[\s　]+/)
    .filter((term) => term.length > 0);
}

// 1件のセッションが全 term にマッチするか（AND）。
// 各 term は「いずれかのフィールドに部分一致（小文字比較）」でマッチ
export function matchesSearch(session, terms, fields = DEFAULT_FIELDS) {
  if (!terms || terms.length === 0) return true;
  if (!session) return false;

  const haystacks = fields
    .map((field) => session[field])
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());

  // term 自体も小文字化する（parseSearchQuery を経由しない直接呼び出しでも大文字小文字を無視するため）
  return terms.every((term) => {
    const t = String(term).toLowerCase();
    return haystacks.some((haystack) => haystack.includes(t));
  });
}

// リストを絞り込む。query が空（空白のみ含む）なら list をそのまま返す
export function filterBySearch(list, query, fields = DEFAULT_FIELDS) {
  const items = list || [];
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return items;
  return items.filter((session) => matchesSearch(session, terms, fields));
}

// 複数のセッションリストから cwd 由来のプロジェクト名を重複無しで集める（ソート済み）。
// null/空文字（cwd 無し等）は除外する
export function collectProjects(...lists) {
  const projects = new Set();
  for (const list of lists) {
    for (const session of list || []) {
      const { project } = parseCwd(session?.cwd);
      if (project) projects.add(project);
    }
  }
  return [...projects].sort();
}

// リストをプロジェクト名で絞り込む。project が falsy ならそのまま返す
export function filterByProject(list, project) {
  const items = list || [];
  if (!project) return items;
  return items.filter((session) => parseCwd(session?.cwd).project === project);
}
