import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTextContent, extractToolUses } from "../server/jsonl-utils.js";

describe("extractTextContent", () => {
  it("returns empty for null/undefined", () => {
    assert.equal(extractTextContent(null), "");
    assert.equal(extractTextContent(undefined), "");
  });

  it("returns string message directly", () => {
    assert.equal(extractTextContent("hello"), "hello");
  });

  it("extracts from string content field", () => {
    assert.equal(extractTextContent({ content: "hello" }), "hello");
  });

  it("extracts from array content with text blocks", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ],
    };
    assert.equal(extractTextContent(msg), "Hello\n\nWorld");
  });

  it("ignores non-text blocks", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "tool_use", name: "Read", input: {} },
      ],
    };
    assert.equal(extractTextContent(msg), "");
  });

  it("truncates with maxLen", () => {
    assert.equal(extractTextContent("hello world", 5), "hello");
  });
});

describe("extractToolUses", () => {
  it("returns empty for null/undefined/string", () => {
    assert.deepEqual(extractToolUses(null), []);
    assert.deepEqual(extractToolUses(undefined), []);
    assert.deepEqual(extractToolUses("text"), []);
  });

  it("returns empty when content is not array", () => {
    assert.deepEqual(extractToolUses({ content: "text" }), []);
  });

  it("extracts tool_use blocks", () => {
    const msg = {
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo/bar.js" } },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "t1");
    assert.equal(result[0].name, "Read");
    assert.equal(result[0].input.file_path, "/foo/bar.js");
  });

  it("extracts Write tool with file_path and content", () => {
    const msg = {
      content: [
        {
          type: "tool_use",
          id: "t2",
          name: "Write",
          input: { file_path: "/home/user/hoge.md", content: "# Hello" },
          caller: { type: "direct" },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Write");
    assert.equal(result[0].input.file_path, "/home/user/hoge.md");
    assert.ok(result[0].summary.includes("hoge.md"));
  });

  it("extracts multiple tool_use blocks from same content", () => {
    const msg = {
      content: [
        { type: "text", text: "Let me check..." },
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "foo" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a/b.js" } },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "Grep");
    assert.equal(result[1].name, "Read");
  });

  it("skips thinking blocks", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Bash");
  });

  it("returns empty when content only has thinking/text blocks", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "done" },
      ],
    };
    assert.deepEqual(extractToolUses(msg), []);
  });

  it("generates summary with shortPath for file tools", () => {
    const msg = {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "/Users/user/project/src/components/App.jsx" },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.ok(result[0].summary.includes("components/App.jsx"));
  });

  it("summarizes AskUserQuestion with the questions themselves", () => {
    const msg = {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "AskUserQuestion",
          input: {
            questions: [
              { question: "好きな色は？", options: [] },
              { question: "好きな季節は？", options: [] },
            ],
          },
        },
      ],
    };
    const result = extractToolUses(msg);
    assert.equal(result[0].summary, "好きな色は？ / 好きな季節は？");
  });

  it("falls back to the tool name when AskUserQuestion has no questions", () => {
    const msg = {
      content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: {} }],
    };
    assert.equal(extractToolUses(msg)[0].summary, "AskUserQuestion");
  });
});
