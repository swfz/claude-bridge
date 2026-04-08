import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JsonlWatcher } from "../server/jsonl-watcher.js";

// _findLatestJsonl と findSessionForCwd のテスト用に
// CLAUDE_PROJECTS_DIR を差し替えることはできないが、
// watcher のメソッドを直接テストする

describe("JsonlWatcher", () => {
  let watcher;
  let tmpDir;

  beforeEach(() => {
    watcher = new JsonlWatcher();
    tmpDir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  });

  afterEach(() => {
    watcher.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("_findLatestJsonl", () => {
    it("returns null for empty directory", () => {
      assert.equal(watcher._findLatestJsonl(tmpDir), null);
    });

    it("returns null for nonexistent directory", () => {
      assert.equal(watcher._findLatestJsonl("/nonexistent/path"), null);
    });

    it("returns the most recently modified jsonl file", () => {
      const older = join(tmpDir, "old.jsonl");
      const newer = join(tmpDir, "new.jsonl");
      writeFileSync(older, "{}");
      writeFileSync(newer, "{}");

      // older のタイムスタンプを過去に設定
      const past = new Date(Date.now() - 60000);
      utimesSync(older, past, past);

      assert.equal(watcher._findLatestJsonl(tmpDir), newer);
    });

    it("ignores non-jsonl files", () => {
      writeFileSync(join(tmpDir, "readme.md"), "hello");
      writeFileSync(join(tmpDir, "data.json"), "{}");
      const jsonl = join(tmpDir, "session.jsonl");
      writeFileSync(jsonl, "{}");

      assert.equal(watcher._findLatestJsonl(tmpDir), jsonl);
    });
  });

  describe("_readNewLines", () => {
    it("reads new lines and calls onMessage for user/assistant records", () => {
      const filePath = join(tmpDir, "test.jsonl");
      const records = [
        JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ type: "assistant", message: { content: "hi there" }, timestamp: "2024-01-01T00:00:01Z" }),
        JSON.stringify({ type: "system", message: "ignored" }),
      ];
      writeFileSync(filePath, records.join("\n") + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test-session",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, "human");
      assert.equal(messages[0].content, "hello");
      assert.equal(messages[0].bridgeSessionId, "test-session");
      assert.equal(messages[1].role, "assistant");
      assert.equal(messages[1].content, "hi there");
    });

    it("skips already-read lines", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, [
        JSON.stringify({ type: "user", message: { content: "first" } }),
        JSON.stringify({ type: "assistant", message: { content: "response" } }),
      ].join("\n") + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 1, // skip first line
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "response");
      assert.equal(state.linesRead, 2);
    });

    it("handles array content blocks", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part1" },
            { type: "tool_use", id: "t1" },
            { type: "text", text: "part2" },
          ],
        },
      }) + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "part1\n\npart2");
    });

    it("skips malformed JSON lines", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, [
        "not json",
        JSON.stringify({ type: "assistant", message: { content: "valid" } }),
        "{broken",
      ].join("\n") + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "valid");
    });

    it("reads queue-operation enqueue as human message", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, [
        JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "途中の指示", timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ type: "queue-operation", operation: "remove" }),
      ].join("\n") + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, "human");
      assert.equal(messages[0].content, "途中の指示");
    });

    it("extracts toolUses from assistant messages", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "確認します" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/home/user/project/index.js" } },
          ],
        },
      }) + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "確認します");
      assert.equal(messages[0].toolUses.length, 2);
      assert.equal(messages[0].toolUses[0].name, "Bash");
      assert.equal(messages[0].toolUses[0].summary, "Run tests");
      assert.equal(messages[0].toolUses[1].name, "Read");
      assert.ok(messages[0].toolUses[1].summary.includes("index.js"));
    });

    it("emits message for tool_use only (no text) assistant records", () => {
      const filePath = join(tmpDir, "test.jsonl");
      writeFileSync(filePath, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a/b.js", old_string: "old", new_string: "new" } },
          ],
        },
      }) + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: filePath,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, "");
      assert.equal(messages[0].toolUses.length, 1);
      assert.equal(messages[0].toolUses[0].name, "Edit");
    });

    it("does nothing when targetFile is null", () => {
      const messages = [];
      const state = {
        bridgeSessionId: "test",
        targetFile: null,
        linesRead: 0,
        onMessage: (msg) => messages.push(msg),
      };

      watcher._readNewLines(state);
      assert.equal(messages.length, 0);
    });
  });

  describe("_detectNewFile", () => {
    it("detects a recently modified file", () => {
      const filePath = join(tmpDir, "session.jsonl");
      writeFileSync(filePath, JSON.stringify({ type: "user", message: { content: "test" } }) + "\n");

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: false,
        onMessage: (msg) => messages.push(msg),
        fsWatcher: null,
        pollTimer: setInterval(() => {}, 99999),
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, filePath);
      assert.equal(messages.length, 1);

      // cleanup
      if (state.fsWatcher) state.fsWatcher.close();
      clearInterval(state.pollTimer);
    });

    it("skips old files when attachExisting is false", () => {
      const filePath = join(tmpDir, "session.jsonl");
      writeFileSync(filePath, "{}");
      // ファイルを20秒前のタイムスタンプに設定
      const past = new Date(Date.now() - 20000);
      utimesSync(filePath, past, past);

      const state = {
        bridgeSessionId: "test",
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: false,
        onMessage: () => {},
        fsWatcher: null,
        pollTimer: null,
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, null);
    });

    it("accepts old files when attachExisting is true", () => {
      const filePath = join(tmpDir, "session.jsonl");
      writeFileSync(filePath, JSON.stringify({ type: "user", message: { content: "old" } }) + "\n");
      const past = new Date(Date.now() - 60000);
      utimesSync(filePath, past, past);

      const messages = [];
      const state = {
        bridgeSessionId: "test",
        projectPath: tmpDir,
        targetFile: null,
        linesRead: 0,
        attachExisting: true,
        onMessage: (msg) => messages.push(msg),
        fsWatcher: null,
        pollTimer: null,
      };

      watcher._detectNewFile(state);

      assert.equal(state.targetFile, filePath);
      assert.equal(messages.length, 1);

      if (state.fsWatcher) state.fsWatcher.close();
    });
  });

  describe("stopWatching", () => {
    it("removes watcher and cleans up", () => {
      const projectPath = tmpDir;
      mkdirSync(projectPath, { recursive: true });

      watcher.startWatching({
        bridgeSessionId: "test",
        cwd: "/nonexistent/path/for/test",
        onMessage: () => {},
      });

      assert.equal(watcher.watchers.size, 1);

      watcher.stopWatching("test");
      assert.equal(watcher.watchers.size, 0);
    });

    it("stopAll clears all watchers", () => {
      watcher.startWatching({
        bridgeSessionId: "a",
        cwd: "/nonexistent/a",
        onMessage: () => {},
      });
      watcher.startWatching({
        bridgeSessionId: "b",
        cwd: "/nonexistent/b",
        onMessage: () => {},
      });

      assert.equal(watcher.watchers.size, 2);

      watcher.stopAll();
      assert.equal(watcher.watchers.size, 0);
    });
  });
});
