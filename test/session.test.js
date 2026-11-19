import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';

// 本物の pty・claude プロセスは起動しない。spawn は偽のプロセスを返し、
// 書き込まれたバイト列と onData / onExit のハンドラを記録する
const spawned = [];
vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn((file, args, opts) => {
      const proc = {
        file,
        args,
        opts,
        pid: 4242 + spawned.length,
        writes: [],
        resized: [],
        killed: false,
        dataHandler: null,
        exitHandler: null,
        write(data) {
          this.writes.push(data);
        },
        resize(cols, rows) {
          this.resized.push([cols, rows]);
        },
        kill() {
          this.killed = true;
        },
        onData(cb) {
          this.dataHandler = cb;
        },
        onExit(cb) {
          this.exitHandler = cb;
        },
      };
      spawned.push(proc);
      return proc;
    }),
  },
}));

const statusByPid = new Map();
let fallbackStatus = { status: null, waitingFor: null };
vi.mock('../server/claude-session-meta.js', () => ({
  readStatusByPid: vi.fn(async (pid) => statusByPid.get(pid) ?? fallbackStatus),
}));

// ID の衝突を再現するときだけ randomUUID の戻り値を差し替える
vi.mock('crypto', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, randomUUID: vi.fn(() => orig.randomUUID()) };
});
const { randomUUID } = await import('crypto');

const { Session, SessionManager, ReadonlySession, ReadonlySessionManager } = await import('../server/session.js');

function startedSession(opts = {}) {
  const s = new Session({ id: 's1', name: 'name', cwd: '/work', ...opts });
  s.start();
  return { s, proc: spawned[spawned.length - 1] };
}

function fakeStorage(initial = []) {
  return {
    saved: [],
    loadSessions: () => initial,
    saveSessions(list) {
      this.saved.push(list);
    },
  };
}

beforeEach(() => {
  spawned.length = 0;
  statusByPid.clear();
  fallbackStatus = { status: null, waitingFor: null };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Session.start', () => {
  it('claude を引数・cwd・端末サイズ・TERM 付きで起動する', () => {
    const { proc } = startedSession({ args: ['--resume', 'abc'] });
    assert.equal(proc.file, 'claude');
    assert.deepEqual(proc.args, ['--resume', 'abc']);
    assert.equal(proc.opts.name, 'xterm-256color');
    assert.equal(proc.opts.cols, 120);
    assert.equal(proc.opts.rows, 40);
    assert.equal(proc.opts.cwd, '/work');
    assert.equal(proc.opts.env.TERM, 'xterm-256color');
    assert.equal(proc.opts.env.PATH, process.env.PATH);
  });

  it('args を省くと引数なしで起動する', () => {
    const { proc } = startedSession();
    assert.deepEqual(proc.args, []);
  });

  it('出力を購読者に配り、バッファにも溜める', () => {
    const { s, proc } = startedSession();
    const got = [];
    s.onOutput((d) => got.push(d));
    proc.dataHandler('abc');
    proc.dataHandler('def');
    assert.deepEqual(got, ['abc', 'def']);
    assert.equal(s.getOutputBuffer(), 'abcdef');
  });

  it('バッファが 1MB を超えたら古い出力から捨てる', () => {
    const { s, proc } = startedSession();
    const chunk = 'x'.repeat(512 * 1024);
    proc.dataHandler('A');
    proc.dataHandler(chunk);
    proc.dataHandler(chunk);
    // 'A' + 1MB で上限超過なので 'A' だけ捨てられ、ちょうど 1MB が残る
    assert.equal(s.getOutputBuffer(), chunk + chunk);
    proc.dataHandler('B');
    assert.equal(s.getOutputBuffer(), chunk + 'B');
  });

  it('ちょうど 1MB までは捨てない', () => {
    const { s, proc } = startedSession();
    const half = 'y'.repeat(512 * 1024);
    proc.dataHandler(half);
    proc.dataHandler(half);
    assert.equal(s.getOutputBuffer().length, 1024 * 1024);
  });

  it('終了したら exit code を購読者に配り、alive が false になる', () => {
    const { s, proc } = startedSession();
    const codes = [];
    s.onExit((c) => codes.push(c));
    assert.equal(s.toJSON().alive, true);
    proc.exitHandler({ exitCode: 3 });
    assert.deepEqual(codes, [3]);
    assert.equal(s.toJSON().alive, false);
    assert.equal(s.claudePid, null);
    assert.match(console.log.mock.calls[0][0], /Session s1 \(name\) exited with code 3/);
  });
});

