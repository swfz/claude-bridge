import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);

export const EXT_TO_LANG = {
  js: "javascript", jsx: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  json: "json", yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", sql: "sql", sqlx: "sql",
};

export function highlightCode(text, lang) {
  if (!lang || !hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(text, { language: lang }).value;
  } catch {
    return null;
  }
}

export function highlightLines(text, lang) {
  const html = highlightCode(text, lang);
  return html == null ? null : html.split("\n");
}

export default hljs;
