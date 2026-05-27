import { useEffect, useState } from "react";

// mermaid は重いので動的 import し、初回だけ読み込む
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      // 図は本文の明暗に関わらず白地カードに描くため default テーマで固定する
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let mermaidIdSeq = 0;

// ```mermaid コードブロックを図にレンダリングする
export default function MermaidBlock({ code }) {
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(`mermaid-${++mermaidIdSeq}`, code))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "図の描画に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    // 描画に失敗したら元のコードを読めるように残す
    return (
      <pre className="mermaid-error">
        <code>{`${error}\n\n${code}`}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div className="mermaid-loading">図を描画中...</div>;
  }
  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
