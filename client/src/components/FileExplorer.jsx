import { useCallback, useEffect, useRef, useState } from "react";
import { FileIcon, FolderIcon } from "./fileIcons.jsx";
import { getExt, isPreviewable } from "../utils/previewExts.js";
import "./FileExplorer.css";

function joinPath(parent, name) {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

// cwd からの相対ディレクトリ部分（検索結果で「どこにあるか」を示す）。直下なら ""。
function relativeDir(cwd, full) {
  let rel = full.startsWith(cwd) ? full.slice(cwd.length) : full;
  rel = rel.replace(/^\/+/, "");
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx + 1) : "";
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
        <span className="explorer-icon">
          <FolderIcon open={expanded} />
        </span>
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

function FileNode({ path, name, depth, onOpenPreview, subPath }) {
  const ext = getExt(name);
  const canPreview = isPreviewable(name);
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
      <span className="explorer-icon">
        <FileIcon ext={ext} />
      </span>
      <span className="explorer-name">{name}</span>
      {subPath ? <span className="explorer-subpath">{subPath}</span> : null}
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

  // ファイル名検索（cwd 配下を再帰検索。空のときはツリー表示）
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState({ matches: [], truncated: false, loading: false });

  useEffect(() => {
    const q = query.trim();
    if (!cwd || !q) {
      setSearch({ matches: [], truncated: false, loading: false });
      return;
    }
    setSearch((s) => ({ ...s, loading: true }));
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `/search?path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`
        );
        const data = res.ok ? await res.json() : { matches: [], truncated: false };
        if (!cancelled) setSearch({ matches: data.matches || [], truncated: !!data.truncated, loading: false });
      } catch {
        if (!cancelled) setSearch({ matches: [], truncated: false, loading: false });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, cwd]);

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

  const searching = query.trim().length > 0;

  return (
    <div className="file-explorer" style={{ width, minWidth: width }}>
      <div className="file-explorer-header" title={cwd}>
        <span className="explorer-header-icon">
          <FolderIcon root size={16} />
        </span>
        <span className="explorer-header-name">{rootName}</span>
      </div>
      <div className="file-explorer-search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ファイル名で検索..."
        />
        {searching && (
          <button
            className="explorer-search-clear"
            onClick={() => setQuery("")}
            title="クリア"
          >
            x
          </button>
        )}
      </div>
      <div className="file-explorer-body">
        {searching ? (
          search.loading ? (
            <p className="explorer-empty-state">検索中...</p>
          ) : search.matches.length === 0 ? (
            <p className="explorer-empty-state">一致なし</p>
          ) : (
            <>
              {search.matches.map((m) => (
                <FileNode
                  key={m.path}
                  path={m.path}
                  name={m.name}
                  depth={0}
                  onOpenPreview={onOpenPreview}
                  subPath={relativeDir(cwd, m.path)}
                />
              ))}
              {search.truncated && (
                <p className="explorer-empty-state">（結果が多いため一部のみ表示）</p>
              )}
            </>
          )
        ) : (
          <DirNode
            key={cwd}
            path={cwd}
            name={rootName}
            depth={0}
            initiallyOpen
            onOpenPreview={onOpenPreview}
          />
        )}
      </div>
      <div className="file-explorer-resize-handle" onMouseDown={onDragStart} />
    </div>
  );
}
