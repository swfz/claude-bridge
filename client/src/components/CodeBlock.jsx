import { useMemo, useRef } from "react";
import { EXT_TO_LANG, highlightCode } from "../highlight.js";
import MermaidBlock from "./MermaidBlock.jsx";

// Markdown 内のコードブロックを highlight.js でシンタックスハイライトして表示する。
// fence の言語名 (js / python 等) は EXT_TO_LANG で hljs の言語名に正規化する。
// ```mermaid は図としてレンダリングする。
export default function CodeBlock({ children, className }) {
  const codeRef = useRef(null);
  const raw = className?.replace("language-", "") || "";
  const lang = EXT_TO_LANG[raw] || raw;
  const code = String(children).replace(/\n$/, "");
  // フックは条件分岐より前に呼ぶ（mermaid 時は html は使わない）
  const html = useMemo(() => highlightCode(code, lang), [code, lang]);

  if (raw === "mermaid") {
    return <MermaidBlock code={code} />;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-lang">{raw}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          Copy
        </button>
      </div>
      <pre className={html ? "hljs" : ""}>
        {html ? (
          <code
            ref={codeRef}
            className={className}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code ref={codeRef} className={className}>
            {children}
          </code>
        )}
      </pre>
    </div>
  );
}
