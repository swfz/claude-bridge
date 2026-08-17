import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  offsetToLineCol,
  getContext,
  getOccurrenceIndex,
  findOccurrenceOffset,
  buildLocationInfo,
} from "../client/src/utils/previewLocation.js";

describe("offsetToLineCol", () => {
  it("returns 1:1 at the start", () => {
    assert.deepEqual(offsetToLineCol("hello", 0), { line: 1, column: 1 });
  });

  it("returns column for first line", () => {
    assert.deepEqual(offsetToLineCol("hello world", 6), { line: 1, column: 7 });
  });

  it("returns line 2 after one newline", () => {
    assert.deepEqual(offsetToLineCol("a\nbc", 2), { line: 2, column: 1 });
    assert.deepEqual(offsetToLineCol("a\nbc", 3), { line: 2, column: 2 });
  });

  it("handles offset at end of multiline text", () => {
    const text = "line1\nline2\nuseState";
    // offset 12 = 'u' position; 'line1\n' (6) + 'line2\n' (6) = 12
    assert.deepEqual(offsetToLineCol(text, 12), { line: 3, column: 1 });
  });

  it("clamps offset beyond text length", () => {
    const result = offsetToLineCol("abc", 999);
    assert.equal(result.line, 1);
    assert.equal(result.column, 4);
  });
});

describe("getContext", () => {
  it("returns surrounding text with newlines squashed", () => {
    const text = "before text\nselected token\nafter text";
    const start = text.indexOf("selected token");
    const end = start + "selected token".length;
    const { before, after } = getContext(text, start, end, 30);
    assert.ok(before.includes("before text"));
    assert.ok(after.includes("after text"));
    assert.equal(before.includes("\n"), false);
    assert.equal(after.includes("\n"), false);
  });

  it("clamps span at boundaries", () => {
    const text = "abc";
    const { before, after } = getContext(text, 0, 3, 30);
    assert.equal(before, "");
    assert.equal(after, "");
  });
});

describe("getOccurrenceIndex", () => {
  it("returns total occurrences and index of matching position", () => {
    const text = "useState foo useState bar useState";
    const second = text.indexOf("useState", 1);
    const result = getOccurrenceIndex(text, "useState", second);
    assert.equal(result.total, 3);
    assert.equal(result.index, 2);
  });

  it("returns total only when startOffset does not match any occurrence", () => {
    const text = "useState foo useState";
    const result = getOccurrenceIndex(text, "useState", 5);
    assert.equal(result.total, 2);
    assert.equal(result.index, 0);
  });

  it("returns zero for needles not found", () => {
    assert.deepEqual(getOccurrenceIndex("hello", "useState", 0), { index: 0, total: 0 });
  });

  it("returns zero for empty needle", () => {
    assert.deepEqual(getOccurrenceIndex("hello", "", 0), { index: 0, total: 0 });
  });
});

describe("findOccurrenceOffset", () => {
  it("returns offset of N-th occurrence", () => {
    const text = "useState foo useState bar useState";
    assert.equal(findOccurrenceOffset(text, "useState", 1), 0);
    assert.equal(findOccurrenceOffset(text, "useState", 2), text.indexOf("useState", 1));
    assert.equal(findOccurrenceOffset(text, "useState", 3), text.lastIndexOf("useState"));
  });

  it("returns -1 when not found or out of range", () => {
    assert.equal(findOccurrenceOffset("abc", "useState", 1), -1);
    assert.equal(findOccurrenceOffset("useState", "useState", 2), -1);
    assert.equal(findOccurrenceOffset("useState", "useState", 0), -1);
  });
});

describe("buildLocationInfo", () => {
  it("for code: builds L<line>:C<col> label with occurrence info", () => {
    const sourceText = "import a;\nimport b;\nconst x = useState(0);\nconst y = useState(1);";
    const sel = "useState";
    const start = sourceText.indexOf(sel);
    const end = start + sel.length;
    const info = buildLocationInfo({
      kind: "code",
      sourceText,
      selectedText: sel,
      sourceStart: start,
      sourceEnd: end,
    });
    assert.match(info.label, /^L3:C\d+, 1\/2箇所目$/);
    assert.ok(info.contextBefore.includes("const x ="));
    assert.ok(info.contextAfter.includes("(0);"));
  });

  it("for code with single occurrence: omits N/M suffix", () => {
    const sourceText = "const x = useState(0);";
    const start = sourceText.indexOf("useState");
    const info = buildLocationInfo({
      kind: "code",
      sourceText,
      selectedText: "useState",
      sourceStart: start,
      sourceEnd: start + "useState".length,
    });
    assert.match(info.label, /^L1:C\d+$/);
  });

  it("for markdown: uses heading and occurrence", () => {
    const sourceText = "# Intro\n\nbody useState here\n\n## Hooks\n\nmore useState\n";
    const start = sourceText.lastIndexOf("useState");
    const info = buildLocationInfo({
      kind: "markdown",
      sourceText,
      selectedText: "useState",
      sourceStart: start,
      sourceEnd: start + "useState".length,
      heading: { level: 2, text: "Hooks" },
    });
    assert.ok(info.label.includes("Hooks"));
    assert.ok(info.label.includes("2/2箇所目"));
  });

  it("for html: builds L<line>:C<col> from the HTML source", () => {
    const sourceText =
      "<html>\n  <body>\n    <p>本文です</p>\n    <li>項目B: 別の選択対象</li>\n  </body>\n</html>";
    const sel = "項目B: 別の選択";
    const start = sourceText.indexOf(sel);
    const info = buildLocationInfo({
      kind: "html",
      sourceText,
      selectedText: sel,
      sourceStart: start,
      sourceEnd: start + sel.length,
    });
    assert.match(info.label, /^L4:C\d+$/);
  });

  it("returns empty label when sourceText is missing", () => {
    const info = buildLocationInfo({
      kind: "markdown",
      sourceText: null,
      selectedText: "x",
      sourceStart: -1,
      sourceEnd: -1,
    });
    assert.equal(info.label, "");
    assert.equal(info.contextBefore, "");
  });
});
