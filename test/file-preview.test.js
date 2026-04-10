import { describe, it } from "node:test";
import assert from "node:assert/strict";

// FilePreview.jsx と ChatView.jsx のロジックをテスト
// コンポーネントの DOM レンダリングではなく、判定ロジックの正確性を検証

// extractLocalPath のロジックを再現
function extractLocalPath(url) {
  if (url.startsWith("file://wsl.localhost/")) {
    return url.replace(/^file:\/\/wsl\.localhost\/[^/]+/, "");
  }
  if (url.startsWith("file:///")) {
    return url.slice(7);
  }
  if (url.startsWith("file://")) {
    return url.slice(7);
  }
  return url;
}

// isPreviewableFilePath のロジックを再現
const PREVIEWABLE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".html", ".htm", ".pdf",
  ".md", ".txt", ".csv", ".json", ".js", ".css", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".sh",
]);

function hasPreviewableExt(text) {
  if (!text) return false;
  const match = text.match(/\.(\w+)$/);
  if (!match) return false;
  return PREVIEWABLE_EXTS.has(`.${match[1].toLowerCase()}`);
}

function resolveFilePath(text, cwd) {
  if (!text) return null;
  if (text.startsWith("/")) {
    return hasPreviewableExt(text) ? text : null;
  }
  if (cwd && hasPreviewableExt(text)) {
    const cleaned = text.startsWith("./") ? text.slice(2) : text;
    return `${cwd.replace(/\/$/, "")}/${cleaned}`;
  }
  return null;
}

// isFileUrl のロジックを再現
function isFileUrl(href) {
  return href && (href.startsWith("file://") || href.startsWith("file:///"));
}

describe("extractLocalPath", () => {
  it("extracts path from file:/// URL", () => {
    assert.equal(
      extractLocalPath("file:///Users/user/hoge.md"),
      "/Users/user/hoge.md"
    );
  });

  it("extracts path from file:// URL (double slash)", () => {
    assert.equal(
      extractLocalPath("file:///home/user/test.js"),
      "/home/user/test.js"
    );
  });

  it("handles WSL paths", () => {
    assert.equal(
      extractLocalPath("file://wsl.localhost/Ubuntu/home/user/file.txt"),
      "/home/user/file.txt"
    );
  });

  it("returns non-file URLs as-is", () => {
    assert.equal(extractLocalPath("/Users/user/hoge.md"), "/Users/user/hoge.md");
  });
});

describe("resolveFilePath", () => {
  it("resolves absolute path with .md extension", () => {
    assert.equal(resolveFilePath("/Users/user/hoge.md"), "/Users/user/hoge.md");
  });

  it("resolves absolute path with .js extension", () => {
    assert.equal(resolveFilePath("/home/user/project/index.js"), "/home/user/project/index.js");
  });

  it("resolves absolute path with .tsx extension", () => {
    assert.equal(resolveFilePath("/app/src/App.tsx"), "/app/src/App.tsx");
  });

  it("resolves absolute path with image extension", () => {
    assert.equal(resolveFilePath("/tmp/screenshot.png"), "/tmp/screenshot.png");
  });

  it("resolves relative path with cwd", () => {
    assert.equal(resolveFilePath("hoge.md", "/Users/user/project"), "/Users/user/project/hoge.md");
  });

  it("resolves ./ relative path with cwd", () => {
    assert.equal(resolveFilePath("./hoge.md", "/Users/user/project"), "/Users/user/project/hoge.md");
  });

  it("resolves nested relative path with cwd", () => {
    assert.equal(resolveFilePath("src/index.js", "/Users/user/project"), "/Users/user/project/src/index.js");
  });

  it("handles cwd with trailing slash", () => {
    assert.equal(resolveFilePath("hoge.md", "/Users/user/project/"), "/Users/user/project/hoge.md");
  });

  it("returns null for relative path without cwd", () => {
    assert.equal(resolveFilePath("hoge.md"), null);
    assert.equal(resolveFilePath("hoge.md", null), null);
    assert.equal(resolveFilePath("hoge.md", undefined), null);
  });

  it("returns null for paths without extension", () => {
    assert.equal(resolveFilePath("/usr/bin/node"), null);
    assert.equal(resolveFilePath("Makefile", "/home/user"), null);
  });

  it("returns null for unsupported extensions", () => {
    assert.equal(resolveFilePath("/tmp/data.bin"), null);
    assert.equal(resolveFilePath("archive.tar.gz", "/tmp"), null);
  });

  it("returns null for null/undefined/empty", () => {
    assert.equal(resolveFilePath(null), null);
    assert.equal(resolveFilePath(undefined), null);
    assert.equal(resolveFilePath(""), null);
  });

  it("case-insensitive extension matching", () => {
    assert.equal(resolveFilePath("/tmp/README.MD"), "/tmp/README.MD");
    assert.equal(resolveFilePath("style.CSS", "/home"), "/home/style.CSS");
  });
});

describe("isFileUrl", () => {
  it("detects file:/// URLs", () => {
    assert.ok(isFileUrl("file:///Users/user/file.md"));
  });

  it("detects file:// URLs", () => {
    assert.ok(isFileUrl("file://localhost/path"));
  });

  it("rejects http URLs", () => {
    assert.ok(!isFileUrl("http://example.com"));
  });

  it("rejects plain paths", () => {
    assert.ok(!isFileUrl("/Users/user/file.md"));
  });

  it("rejects null/undefined", () => {
    assert.ok(!isFileUrl(null));
    assert.ok(!isFileUrl(undefined));
    assert.ok(!isFileUrl(""));
  });
});