describe('Session.write', () => {
  it('末尾の改行は本文と分け、確定用の Enter を 120ms 遅らせて送る', () => {
    vi.useFakeTimers();
    const { s, proc } = startedSession();
    s.write('hello\n');
    assert.deepEqual(proc.writes, ['hello']);
    vi.advanceTimersByTime(119);
    assert.deepEqual(proc.writes, ['hello']);
    vi.advanceTimersByTime(1);
    assert.deepEqual(proc.writes, ['hello', '\r']);
  });

  it('本文中の改行は \\r に変換し、末尾の連続した改行は Enter 1 回にまとめる', () => {
    vi.useFakeTimers();
    const { s, proc } = startedSession();
    s.write('a\nb\n\n');
    vi.runAllTimers();
    assert.deepEqual(proc.writes, ['a\rb', '\r']);
  });

  it('改行で終わらない本文はそのまま 1 回で送り、Enter は足さない', () => {
    vi.useFakeTimers();
    const { s, proc } = startedSession();
    s.write('x\ny');
    vi.runAllTimers();
    assert.deepEqual(proc.writes, ['x\ry']);
  });

  it('Enter を送る前に終了していたら何も送らない', () => {
    vi.useFakeTimers();
    const { s, proc } = startedSession();
    s.write('hi\n');
    proc.exitHandler({ exitCode: 0 });
    vi.runAllTimers();
    assert.deepEqual(proc.writes, ['hi']);
  });

  it('起動前は何もしない', () => {
    const s = new Session({ id: 'x', name: 'n', cwd: '/' });
    assert.doesNotThrow(() => s.write('hi\n'));
  });
});

describe('Session の選択肢操作', () => {
  it('sendChoiceKeys はキーを PTY のシーケンスに変換し、間を 90ms 空けて送る', async () => {
    vi.useFakeTimers();
    const { s, proc } = startedSession();
    const done = s.sendChoiceKeys(['2', 'Enter', 'Up']);
    assert.deepEqual(proc.writes, ['2']);
    await vi.advanceTimersByTimeAsync(89);
    assert.deepEqual(proc.writes, ['2']);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(proc.writes, ['2', '\r']);
    await vi.advanceTimersByTimeAsync(90);
    await done;
    assert.deepEqual(proc.writes, ['2', '\r', '\x1b[A']);
  });

  it('sendChoiceKeys は不正なキーを送らずに例外にする', async () => {
    const { s, proc } = startedSession();
    await assert.rejects(s.sendChoiceKeys(['1', 'rm -rf']), /Invalid choice key/);
    assert.deepEqual(proc.writes, []);
  });

  it('sendChoiceKeys は起動前なら何もしない', async () => {
    const s = new Session({ id: 'x', name: 'n', cwd: '/' });
    await assert.doesNotReject(s.sendChoiceKeys(['bad key']));
  });

  it('sendChoiceText は改行を空白に潰して Enter を付けずに送る', () => {
    const { s, proc } = startedSession();
    s.sendChoiceText('a\nb');
    assert.deepEqual(proc.writes, ['a b']);
  });

  it('sendChoiceText は空文字・文字列以外を送らない', () => {
    const { s, proc } = startedSession();
    s.sendChoiceText('');
    s.sendChoiceText(null);
    assert.deepEqual(proc.writes, []);
  });

  it('sendChoiceText は起動前なら何もしない', () => {
    const s = new Session({ id: 'x', name: 'n', cwd: '/' });
    assert.doesNotThrow(() => s.sendChoiceText('abc'));
  });
});

