import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  CWD_ROOT,
  addCustomRoot,
  buildRootOptions,
  loadCustomRoots,
  loadRoot,
  normalizeRootInput,
  resolveRootPath,
  rootLabel,
  saveCustomRoots,
  saveRoot,
} from '../client/src/utils/filerRoots.js';

const HOME = '/home/user';

describe('normalizeRootInput', () => {
  it('~ を home に展開する', () => {
    assert.equal(normalizeRootInput('~', HOME), HOME);
    assert.equal(normalizeRootInput('~/tmp/reports', HOME), '/home/user/tmp/reports');
  });

  it('末尾スラッシュと連続スラッシュを畳む', () => {
    assert.equal(normalizeRootInput('/tmp/foo/', HOME), '/tmp/foo');
    assert.equal(normalizeRootInput('//tmp///foo', HOME), '/tmp/foo');
    assert.equal(normalizeRootInput('/', HOME), '/');
  });

  it('絶対パスにならないものは null', () => {
    assert.equal(normalizeRootInput('', HOME), null);
    assert.equal(normalizeRootInput('   ', HOME), null);
    assert.equal(normalizeRootInput('tmp/foo', HOME), null);
    assert.equal(normalizeRootInput('~tmp', HOME), null);
  });

  it('前後の空白は無視する', () => {
    assert.equal(normalizeRootInput('  /tmp/foo  ', HOME), '/tmp/foo');
    assert.equal(normalizeRootInput(' ~/tmp ', HOME), '/home/user/tmp');
  });

  it('home が無ければ ~ は展開できないので null', () => {
    assert.equal(normalizeRootInput('~/tmp', null), null);
  });
});

describe('rootLabel', () => {
  it('home 配下は ~ に畳む', () => {
    assert.equal(rootLabel(HOME, HOME), '~');
    assert.equal(rootLabel('/home/user/tmp', HOME), '~/tmp');
  });

  it('home 外はそのまま', () => {
    assert.equal(rootLabel('/tmp/foo', HOME), '/tmp/foo');
    // 前方一致だけで畳まない（別ユーザーのホームを ~ にしない）
    assert.equal(rootLabel('/home/user2/tmp', HOME), '/home/user2/tmp');
  });

  it('パスが無ければ空文字', () => {
    assert.equal(rootLabel(null, HOME), '');
    assert.equal(rootLabel(undefined, HOME), '');
    assert.equal(rootLabel('', HOME), '');
  });
});

describe('buildRootOptions', () => {
  it('cwd → ~/tmp → ~ → /tmp の順に並べる', () => {
    const options = buildRootOptions({
      cwd: '/home/user/gh/proj',
      home: HOME,
      homeTmp: '/home/user/tmp',
      customRoots: [],
    });
    assert.deepEqual(
      options.map((o) => o.value),
      [CWD_ROOT, '/home/user/tmp', HOME, '/tmp'],
    );
    assert.equal(options[0].label, 'cwd: ~/gh/proj');
    assert.equal(options[1].label, '~/tmp');
  });

  it('cwd・~/tmp が無ければその候補は出さない', () => {
    const options = buildRootOptions({ cwd: null, home: HOME, homeTmp: null, customRoots: [] });
    assert.deepEqual(
      options.map((o) => o.value),
      [HOME, '/tmp'],
    );
  });

  it('各候補はラベルと開くパスを持つ', () => {
    const options = buildRootOptions({
      cwd: '/home/user/gh/proj',
      home: HOME,
      homeTmp: '/home/user/tmp',
      customRoots: ['/home/user/memo'],
    });
    assert.deepEqual(options, [
      { value: CWD_ROOT, label: 'cwd: ~/gh/proj', path: '/home/user/gh/proj' },
      { value: '/home/user/tmp', label: '~/tmp', path: '/home/user/tmp' },
      { value: HOME, label: '~', path: HOME },
      { value: '/tmp', label: '/tmp', path: '/tmp' },
      { value: '/home/user/memo', label: '~/memo', path: '/home/user/memo' },
    ]);
  });

  it('home が分からなければ ~ の候補は出さず、/tmp だけは必ず出す', () => {
    assert.deepEqual(buildRootOptions({ cwd: null, home: null, homeTmp: null }), [
      { value: '/tmp', label: '/tmp', path: '/tmp' },
    ]);
  });

  it('カスタムは末尾に足し、プリセットと重複するものは足さない', () => {
    const options = buildRootOptions({
      cwd: '/home/user/gh/proj',
      home: HOME,
      homeTmp: '/home/user/tmp',
      customRoots: ['/home/user/memo', '/tmp'],
    });
    assert.deepEqual(
      options.map((o) => o.value),
      [CWD_ROOT, '/home/user/tmp', HOME, '/tmp', '/home/user/memo'],
    );
  });
});

