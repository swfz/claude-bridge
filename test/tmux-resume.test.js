import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// child_process.exec をモック。コマンドごとに stdout を出し分ける
const execCalls = [];
let responses = {};

function stdoutFor(cmd) {
  for (const [pattern, value] of Object.entries(responses)) {
    if (cmd.includes(pattern)) return value;
  }
  return "";
}

mock.module("child_process", {
  namedExports: {
    exec: (cmd, cb) => {
      execCalls.push(cmd);
      const value = stdoutFor(cmd);
      if (value instanceof Error) {
        cb(value);
      } else {
        cb(null, { stdout: value, stderr: "" });
      }
    },
  },
});

const { pickTargetSession, buildResumeWindowName, resumeInTmuxWindow } =
  await import("../server/tmux-session.js");

describe("pickTargetSession", () => {
  it("picks the most recently attached session", () => {
    const stdout = ["1700000000\tolder", "1700009999\tnewer", "0\tnever"].join("\n");

    assert.equal(pickTargetSession(stdout), "newer");
  });

  it("falls back to a never-attached session when it is the only one", () => {
    assert.equal(pickTargetSession("0\tdetached-only"), "detached-only");
  });

  it("returns null for empty output (no tmux server)", () => {
    assert.equal(pickTargetSession(""), null);
    assert.equal(pickTargetSession(undefined), null);
  });

  it("skips session names that would be unsafe in a shell command", () => {
    const stdout = ["9999\t$(whoami)", "1\tsafe-name"].join("\n");

    assert.equal(pickTargetSession(stdout), "safe-name");
  });
});

describe("buildResumeWindowName", () => {
  it("uses the first 8 chars of the session id", () => {
    assert.equal(
      buildResumeWindowName("3c8041cb-8c4f-44fe-9749-80548eb022be"),
      "claude-3c8041cb"
    );
  });

  it("strips characters outside [\\w-]", () => {
    // `;` `空白` `/` は落ち、`-` は tmux の window 名として安全なので残る
    assert.equal(buildResumeWindowName("ab;rm -rf/cd"), "claude-abrm-rfc");
  });
});

describe("resumeInTmuxWindow", () => {
  beforeEach(() => {
    execCalls.length = 0;
    responses = {};
  });

  it("adds a window to the most recently attached session and sends the resume command", async () => {
    responses = {
      "list-sessions": "100\told-sess\n900\tmain-sess\n",
      "new-window": "%7\tmain-sess:3.0\n",
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: "abc-123",
      cwd: "/home/user/my project",
    });

    assert.deepEqual(pane, {
      paneId: "%7",
      target: "main-sess:3.0",
      sessionName: "main-sess",
      windowName: "claude-abc-123",
    });

    const newWindow = execCalls.find((c) => c.includes("new-window"));
    assert.ok(newWindow.includes("-t main-sess"));
    assert.ok(newWindow.includes("-n 'claude-abc-123'"));
    // cwd はシングルクォートでエスケープされる（空白を含んでも壊れない）
    assert.ok(newWindow.includes("-c '/home/user/my project'"));

    const sendKeys = execCalls.find((c) => c.includes("send-keys"));
    assert.ok(sendKeys.includes("claude --resume abc-123"));
    assert.ok(sendKeys.includes("send-keys -t %7 Enter"));
  });

  it("creates a fallback session when no tmux server is running", async () => {
    responses = {
      "list-sessions": new Error("no server running on /tmp/tmux-1000/default"),
      "new-session": "%0\tbridge:0.0\n",
    };

    const pane = await resumeInTmuxWindow({
      claudeSessionId: "def-456",
      cwd: "/tmp/work",
    });

    assert.equal(pane.sessionName, "bridge");
    assert.equal(pane.paneId, "%0");
    const created = execCalls.find((c) => c.includes("new-session"));
    assert.ok(created.includes("-d -s bridge"));
    // 初期 window をそのまま使うので new-window は呼ばない（空 window を残さない）
    assert.ok(!execCalls.some((c) => c.includes("new-window")));
  });

  it("rejects a session id that could be injected into the shell", async () => {
    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: "abc; rm -rf /", cwd: "/tmp" }),
      /Invalid claudeSessionId/
    );
    assert.equal(execCalls.length, 0);
  });

  it("rejects a pane id that is not in %<digits> form", async () => {
    responses = {
      "list-sessions": "1\tmain\n",
      "new-window": "bogus-pane\tmain:1.0\n",
    };

    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: "abc", cwd: "/tmp" }),
      /Invalid paneId/
    );
  });

  it("reports a missing tmux binary without the raw command", async () => {
    responses = {
      "list-sessions": new Error("/bin/sh: 1: tmux: not found"),
      "new-session": new Error("/bin/sh: 1: tmux: not found"),
    };

    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: "abc", cwd: "/tmp" }),
      /tmux コマンドが見つかりません/
    );
  });

  it("surfaces a tmux failure as an error", async () => {
    responses = {
      "list-sessions": "1\tmain\n",
      "new-window": new Error("can't find session"),
    };

    await assert.rejects(
      () => resumeInTmuxWindow({ claudeSessionId: "abc", cwd: "/tmp" }),
      /tmux window の作成に失敗しました/
    );
  });
});