describe('Session.getScreenText', () => {
  it('ANSI 出力を再現した今の画面を行ごとに返す', async () => {
    const { s, proc } = startedSession();
    proc.dataHandler('first\r\n\x1b[1msecond\x1b[0m');
    const text = await s.getScreenText();
    const lines = text.split('\n');
    assert.equal(lines.length, 40);
    assert.equal(lines[0], 'first');
    assert.equal(lines[1], 'second');
    // 何も書いていないセルは行末の空白として落とす
    assert.equal(lines[2], '');
  });

  it('スクロールした後は見えている範囲だけを返す', async () => {
    const { s, proc } = startedSession();
    const out = Array.from({ length: 45 }, (_, i) => `line${i}`).join('\r\n');
    proc.dataHandler(out);
    const lines = (await s.getScreenText()).split('\n');
    assert.equal(lines.length, 40);
    assert.equal(lines[0], 'line5');
    assert.equal(lines[39], 'line44');
  });

  it('resize 後は新しい行数で返す', async () => {
    const { s, proc } = startedSession();
    s.resize(80, 10);
    assert.deepEqual(proc.resized, [[80, 10]]);
    proc.dataHandler('hi');
    const lines = (await s.getScreenText()).split('\n');
    assert.equal(lines.length, 10);
    assert.equal(lines[0], 'hi');
  });

  it('kill 後は空文字を返す', async () => {
    const { s, proc } = startedSession();
    proc.dataHandler('hi');
    s.kill();
    assert.equal(proc.killed, true);
    assert.equal(await s.getScreenText(), '');
    assert.equal(s.toJSON().alive, false);
  });
});

describe('Session のその他', () => {
  it('resize は 0 以下の値と起動前を無視する', () => {
    const { s, proc } = startedSession();
    s.resize(0, 10);
    s.resize(10, 0);
    assert.deepEqual(proc.resized, []);
    const idle = new Session({ id: 'x', name: 'n', cwd: '/' });
    assert.doesNotThrow(() => idle.resize(80, 24));
  });

  it('claudePid はプロセスの pid、起動前は null', () => {
    const idle = new Session({ id: 'x', name: 'n', cwd: '/' });
    assert.equal(idle.claudePid, null);
    const { s, proc } = startedSession();
    assert.equal(s.claudePid, proc.pid);
  });

  it('kill の後に遅れて届いた出力でも落ちず、購読者には配る', () => {
    const { s, proc } = startedSession();
    const got = [];
    s.onOutput((d) => got.push(d));
    s.kill();
    assert.doesNotThrow(() => proc.dataHandler('late'));
    assert.deepEqual(got, ['late']);
  });

  it('kill を 2 回呼んでも落ちない', () => {
    const { s } = startedSession();
    s.kill();
    assert.doesNotThrow(() => s.kill());
  });

  it('toJSON は id・名前・cwd・作成時刻・生存・状態を返す', () => {
    const { s } = startedSession();
    s.status = 'busy';
    s.waitingFor = 'permission prompt';
    const j = s.toJSON();
    assert.deepEqual(j, {
      id: 's1',
      name: 'name',
      cwd: '/work',
      createdAt: s.createdAt,
      alive: true,
      status: 'busy',
      waitingFor: 'permission prompt',
    });
    assert.ok(!Number.isNaN(Date.parse(j.createdAt)));
    const idle = new Session({ id: 'x', name: 'n', cwd: '/' });
    assert.equal(idle.toJSON().alive, false);
    assert.equal(idle.toJSON().status, null);
    assert.equal(idle.toJSON().waitingFor, null);
  });
});