describe('resolveRootPath', () => {
  it('sentinel は cwd に解決する', () => {
    assert.equal(resolveRootPath(CWD_ROOT, { cwd: '/home/user/gh/proj', home: HOME }), '/home/user/gh/proj');
    assert.equal(resolveRootPath(null, { cwd: '/home/user/gh/proj', home: HOME }), '/home/user/gh/proj');
  });

  it('cwd が無いセッションでは home に落とす', () => {
    assert.equal(resolveRootPath(CWD_ROOT, { cwd: null, home: HOME }), HOME);
    assert.equal(resolveRootPath(CWD_ROOT, { cwd: null, home: null }), '/tmp');
  });

  it('パスが選ばれていればそれを使う', () => {
    assert.equal(resolveRootPath('/home/user/tmp', { cwd: '/home/user/gh/proj', home: HOME }), '/home/user/tmp');
  });
});

describe('addCustomRoot', () => {
  it('新しいものを先頭に積み、重複は寄せる', () => {
    let list = addCustomRoot([], '/home/user/a');
    list = addCustomRoot(list, '/home/user/b');
    list = addCustomRoot(list, '/home/user/a');
    assert.deepEqual(list, ['/home/user/a', '/home/user/b']);
  });

  it('プリセットと同じパスは履歴に持たない', () => {
    assert.deepEqual(addCustomRoot([], '/tmp', ['/tmp', HOME]), []);
  });

  it('履歴がまだ無ければ（null）その 1 件だけになる', () => {
    assert.deepEqual(addCustomRoot(null, '/home/user/a'), ['/home/user/a']);
    assert.deepEqual(addCustomRoot(undefined, '/home/user/a', ['/tmp']), ['/home/user/a']);
  });

  it('5 件で打ち切る', () => {
    let list = [];
    for (const n of [1, 2, 3, 4, 5, 6]) list = addCustomRoot(list, `/tmp/${n}`);
    assert.deepEqual(list, ['/tmp/6', '/tmp/5', '/tmp/4', '/tmp/3', '/tmp/2']);
  });
});

describe('ルート選択と手入力履歴の保存', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('保存が無ければ cwd を選ぶ', () => {
    assert.equal(loadRoot(), CWD_ROOT);
    assert.equal(loadRoot(), 'cwd');
  });

  it('選んだルートは filerRoot キーに保存して読み戻せる', () => {
    saveRoot('/home/user/tmp');
    assert.equal(store.get('filerRoot'), '/home/user/tmp');
    assert.equal(loadRoot(), '/home/user/tmp');
  });

  it('空の値を保存すると cwd に戻る', () => {
    saveRoot('/home/user/tmp');
    saveRoot(null);
    assert.equal(store.get('filerRoot'), 'cwd');
    assert.equal(loadRoot(), 'cwd');
  });

  it('手入力の履歴は filerCustomRoots キーに JSON で保存して読み戻せる', () => {
    saveCustomRoots(['/home/user/a', '/tmp/b']);
    assert.equal(store.get('filerCustomRoots'), '["/home/user/a","/tmp/b"]');
    assert.deepEqual(loadCustomRoots(), ['/home/user/a', '/tmp/b']);
  });

  it('null を保存すると空の履歴になる', () => {
    saveCustomRoots(['/home/user/a']);
    saveCustomRoots(null);
    assert.equal(store.get('filerCustomRoots'), '[]');
    assert.deepEqual(loadCustomRoots(), []);
  });

  it('履歴が無ければ空配列', () => {
    assert.deepEqual(loadCustomRoots(), []);
  });

  it('絶対パスの文字列だけを読み戻す', () => {
    store.set('filerCustomRoots', JSON.stringify(['/home/user/a', 'relative/b', 42, null, '/tmp/c/', 'x/']));
    assert.deepEqual(loadCustomRoots(), ['/home/user/a', '/tmp/c/']);
  });

  it('配列でない値・壊れた JSON は捨てる', () => {
    store.set('filerCustomRoots', JSON.stringify({ 0: '/tmp/a' }));
    assert.deepEqual(loadCustomRoots(), []);
    store.set('filerCustomRoots', '"/tmp/a"');
    assert.deepEqual(loadCustomRoots(), []);
    store.set('filerCustomRoots', '[broken');
    assert.deepEqual(loadCustomRoots(), []);
  });
});
