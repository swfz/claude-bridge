import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickNotifyTargets } from "../client/src/utils/notifications.js";

describe("pickNotifyTargets", () => {
  it("includes a session that transitions from busy to idle", () => {
    const prev = new Map([["a", "busy"]]);
    const sessions = [{ id: "a", status: "idle", alive: true }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(
      targets.map((s) => s.id),
      ["a"]
    );
  });

  it("includes a session that transitions from busy to waiting", () => {
    const prev = new Map([["a", "busy"]]);
    const sessions = [{ id: "a", status: "waiting", alive: true }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(
      targets.map((s) => s.id),
      ["a"]
    );
  });

  it("excludes a session that stays busy", () => {
    const prev = new Map([["a", "busy"]]);
    const sessions = [{ id: "a", status: "busy", alive: true }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(targets, []);
  });

  it("excludes a session that stays idle", () => {
    const prev = new Map([["a", "idle"]]);
    const sessions = [{ id: "a", status: "idle", alive: true }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(targets, []);
  });

  it("excludes the first sighting of a session (not in prev)", () => {
    const prev = new Map();
    const sessions = [{ id: "a", status: "idle", alive: true }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(targets, []);
  });

  it("excludes a dead session even if it transitioned", () => {
    const prev = new Map([["a", "busy"]]);
    const sessions = [{ id: "a", status: "idle", alive: false }];
    const targets = pickNotifyTargets({ prev, sessions });
    assert.deepEqual(targets, []);
  });

  it("returns an empty array when prev is undefined", () => {
    const sessions = [{ id: "a", status: "idle", alive: true }];
    assert.deepEqual(pickNotifyTargets({ prev: undefined, sessions }), []);
  });

  it("returns an empty array when prev is null", () => {
    const sessions = [{ id: "a", status: "idle", alive: true }];
    assert.deepEqual(pickNotifyTargets({ prev: null, sessions }), []);
  });

  it("does not throw when sessions is undefined", () => {
    const prev = new Map([["a", "busy"]]);
    assert.deepEqual(pickNotifyTargets({ prev, sessions: undefined }), []);
  });

  it("does not throw when sessions is empty", () => {
    const prev = new Map([["a", "busy"]]);
    assert.deepEqual(pickNotifyTargets({ prev, sessions: [] }), []);
  });
});