describe('SessionManager', () => {
  it('過去セッションを alive: false で復元する', () => {
    const m = new SessionManager(fakeStorage([{ id: 'p1', name: 'old', cwd: '/o', alive: true }]));
    assert.deepEqual(m.listSessions(), [{ id: 'p1', name: 'old', cwd: '/o', alive: false }]);
  });

  it('createSession は起動して一覧に載せ、保存する', () => {
    const storage = fakeStorage();
    const m = new SessionManager(storage);
    const s = m.createSession({ name: 'n', cwd: '/c' });
    assert.equal(s.id.length, 8);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, []);
    assert.equal(m.getSession(s.id), s);
    assert.deepEqual(m.activeSessions(), [s]);
    assert.equal(storage.saved.length, 1);
    assert.equal(storage.saved[0][0].id, s.id);
    assert.equal(storage.saved[0][0].cwd, '/c');
  });

  it('createSessionWithArgs は引数付きで起動する', () => {
    const storage = fakeStorage();
    const m = new SessionManager(storage);
    const s = m.createSessionWithArgs({ name: 'n', cwd: '/c', args: ['--resume', 'x'] });
    assert.equal(s.id.length, 8);
    assert.deepEqual(spawned[0].args, ['--resume', 'x']);
    assert.equal(m.getSession(s.id), s);
    assert.equal(storage.saved.length, 1);
    assert.equal(storage.saved[0][0].id, s.id);
  });

  it('getSession は無い id で null', () => {
    const m = new SessionManager(fakeStorage());
    assert.equal(m.getSession('nope'), null);
  });

  it('killSession はプロセスを止めて一覧から外し、保存する', () => {
    const storage = fakeStorage();
    const m = new SessionManager(storage);
    const s = m.createSession({ name: 'n', cwd: '/c' });
    m.killSession(s.id);
    assert.equal(spawned[0].killed, true);
    assert.equal(m.getSession(s.id), null);
    assert.equal(storage.saved.length, 2);
    assert.deepEqual(storage.saved[1], []);
    m.killSession('nope');
    assert.equal(storage.saved.length, 2);
  });

  it('restartSession は過去セッションの名前と cwd で起動し直し、過去から外す', () => {
    const m = new SessionManager(fakeStorage([{ id: 'p1', name: 'old', cwd: '/o' }]));
    const s = m.restartSession('p1');
    assert.equal(s.name, 'old');
    assert.equal(s.cwd, '/o');
    assert.equal(spawned[0].opts.cwd, '/o');
    const list = m.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, s.id);
    assert.equal(m.restartSession('nope'), null);
  });

  it('restartSession は指定した過去セッションだけを起動し直し、他の過去セッションは残す', () => {
    const m = new SessionManager(
      fakeStorage([
        { id: 'p1', name: 'a', cwd: '/a' },
        { id: 'p2', name: 'b', cwd: '/b' },
      ]),
    );
    const s = m.restartSession('p2');
    assert.equal(s.name, 'b');
    assert.equal(s.cwd, '/b');
    assert.deepEqual(
      m.listSessions().map((x) => x.id),
      [s.id, 'p1'],
    );
  });

  it('新しいセッションの ID が過去セッションと重なったら、過去の方を一覧から外す', () => {
    const m = new SessionManager(
      fakeStorage([
        { id: 'abcd1234', name: 'old', cwd: '/o' },
        { id: 'keep0001', name: 'k', cwd: '/k' },
        { id: 'ef567890', name: 'old2', cwd: '/o2' },
      ]),
    );
    randomUUID.mockReturnValueOnce('abcd1234-0000-4000-8000-000000000000');
    const a = m.createSession({ name: 'n', cwd: '/c' });
    randomUUID.mockReturnValueOnce('ef567890-0000-4000-8000-000000000000');
    const b = m.createSessionWithArgs({ name: 'n2', cwd: '/c2', args: [] });
    assert.equal(a.id, 'abcd1234');
    assert.equal(b.id, 'ef567890');
    const list = m.listSessions();
    assert.deepEqual(
      list.map((x) => [x.id, x.alive]),
      [
        ['abcd1234', true],
        ['ef567890', true],
        ['keep0001', false],
      ],
    );
  });

  it('removePastSession は過去セッションを外して保存する', () => {
    const storage = fakeStorage([
      { id: 'p1', name: 'a', cwd: '/a' },
      { id: 'p2', name: 'b', cwd: '/b' },
    ]);
    const m = new SessionManager(storage);
    m.removePastSession('p1');
    assert.deepEqual(
      m.listSessions().map((s) => s.id),
      ['p2'],
    );
    assert.equal(storage.saved.length, 1);
  });

  it('listSessions は起動中を先に、過去セッションを後に並べる', () => {
    const m = new SessionManager(fakeStorage([{ id: 'p1', name: 'a', cwd: '/a' }]));
    const s = m.createSession({ name: 'n', cwd: '/c' });
    const list = m.listSessions();
    assert.deepEqual(
      list.map((x) => x.id),
      [s.id, 'p1'],
    );
    assert.equal(list[0].alive, true);
  });

  it('refreshStatuses は状態の変化を反映して true を返し、変化がなければ false', async () => {
    const m = new SessionManager(fakeStorage());
    const s = m.createSession({ name: 'n', cwd: '/c' });
    statusByPid.set(s.claudePid, { status: 'waiting', waitingFor: 'input needed' });
    assert.equal(await m.refreshStatuses(), true);
    assert.equal(s.status, 'waiting');
    assert.equal(s.waitingFor, 'input needed');
    assert.equal(await m.refreshStatuses(), false);

    // waitingFor だけ変わっても検知する
    statusByPid.set(s.claudePid, { status: 'waiting', waitingFor: 'permission prompt' });
    assert.equal(await m.refreshStatuses(), true);
    assert.equal(s.waitingFor, 'permission prompt');

    // status だけ変わっても検知する
    statusByPid.set(s.claudePid, { status: 'busy', waitingFor: 'permission prompt' });
    assert.equal(await m.refreshStatuses(), true);
    assert.equal(s.status, 'busy');
  });

  it('refreshStatuses は終了したセッション（pid なし）を飛ばす', async () => {
    const m = new SessionManager(fakeStorage());
    const s = m.createSession({ name: 'n', cwd: '/c' });
    spawned[0].exitHandler({ exitCode: 0 });
    fallbackStatus = { status: 'busy', waitingFor: 'input needed' };
    assert.equal(await m.refreshStatuses(), false);
    assert.equal(s.status, null);
    assert.equal(s.waitingFor, null);
  });
});

