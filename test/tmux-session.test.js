import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTmuxJsonlTarget, TmuxSession, TmuxSessionManager } from '../server/tmux-session.js';

describe('resolveTmuxJsonlTarget', () => {
  it('returns null when claudeSessionId is unavailable', () => {
    const target = resolveTmuxJsonlTarget({
      cwd: '/home/user/project',
      claudeSessionId: null,
    });

    assert.equal(target, null);
  });

  it('resolves JSONL target from claudeSessionId without cwd fallback', () => {
    const target = resolveTmuxJsonlTarget({
      cwd: '/home/user/project',
      claudeSessionId: 'abc-123',
    });

    assert.deepEqual(target, {
      sessionId: 'abc-123',
      projectDir: '-home-user-project',
    });
  });
});

describe('TmuxSession', () => {
  it('toJSON returns correct shape', () => {
    const session = new TmuxSession({
      id: 'abc',
      name: 'tmux: 0:1.1',
      cwd: '/home/user/project',
      paneId: '%0',
      target: '0:1.1',
    });
    const json = session.toJSON();

    assert.equal(json.id, 'abc');
    assert.equal(json.name, 'tmux: 0:1.1');
    assert.equal(json.cwd, '/home/user/project');
    assert.equal(json.paneId, '%0');
    assert.equal(json.target, '0:1.1');
    assert.equal(json.alive, true);
    assert.equal(json.type, 'tmux');
    assert.ok(json.createdAt);
  });

  it('resize and kill are no-ops', () => {
    const session = new TmuxSession({
      id: 'abc',
      name: 'test',
      cwd: '/tmp',
      paneId: '%0',
      target: '0:1.1',
    });
    // should not throw
    session.resize(80, 24);
    session.kill();
  });
});

