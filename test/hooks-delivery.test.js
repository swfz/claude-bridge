import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hooks");
const CHECK = join(HOOKS, "bridge-check-inbox.js");
const WATCH = join(HOOKS, "bridge-watch.js");
const SESSION_START = join(HOOKS, "bridge-session-start.js");

function seedInbox(base, sid, texts) {
  const dir = join(base, "inbox");
  mkdirSync(dir, { recursive: true });
  const lines = texts
    .map((t, i) => JSON.stringify({ id: `m${i}`, text: t, ts: "t" }) + "\n")
    .join("");
  writeFileSync(join(dir, `${sid}.jsonl`), lines);
  return dir;
}

function runCheck(base, hookInput) {
  return execFileSync("node", [CHECK], {
    input: JSON.stringify(hookInput),
    env: { ...process.env, CLAUDE_BRIDGE_DIR: base },
    encoding: "utf-8",
  });
}

describe("bridge-check-inbox.js (turn 配信)", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bridge-hook-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("injects unread comments as a block decision and advances offset", () => {
    seedInbox(base, "sid", ["first", "second"]);
    const out = runCheck(base, { session_id: "sid", stop_hook_active: false });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /first/);
    assert.match(parsed.reason, /second/);
    const offset = readFileSync(join(base, "inbox", "sid.offset"), "utf-8").trim();
    assert.equal(offset, "2");
  });

  it("emits nothing on the second run (already read)", () => {
    seedInbox(base, "sid", ["only"]);
    runCheck(base, { session_id: "sid", stop_hook_active: false });
    const out = runCheck(base, { session_id: "sid", stop_hook_active: false });
    assert.equal(out.trim(), "");
  });

  it("emits nothing when stop_hook_active (loop guard)", () => {
    seedInbox(base, "sid", ["x"]);
    const out = runCheck(base, { session_id: "sid", stop_hook_active: true });
    assert.equal(out.trim(), "");
  });

  it("defers when a live monitor watcher pidfile exists", () => {
    seedInbox(base, "sid", ["x"]);
    // 生存している pid（テストランナー自身）を pidfile に書く → defer されるはず
    writeFileSync(join(base, "inbox", "watch.sid.pid"), String(process.pid));
    const out = runCheck(base, { session_id: "sid", stop_hook_active: false });
    assert.equal(out.trim(), "");
    // offset は進めない（monitor 側が配信する想定）
    assert.equal(existsSync(join(base, "inbox", "sid.offset")), false);
  });

  it("rejects malformed session_id", () => {
    seedInbox(base, "sid", ["x"]);
    const out = runCheck(base, { session_id: "../evil", stop_hook_active: false });
    assert.equal(out.trim(), "");
  });
});

describe("bridge-watch.js (monitor 配信)", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bridge-watch-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("writes a pidfile and streams newly appended comments", async () => {
    const dir = join(base, "inbox");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sid.jsonl");
    writeFileSync(file, "");

    const child = spawn("node", [WATCH, "sid"], {
      env: { ...process.env, CLAUDE_BRIDGE_DIR: base, CLAUDE_BRIDGE_WATCH_INTERVAL: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));

    try {
      // pidfile が作られるのを待つ（spawn + 実時間ポーリングのためタイムアウトは余裕を持たせる）
      await waitFor(() => existsSync(join(dir, "watch.sid.pid")), 8000);
      writeFileSync(file, JSON.stringify({ id: "m1", text: "hi-monitor", ts: "t" }) + "\n");
      await waitFor(() => out.includes("hi-monitor"), 8000);
      assert.match(out, /\[claude-bridge\] hi-monitor/);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("bridge-session-start.js (monitor 指示)", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bridge-ss-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const run = (input) =>
    execFileSync("node", [SESSION_START], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_BRIDGE_DIR: base },
      encoding: "utf-8",
    });

  it("emits JSON additionalContext directing Monitor when inbox exists", () => {
    mkdirSync(join(base, "inbox"), { recursive: true });
    const out = run({ session_id: "sid-1", source: "resume" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /Monitor/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /bridge-watch\.js sid-1/);
  });

  it("emits nothing when inbox directory is absent (claude-bridge 未使用)", () => {
    const out = run({ session_id: "sid-1", source: "startup" });
    assert.equal(out.trim(), "");
  });

  it("emits nothing for malformed session_id", () => {
    mkdirSync(join(base, "inbox"), { recursive: true });
    const out = run({ session_id: "../evil", source: "resume" });
    assert.equal(out.trim(), "");
  });
});

function waitFor(pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}
