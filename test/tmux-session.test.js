import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TmuxSession, TmuxSessionManager } from "../server/tmux-session.js";

describe("TmuxSession", () => {
  it("toJSON returns correct shape", () => {
    const session = new TmuxSession({
      id: "abc",
      name: "tmux: 0:1.1",
      cwd: "/home/user/project",
      paneId: "%0",
      target: "0:1.1",
    });
    const json = session.toJSON();

    assert.equal(json.id, "abc");
    assert.equal(json.name, "tmux: 0:1.1");
    assert.equal(json.cwd, "/home/user/project");
    assert.equal(json.paneId, "%0");
    assert.equal(json.target, "0:1.1");
    assert.equal(json.alive, true);
    assert.equal(json.type, "tmux");
    assert.ok(json.createdAt);
  });

  it("resize and kill are no-ops", () => {
    const session = new TmuxSession({
      id: "abc",
      name: "test",
      cwd: "/tmp",
      paneId: "%0",
      target: "0:1.1",
    });
    // should not throw
    session.resize(80, 24);
    session.kill();
  });
});

describe("TmuxSessionManager", () => {
  let manager;

  beforeEach(() => {
    manager = new TmuxSessionManager();
  });

  it("attachPane creates a session with generated id", () => {
    const session = manager.attachPane({
      paneId: "%0",
      name: "tmux: 0:1.1",
      cwd: "/home/user/project",
      target: "0:1.1",
    });

    assert.ok(session.id);
    assert.equal(session.id.length, 8);
    assert.equal(session.paneId, "%0");
    assert.equal(session.type, "tmux");
  });

  it("getSession returns attached session", () => {
    const session = manager.attachPane({
      paneId: "%0",
      name: "test",
      cwd: "/tmp",
      target: "0:1.1",
    });

    assert.equal(manager.getSession(session.id), session);
  });

  it("getSession returns null for unknown id", () => {
    assert.equal(manager.getSession("nonexistent"), null);
  });

  it("detachSession removes session", () => {
    const session = manager.attachPane({
      paneId: "%0",
      name: "test",
      cwd: "/tmp",
      target: "0:1.1",
    });

    manager.detachSession(session.id);
    assert.equal(manager.getSession(session.id), null);
  });

  it("listSessions returns JSON array of all sessions", () => {
    manager.attachPane({ paneId: "%0", name: "s1", cwd: "/a", target: "0:1.1" });
    manager.attachPane({ paneId: "%1", name: "s2", cwd: "/b", target: "0:2.1" });

    const list = manager.listSessions();
    assert.equal(list.length, 2);
    assert.equal(list[0].type, "tmux");
    assert.equal(list[1].type, "tmux");
    assert.notEqual(list[0].id, list[1].id);
  });

  it("listSessions excludes detached sessions", () => {
    const s1 = manager.attachPane({ paneId: "%0", name: "s1", cwd: "/a", target: "0:1.1" });
    manager.attachPane({ paneId: "%1", name: "s2", cwd: "/b", target: "0:2.1" });

    manager.detachSession(s1.id);
    const list = manager.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "s2");
  });
});
