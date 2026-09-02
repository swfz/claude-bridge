import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CWD_ROOT,
  addCustomRoot,
  buildRootOptions,
  normalizeRootInput,
  resolveRootPath,
  rootLabel,
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

  it('5 件で打ち切る', () => {
    let list = [];
    for (const n of [1, 2, 3, 4, 5, 6]) list = addCustomRoot(list, `/tmp/${n}`);
    assert.deepEqual(list, ['/tmp/6', '/tmp/5', '/tmp/4', '/tmp/3', '/tmp/2']);
  });
});