describe('TmuxSessionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new TmuxSessionManager();
  });

  it('attachPane creates a session with generated id', () => {
    const session = manager.attachPane({
      paneId: '%0',
      name: 'tmux: 0:1.1',
      cwd: '/home/user/project',
      target: '0:1.1',
    });

    assert.ok(session.id);
    assert.equal(session.id.length, 8);
    assert.equal(session.paneId, '%0');
    assert.equal(session.type, 'tmux');
  });

  it('getSession returns attached session', () => {
    const session = manager.attachPane({
      paneId: '%0',
      name: 'test',
      cwd: '/tmp',
      target: '0:1.1',
    });

    assert.equal(manager.getSession(session.id), session);
  });

  it('getSession returns null for unknown id', () => {
    assert.equal(manager.getSession('nonexistent'), null);
  });

  it('detachSession removes session', () => {
    const session = manager.attachPane({
      paneId: '%0',
      name: 'test',
      cwd: '/tmp',
      target: '0:1.1',
    });

    manager.detachSession(session.id);
    assert.equal(manager.getSession(session.id), null);
  });

  it('listSessions returns JSON array of all sessions', () => {
    manager.attachPane({ paneId: '%0', name: 's1', cwd: '/a', target: '0:1.1' });
    manager.attachPane({ paneId: '%1', name: 's2', cwd: '/b', target: '0:2.1' });

    const list = manager.listSessions();
    assert.equal(list.length, 2);
    assert.equal(list[0].type, 'tmux');
    assert.equal(list[1].type, 'tmux');
    assert.notEqual(list[0].id, list[1].id);
  });

  it('listSessions excludes detached sessions', () => {
    const s1 = manager.attachPane({ paneId: '%0', name: 's1', cwd: '/a', target: '0:1.1' });
    manager.attachPane({ paneId: '%1', name: 's2', cwd: '/b', target: '0:2.1' });

    manager.detachSession(s1.id);
    const list = manager.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 's2');
  });

  describe('refreshStatuses', () => {
    it('backfills claudePid from resolvePids when it is unresolved, and refreshes status', async () => {
      const session = manager.attachPane({
        paneId: '%5',
        name: 's1',
        cwd: '/a',
        target: '0:1.1',
      });
      assert.equal(session.claudePid, null);

      const resolvePids = async (paneIds) => {
        assert.deepEqual(paneIds, ['%5']);
        return new Map([['%5', 4242]]);
      };
      const readStatus = async (pid) => {
        assert.equal(pid, 4242);
        return { status: 'waiting', waitingFor: 'input needed' };
      };

      const changed = await manager.refreshStatuses({ resolvePids, readStatus });

      assert.equal(changed, true);
      assert.equal(session.claudePid, 4242);
      assert.equal(session.status, 'waiting');
      assert.equal(session.waitingFor, 'input needed');
    });

    it('leaves claudePid null when resolvePids cannot find it', async () => {
      const session = manager.attachPane({
        paneId: '%9',
        name: 's1',
        cwd: '/a',
        target: '0:1.1',
      });

      const resolvePids = async () => new Map();
      const readStatus = async () => {
        throw new Error('should not be called when claudePid is unresolved');
      };

      const changed = await manager.refreshStatuses({ resolvePids, readStatus });

      assert.equal(changed, false);
      assert.equal(session.claudePid, null);
    });
  });

  it('attachPane は指定された id が空いていればそれを使い、使用中なら新しく振る', () => {
    const a = manager.attachPane({ id: 'keep-me', paneId: '%0', name: 'a', cwd: '/a', target: '0:1.1' });
    assert.equal(a.id, 'keep-me');
    const b = manager.attachPane({ id: 'keep-me', paneId: '%1', name: 'b', cwd: '/b', target: '0:1.2' });
    assert.notEqual(b.id, 'keep-me');
    assert.equal(b.id.length, 8);
    assert.equal(manager.getSession('keep-me'), a);
    assert.equal(manager.getSession(b.id), b);
  });

  it('attachPane は claudePid・status・waitingFor を引き継ぎ、activeSessions で実体を返す', () => {
    const s = manager.attachPane({
      paneId: '%2',
      name: 'n',
      cwd: '/c',
      target: '0:2.0',
      claudePid: 77,
      status: 'busy',
      waitingFor: 'permission prompt',
    });
    assert.deepEqual(manager.activeSessions(), [s]);
    const json = manager.listSessions()[0];
    assert.equal(json.claudePid, 77);
    assert.equal(json.status, 'busy');
    assert.equal(json.waitingFor, 'permission prompt');
  });

  describe('refreshStatuses: 変化の判定', () => {
    it('解決済みのセッションは pid を引き直さず、status が同じなら変化なし', async () => {
      const s = manager.attachPane({ paneId: '%5', name: 's', cwd: '/a', target: '0:1.1', claudePid: 10 });
      s.status = 'idle';
      let resolved = false;
      const changed = await manager.refreshStatuses({
        resolvePids: async () => {
          resolved = true;
          return new Map();
        },
        readStatus: async () => ({ status: 'idle', waitingFor: null }),
      });
      assert.equal(changed, false);
      assert.equal(resolved, false);
    });

    it('pid を埋められたら status が変わらなくても変化ありとする', async () => {
      const s = manager.attachPane({ paneId: '%6', name: 's', cwd: '/a', target: '0:1.1' });
      const changed = await manager.refreshStatuses({
        resolvePids: async () => new Map([['%6', 66]]),
        readStatus: async () => ({ status: null, waitingFor: null }),
      });
      assert.equal(changed, true);
      assert.equal(s.claudePid, 66);
    });

    it('waitingFor だけが変わっても変化ありとして更新する', async () => {
      const s = manager.attachPane({
        paneId: '%5',
        name: 's',
        cwd: '/a',
        target: '0:1.1',
        claudePid: 10,
        status: 'waiting',
      });
      const changed = await manager.refreshStatuses({
        resolvePids: async () => new Map(),
        readStatus: async () => ({ status: 'waiting', waitingFor: 'input needed' }),
      });
      assert.equal(changed, true);
      assert.equal(s.waitingFor, 'input needed');
    });

    it('status だけが変わっても変化ありとして更新する', async () => {
      const s = manager.attachPane({
        paneId: '%5',
        name: 's',
        cwd: '/a',
        target: '0:1.1',
        claudePid: 10,
        status: 'idle',
      });
      const changed = await manager.refreshStatuses({
        resolvePids: async () => new Map(),
        readStatus: async () => ({ status: 'busy', waitingFor: null }),
      });
      assert.equal(changed, true);
      assert.equal(s.status, 'busy');
    });

    it('セッションが無ければ何も読まずに変化なし', async () => {
      const changed = await manager.refreshStatuses({
        resolvePids: async () => {
          throw new Error('should not resolve');
        },
        readStatus: async () => {
          throw new Error('should not read');
        },
      });
      assert.equal(changed, false);
    });
  });
});

describe('TmuxSession の既定値', () => {
  it('claudePid・status・waitingFor は無ければ null、createdAt は ISO 文字列', () => {
    const json = new TmuxSession({ id: 'x', name: 'x', cwd: '/x', paneId: '%3', target: '0:0.0' }).toJSON();
    assert.equal(json.claudePid, null);
    assert.equal(json.status, null);
    assert.equal(json.waitingFor, null);
    assert.equal(new Date(json.createdAt).toISOString(), json.createdAt);
    assert.deepEqual(Object.keys(json).sort(), [
      'alive',
      'claudePid',
      'createdAt',
      'cwd',
      'id',
      'name',
      'paneId',
      'status',
      'target',
      'type',
      'waitingFor',
    ]);
  });
});

describe('resolveTmuxJsonlTarget: cwd が無いとき', () => {
  it('projectDir は空文字にする', () => {
    assert.deepEqual(resolveTmuxJsonlTarget({ claudeSessionId: 'abc' }), { sessionId: 'abc', projectDir: '' });
  });
});