describe('ReadonlySession / ReadonlySessionManager', () => {
  it('toJSON は閲覧タブの形を返す', () => {
    const s = new ReadonlySession({ id: 'r1', name: 'n', cwd: '/c', claudeSessionId: 'cs', projectDir: 'pd' });
    assert.deepEqual(s.toJSON(), {
      id: 'r1',
      name: 'n',
      cwd: '/c',
      claudeSessionId: 'cs',
      projectDir: 'pd',
      createdAt: s.createdAt,
      alive: true,
      type: 'readonly',
    });
    assert.equal(s.type, 'readonly');
    assert.ok(!Number.isNaN(Date.parse(s.createdAt)));
    assert.equal(spawned.length, 0);
  });

  it('指定した id が空いていればそれで作る', () => {
    const m = new ReadonlySessionManager();
    const s = m.create({ id: 'keep-id', name: 'n', cwd: '/c', claudeSessionId: 'cs', projectDir: 'pd' });
    assert.equal(s.id, 'keep-id');
    assert.equal(m.getSession('keep-id'), s);
  });

  it('指定した id が使用中なら新しい id で作る', () => {
    const m = new ReadonlySessionManager();
    const a = m.create({ id: 'dup', name: 'a' });
    const b = m.create({ id: 'dup', name: 'b' });
    assert.equal(a.id, 'dup');
    assert.notEqual(b.id, 'dup');
    assert.equal(b.id.length, 8);
    assert.equal(m.getSession('dup'), a);
    assert.equal(m.listSessions().length, 2);
  });

  it('getSession は無い id で null', () => {
    assert.equal(new ReadonlySessionManager().getSession('x'), null);
  });
});
