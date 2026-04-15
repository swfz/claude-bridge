import { useCallback, useEffect, useRef, useState } from "react";
import "./FileExplorer.css";

const PREVIEWABLE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".html", ".htm", ".pdf",
  ".md", ".txt", ".csv", ".json", ".js", ".css", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".sh",
]);

function getExt(name) {
  const match = name.match(/\.(\w+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function joinPath(parent, name) {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function DirNode({ path, name, depth, initiallyOpen, onOpenPreview }) {
  const [expanded, setExpanded] = useState(!!initiallyOpen);
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!expanded || entries !== null) return;
    let cancelled = false;
    fetch(`/ls?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setEntries(data.entries || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setEntries([]);
          setError(e.message || "読み込みに失敗しました");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, entries, path]);

  return (
    <>
      <button
        type="button"
        className="explorer-node dir"
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => setExpanded((v) => !v)}
        title={path}
      >
        <span className="explorer-caret">{expanded ? "▾" : "▸"}</span>
        <span className="explorer-icon">📁</span>
        <span className="explorer-name">{name}</span>
      </button>
      {expanded && entries && (
        <>
          {error && (
            <div className="explorer-error" style={{ paddingLeft: 12 + depth * 12 }}>
              {error}
            </div>
          )}
          {entries.length === 0 && !error && (
            <div className="explorer-empty" style={{ paddingLeft: 12 + depth * 12 }}>
              (empty)
            </div>
          )}
          {entries.map((e) =>
            e.type === "dir" ? (
              <DirNode
                key={e.name}
                path={joinPath(path, e.name)}
                name={e.name}
                depth={depth + 1}
                onOpenPreview={onOpenPreview}
              />
            ) : (
              <FileNode
                key={e.name}
                path={joinPath(path, e.name)}
                name={e.name}
                depth={depth + 1}
                onOpenPreview={onOpenPreview}
              />
            )
          )}
        </>
      )}
    </>
  );
}

function FileNode({ path, name, depth, onOpenPreview }) {
  const ext = getExt(name);
  const canPreview = PREVIEWABLE_EXTS.has(ext);
  return (
    <button
      type="button"
      className={`explorer-node file ${canPreview ? "" : "disabled"}`}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={() => canPreview && onOpenPreview(path)}
      disabled={!canPreview}
      title={canPreview ? path : `${path} (プレビュー非対応)`}
    >
      <span className="explorer-caret" />
      <span className="explorer-icon">{canPreview ? "📄" : "▫"}</span>
      <span className="explorer-name">{name}</span>
    </button>
  );
}

export default function FileExplorer({ cwd, onOpenPreview }) {
  const [width, setWidth] = useState(260);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setWidth(Math.max(180, Math.min(startWidth.current + delta, 600)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  if (!cwd) {
    return (
      <div className="file-explorer" style={{ width, minWidth: width }}>
        <div className="file-explorer-header">ファイラ</div>
        <div className="file-explorer-body">
          <p className="explorer-empty-state">セッションを選択してください</p>
        </div>
      </div>
    );
  }

  const rootName = cwd.split("/").filter(Boolean).pop() || cwd;

  return (
    <div className="file-explorer" style={{ width, minWidth: width }}>
      <div className="file-explorer-header" title={cwd}>
        <span className="explorer-header-icon">📂</span>
        <span className="explorer-header-name">{rootName}</span>
      </div>
      <div className="file-explorer-body">
        <DirNode
          key={cwd}
          path={cwd}
          name={rootName}
          depth={0}
          initiallyOpen
          onOpenPreview={onOpenPreview}
        />
      </div>
      <div className="file-explorer-resize-handle" onMouseDown={onDragStart} />
    </div>
  );
}
