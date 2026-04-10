import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// child_process.exec をモック（1回だけ設定）
const execCalls = [];
let execError = null;

mock.module("child_process", {
  namedExports: {
    exec: (cmd, cb) => {
      execCalls.push(cmd);
      if (execError) {
        cb(execError);
      } else {
        cb(null, { stdout: execCalls._mockStdout || "", stderr: "" });
      }
    },
  },
});

// モック後に import
const { listClaudeTmuxPanes, sendKeysToPane } = await import(
  "../server/tmux-session.js"
);

describe("listClaudeTmuxPanes", () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = "";
    execError = null;
  });

  it("parses tmux output and filters claude panes", async () => {
    execCalls._mockStdout = [
      "%0\t1330\tclaude\t/home/user/project\t0:1.1\tmain",
      "%1\t2000\tzsh\t/home/user\t0:1.2\tmain",
      "%2\t3000\tclaude\t/home/user/other\t0:2.1\twork",
    ].join("\n");

    const panes = await listClaudeTmuxPanes();

    assert.equal(panes.length, 2);
    assert.deepEqual(panes[0], {
      paneId: "%0",
      panePid: "1330",
      command: "claude",
      cwd: "/home/user/project",
      target: "0:1.1",
      windowName: "main",
    });
    assert.equal(panes[1].paneId, "%2");
    assert.equal(panes[1].cwd, "/home/user/other");
  });

  it("detects claude panes by version number (macOS symlink resolution)", async () => {
    execCalls._mockStdout = [
      "%0\t1330\t2.1.100\t/home/user/project\t0:1.1\tmain",
      "%1\t2000\tzsh\t/home/user\t0:1.2\tmain",
      "%2\t3000\t2.1.97\t/home/user/other\t0:2.1\twork",
    ].join("\n");

    const panes = await listClaudeTmuxPanes();

    assert.equal(panes.length, 2);
    assert.equal(panes[0].paneId, "%0");
    assert.equal(panes[0].command, "2.1.100");
    assert.equal(panes[1].paneId, "%2");
    assert.equal(panes[1].command, "2.1.97");
  });

  it("returns empty array when no claude panes", async () => {
    execCalls._mockStdout = "%0\t1000\tzsh\t/home\t0:1.1\tmain\n";

    const panes = await listClaudeTmuxPanes();
    assert.equal(panes.length, 0);
  });

  it("returns empty array on tmux error", async () => {
    execError = new Error("no tmux server");

    const panes = await listClaudeTmuxPanes();
    assert.deepEqual(panes, []);
  });
});

describe("sendKeysToPane", () => {
  beforeEach(() => {
    execCalls.length = 0;
    execCalls._mockStdout = "";
    execError = null;
  });

  it("sends text and Enter in a single command", async () => {
    await sendKeysToPane("%0", "hello world");

    assert.equal(execCalls.length, 1);
    assert.ok(execCalls[0].includes("tmux send-keys -t %0 -l"));
    assert.ok(execCalls[0].includes("hello world"));
    assert.ok(execCalls[0].includes("&& tmux send-keys -t %0 Enter"));
  });

  it("escapes single quotes in text", async () => {
    await sendKeysToPane("%0", "it's a test");

    assert.equal(execCalls.length, 1);
    assert.ok(execCalls[0].includes("it'\\''s a test"));
  });

  it("handles empty text", async () => {
    await sendKeysToPane("%0", "");

    assert.equal(execCalls.length, 1);
    assert.ok(execCalls[0].includes("tmux send-keys -t %0 -l ''"));
  });

  it("logs error but does not throw on failure", async () => {
    execError = new Error("pane not found");

    // should not throw
    await sendKeysToPane("%99", "test");
  });
});
