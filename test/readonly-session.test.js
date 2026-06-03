import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadonlySession, ReadonlySessionManager } from "../server/session.js";

describe("ReadonlySession", () => {
  it("toJSON returns readonly shape", () => {
    const s = new ReadonlySession({
      id: "ro123456",
      name: "閲覧",
      cwd: "/home/u/p",
      claudeSessionId: "abc-def",
      projectDir: "-home-u-p",
    });
    const j = s.toJSON();
    assert.equal(j.type, "readonly");
    assert.equal(j.alive, true);
    assert.equal(j.claudeSessionId, "abc-def");
    assert.equal(j.projectDir, "-home-u-p");
    assert.ok(j.createdAt);
  });

  it("write/resize/kill are no-ops and never spawn a process", () => {
    const s = new ReadonlySession({
      id: "x",
      name: "n",
      cwd: "/tmp",
      claudeSessionId: "s",
      projectDir: "p",
    });
    // 閲覧専用なので Claude へは送信せず、例外も投げない
    s.write("hello");
    s.resize(80, 24);
    s.kill();
    assert.equal(s.getOutputBuffer(), "");
  });
});

describe("ReadonlySessionManager", () => {
  it("create / getSession / remove / listSessions", () => {
    const m = new ReadonlySessionManager();
    const s = m.create({
      name: "n",
      cwd: "/tmp",
      claudeSessionId: "sid",
      projectDir: "pd",
    });
    assert.equal(s.id.length, 8);
    assert.equal(m.getSession(s.id), s);

    const list = m.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "readonly");
    assert.equal(list[0].claudeSessionId, "sid");

    m.remove(s.id);
    assert.equal(m.getSession(s.id), null);
    assert.equal(m.listSessions().length, 0);
  });
});
