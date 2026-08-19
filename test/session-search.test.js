import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSearchQuery,
  matchesSearch,
  filterBySearch,
  collectProjects,
  filterByProject,
} from '../client/src/utils/sessionSearch.js';

describe('parseSearchQuery', () => {
  it('空クエリ・空白のみクエリは空配列', () => {
    assert.deepEqual(parseSearchQuery(''), []);
    assert.deepEqual(parseSearchQuery('   '), []);
    assert.deepEqual(parseSearchQuery(null), []);
    assert.deepEqual(parseSearchQuery(undefined), []);
  });

  it('半角スペースで分割し小文字化する', () => {
    assert.deepEqual(parseSearchQuery('Foo Bar'), ['foo', 'bar']);
  });

  it('全角スペースでも分割される', () => {
    assert.deepEqual(parseSearchQuery('Foo　Bar'), ['foo', 'bar']);
  });
});

describe('matchesSearch', () => {
  const session = {
    title: 'ホーム画面の改善',
    name: 'session-abc',
    cwd: '/home/sawafuji/gh/claude-bridge',
    gitBranch: 'feat/home-search',
    firstUserMessage: '検索機能を追加してほしい',
    lastUserMessage: 'テストも書いて',
    lastAssistantMessage: '実装しました',
    sessionId: 'abcdef123456',
  };

  it('term が無ければ常にマッチ', () => {
    assert.equal(matchesSearch(session, []), true);
  });

  it('タイトルの部分一致でマッチする', () => {
    assert.equal(matchesSearch(session, ['ホーム']), true);
  });

  it('cwd の部分一致でマッチする', () => {
    assert.equal(matchesSearch(session, ['claude-bridge']), true);
  });

  it('ブランチの部分一致でマッチする', () => {
    assert.equal(matchesSearch(session, ['home-search']), true);
  });

  it('メッセージ抜粋の部分一致でマッチする', () => {
    assert.equal(matchesSearch(session, ['検索機能']), true);
    assert.equal(matchesSearch(session, ['テストも']), true);
    assert.equal(matchesSearch(session, ['実装しました']), true);
  });

  it('大文字小文字を無視する', () => {
    const s = { ...session, gitBranch: 'Feat/Home-Search' };
    assert.equal(matchesSearch(s, ['home-search']), true);
    assert.equal(matchesSearch(s, ['HOME-SEARCH']), true);
  });

  it('複数 term は AND（別フィールドにまたがってよい）', () => {
    assert.equal(matchesSearch(session, ['ホーム', 'テストも']), true);
    assert.equal(matchesSearch(session, ['ホーム', '存在しない語']), false);
  });

  it('マッチしない場合は false', () => {
    assert.equal(matchesSearch(session, ['存在しない語']), false);
  });

  it('フィールドが null/undefined でも落ちない', () => {
    const s = {
      title: null,
      name: undefined,
      cwd: '/tmp/foo',
      gitBranch: null,
      firstUserMessage: undefined,
      lastUserMessage: null,
      lastAssistantMessage: undefined,
      sessionId: 'xyz',
    };
    assert.equal(matchesSearch(s, ['foo']), true);
    assert.equal(matchesSearch(s, ['nothing']), false);
  });

  it('session 自体が null/undefined でも落ちない', () => {
    assert.equal(matchesSearch(null, ['foo']), false);
    assert.equal(matchesSearch(undefined, []), true);
  });

  it('fields 指定で対象を絞れる', () => {
    // タイトルにマッチする語だが、fields を name/cwd に絞ると見つからない
    assert.equal(matchesSearch(session, ['ホーム'], ['name', 'cwd']), false);
    assert.equal(matchesSearch(session, ['claude-bridge'], ['name', 'cwd']), true);
  });
});

describe('filterBySearch', () => {
  const list = [
    { sessionId: '1', title: '検索機能の実装', cwd: '/repo/a' },
    { sessionId: '2', title: '別件のバグ修正', cwd: '/repo/b' },
    { sessionId: '3', title: null, cwd: '/repo/search-tool' },
  ];

  it('空クエリ・空白のみクエリは全件返す', () => {
    assert.deepEqual(filterBySearch(list, ''), list);
    assert.deepEqual(filterBySearch(list, '   '), list);
    assert.deepEqual(filterBySearch(list, null), list);
  });

  it('部分一致で絞り込む', () => {
    const result = filterBySearch(list, '検索');
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['1'],
    );
  });

  it('cwd での絞り込みも効く', () => {
    const result = filterBySearch(list, 'search');
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['3'],
    );
  });

  it('マッチしなければ空配列', () => {
    assert.deepEqual(filterBySearch(list, '存在しない語'), []);
  });

  it('list が null/undefined でも落ちない', () => {
    assert.deepEqual(filterBySearch(null, 'foo'), []);
    assert.deepEqual(filterBySearch(undefined, ''), []);
  });

  it('fields 指定で対象を絞れる', () => {
    // "search" は 1 のタイトルにはマッチしないが 3 の cwd にはマッチする。
    // fields を cwd のみに絞っても 3 だけが返ることを確認する
    const result = filterBySearch(list, 'search', ['cwd']);
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['3'],
    );
  });
});

describe('collectProjects', () => {
  it('複数リストからユニークなプロジェクト名をソートして返す', () => {
    const listA = [{ cwd: '/home/user/gh/zeta' }, { cwd: '/home/user/gh/alpha' }];
    const listB = [{ cwd: '/home/user/gh/alpha' }, { cwd: '/home/user/gh/beta' }];
    assert.deepEqual(collectProjects(listA, listB), ['alpha', 'beta', 'zeta']);
  });

  it('cwd が null/undefined でも落ちず除外される', () => {
    const list = [{ cwd: null }, { cwd: undefined }, {}, { cwd: '/home/user/gh/alpha' }];
    assert.deepEqual(collectProjects(list), ['alpha']);
  });

  it('リストが空/未指定でも空配列', () => {
    assert.deepEqual(collectProjects(), []);
    assert.deepEqual(collectProjects([], null, undefined), []);
  });
});

describe('filterByProject', () => {
  const list = [
    { sessionId: '1', cwd: '/home/user/gh/alpha' },
    { sessionId: '2', cwd: '/home/user/gh/beta' },
    { sessionId: '3', cwd: '/home/user/gh/alpha/.worktrees/feature' },
  ];

  it('project が falsy ならそのまま返す（解除時に全件戻る）', () => {
    assert.deepEqual(filterByProject(list, null), list);
    assert.deepEqual(filterByProject(list, ''), list);
    assert.deepEqual(filterByProject(list, undefined), list);
  });

  it('指定したプロジェクトのみに絞る（worktree 配下も同じプロジェクトとして拾う）', () => {
    const result = filterByProject(list, 'alpha');
    assert.deepEqual(
      result.map((s) => s.sessionId),
      ['1', '3'],
    );
  });

  it('list が null/undefined でも落ちない', () => {
    assert.deepEqual(filterByProject(null, 'alpha'), []);
  });
});
