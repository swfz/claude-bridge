import { test, expect } from '@playwright/test';

// 差分ドロワーの「コミット」「ターン」の範囲（第 3 段階）。diff-view.spec.js と同じく WebSocket を差し替えて
// diff_sources / session_diff を手で返す
const SESSION = {
  id: 'e2e-diffsrc-tab',
  type: 'readonly',
  claudeSessionId: 'e2e-diffsrc-claude',
  name: 'e2e diff source',
  cwd: '/home/e2e/diff-source',
  alive: true,
};

const SHOTS = process.env.E2E_SHOT_DIR;

function patch(path, oldLine, newLine, from = 1) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from},2 +${from},2 @@`,
    ' keep',
    `-${oldLine}`,
    `+${newLine}`,
    '',
  ].join('\n');
}

const file = (path, oldLine, newLine, extra = {}) => ({
  path,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  patch: patch(path, oldLine, newLine),
  ...extra,
});

// 編集ごとの差分（同じ行番号の hunk が 2 つ）
const PER_EDIT_PATCH = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -2,1 +2,1 @@ 編集 1/2',
  '-one',
  '+two',
  '@@ -2,1 +2,1 @@ 編集 2/2',
  '-two',
  '+three',
  '',
].join('\n');

const DIFFS = {
  'all:': [file('src/a.js', 'wt old', 'wt new')],
  'session:': [file('src/a.js', 'wt old', 'wt new')],
  'commit:abc1234': [file('src/a.js', 'c1 old', 'c1 new')],
  'commit:def5678': [file('src/b.js', 'c2 old', 'c2 new')],
  'turn:3': [
    {
      path: 'src/a.js',
      status: 'modified',
      binary: false,
      additions: 2,
      deletions: 2,
      patch: PER_EDIT_PATCH,
      perEdit: true,
      editCount: 2,
    },
  ],
  'turn:1': [file('src/c.js', 't1 old', 't1 new')],
};

const SOURCES = {
  commits: [
    { hash: 'abc1234', subject: 'feat: 新しい方', turnIndex: 3 },
    { hash: 'def5678', subject: 'fix: 古い方', turnIndex: 1 },
  ],
  recent: false,
  turns: [
    { index: 3, startedAt: '2026-11-26T03:00:00Z', prompt: '三つ目の指示で src/a.js を直す', fileCount: 1 },
    { index: 1, startedAt: '2026-11-26T01:00:00Z', prompt: '最初の指示', fileCount: 1 },
  ],
};

const LATEST = { commit: 'abc1234', turn: 3 };

async function openDrawer(page, { hold = false } = {}) {
  await page.addInitScript((id) => {
    localStorage.setItem('showHome', 'false');
    localStorage.setItem('activeSessionId', id);
    localStorage.setItem('diffDrawerScope', 'all');
  }, SESSION.id);
  let socket;
  const submits = [];
  const diffRequests = [];
  const held = [];
  const state = { hold };
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'get_diff_sources') {
        ws.send(JSON.stringify({ type: 'diff_sources', sessionId: msg.sessionId, ...SOURCES }));
      }
      if (msg.type === 'get_session_diff') {
        diffRequests.push(msg);
        const resolvedRef = msg.ref ?? LATEST[msg.scope] ?? null;
        const respond = () =>
          ws.send(
            JSON.stringify({
              type: 'session_diff',
              sessionId: msg.sessionId,
              scope: msg.scope,
              ref: msg.ref ?? null,
              resolvedRef,
              root: '/home/e2e/diff-source',
              files: DIFFS[`${msg.scope}:${resolvedRef ?? ''}`] || [],
              truncated: false,
              outside: 0,
            }),
          );
        if (state.hold) held.push({ msg, respond });
        else respond();
      }
      if (msg.type === 'submit_review') submits.push(msg);
    });
  });
  await page.goto('/');
  await expect.poll(() => !!socket).toBe(true);
  socket.send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));
  const input = page.locator('.input-textarea');
  await input.fill('/diff');
  await input.press('Enter');
  const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
  await expect(drawer.locator('.diff-file')).toHaveCount(1);
  return { drawer, submits, diffRequests, held, state, socket };
}

const rectOf = (loc) => loc.evaluate((el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));

async function headerRects(drawer) {
  return {
    header: await rectOf(drawer.locator('.diff-drawer-header')),
    scope: await rectOf(drawer.locator('.diff-drawer-scope')),
    view: await rectOf(drawer.locator('.diff-segmented')),
    review: await rectOf(drawer.locator('.diff-drawer-review')),
    refresh: await rectOf(drawer.locator('.diff-drawer-refresh')),
  };
}

test.describe('差分ドロワーのコミット・ターン', () => {
  test('コミット・ターンへ切り替えて前後へ送る。選択を出し入れしてもヘッダの要素は動かない', async ({ page }) => {
    const { drawer, diffRequests } = await openDrawer(page);
    const before = await headerRects(drawer);
    await expect(drawer.locator('.diff-ref')).toHaveCount(0);

    // コミット（既定は最新）
    await drawer.locator('.diff-scope-btn', { hasText: 'コミット' }).click();
    await expect(drawer.locator('.diff-drawer-title')).toHaveText('コミット');
    const select = drawer.locator('.diff-ref-select');
    await expect(select).toHaveValue('abc1234');
    await expect(select.locator('option')).toHaveText(['abc1234 feat: 新しい方', 'def5678 fix: 古い方']);
    await expect(drawer.locator('.diff-file-name')).toHaveText('a.js');
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'commit', ref: null });
    expect(await headerRects(drawer)).toEqual(before);

    // 最新を見ている間の「取り直す」は最新（ref: null）を要求する（特定のコミットに固定しない）
    await drawer.locator('.diff-drawer-refresh').click();
    await expect.poll(() => diffRequests.length).toBeGreaterThan(1);
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'commit', ref: null });
    await expect(select).toHaveValue('abc1234');

    // ‹ で古い方へ、› で戻る（端では押せない）
    const [older, newer] = [drawer.locator('.diff-ref-step').first(), drawer.locator('.diff-ref-step').last()];
    await expect(newer).toBeDisabled();
    await older.click();
    await expect(select).toHaveValue('def5678');
    await expect(drawer.locator('.diff-file-name')).toHaveText('b.js');
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'commit', ref: 'def5678' });
    await expect(older).toBeDisabled();
    // 選んだ後の「取り直す」は選んだものを保つ
    const count = diffRequests.length;
    await drawer.locator('.diff-drawer-refresh').click();
    await expect.poll(() => diffRequests.length).toBe(count + 1);
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'commit', ref: 'def5678' });
    await expect(select).toHaveValue('def5678');
    await newer.click();
    await expect(select).toHaveValue('abc1234');

    // select で選んだ後は本文にフォーカスが戻る（↑↓ が対象の切り替えにならない）
    await select.selectOption('def5678');
    await expect(drawer.locator('.diff-file-name')).toHaveText('b.js');
    await expect(drawer.locator('.diff-drawer-body')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(select).toHaveValue('def5678');
    await expect(drawer.locator('.diff-line.cursor')).toHaveCount(1);

    // ターン: 「#番号 時刻 指示の先頭」、ref は数値で送る
    await drawer.locator('.diff-scope-btn', { hasText: 'ターン' }).click();
    await expect(drawer.locator('.diff-drawer-title')).toHaveText('ターン');
    await expect(select).toHaveValue('3');
    await expect(select.locator('option').first()).toContainText('#3');
    await expect(select.locator('option').first()).toContainText('三つ目の指示');
    await expect(drawer.locator('.diff-file-peredit')).toHaveText('編集ごと ×2');
    await older.click();
    await expect(select).toHaveValue('1');
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'turn', ref: 1 });
    expect(await headerRects(drawer)).toEqual(before);

    // 作業ツリーへ戻すと選択は消え、位置は変わらない
    await drawer.locator('.diff-scope-btn', { hasText: '全体' }).click();
    await expect(drawer.locator('.diff-ref')).toHaveCount(0);
    await expect(drawer.locator('.diff-drawer-title')).toHaveText('未コミットの差分');
    expect(await headerRects(drawer)).toEqual(before);

    // 最小幅（480px）でもヘッダは 1 行のまま、出し入れで動かない
    await page.setViewportSize({ width: 500, height: 800 });
    await expect.poll(async () => (await rectOf(drawer)).width).toBeLessThanOrEqual(500);
    const narrow = await headerRects(drawer);
    await drawer.locator('.diff-scope-btn', { hasText: 'コミット' }).click();
    await expect(select).toHaveValue('abc1234');
    expect(await headerRects(drawer)).toEqual(narrow);
  });

  test('指摘は出どころごとに分かれ、送信本文に時点が入る。作業ツリーの同じ行の指摘と混ざらない', async ({ page }) => {
    const { drawer, submits } = await openDrawer(page);
    const row = (anchor) => drawer.locator(`.diff-line[data-anchor="${anchor}"]`);

    // 作業ツリーの src/a.js:L2
    await row('new:2').locator('.diff-gutter').click();
    await page.keyboard.type('作業ツリーへの指摘');
    await page.keyboard.press('Control+Enter');

    // コミット abc1234 の同じ src/a.js:L2
    await drawer.locator('.diff-scope-btn', { hasText: 'コミット' }).click();
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('abc1234');
    // 作業ツリーの指摘は行にも「対象行が見つからない」にも出ず、「ほかの差分への指摘」に出る
    await expect(drawer.locator('.diff-file .diff-comment')).toHaveCount(0);
    await expect(drawer.locator('.diff-comment-stale')).toHaveCount(0);
    await expect(drawer.locator('.diff-others .diff-comment')).toHaveCount(1);
    await expect(drawer.locator('.diff-others .diff-comment-where')).toContainText('作業ツリー src/a.js');
    await row('new:2').locator('.diff-gutter').click();
    await page.keyboard.type('コミットへの指摘');
    await page.keyboard.press('Control+Enter');
    await row('old:2').locator('.diff-gutter').click();
    await page.keyboard.type('消した行');
    await page.keyboard.press('Control+Enter');
    await expect(drawer.locator('.diff-file .diff-comment')).toHaveCount(2);

    // ターン #3（編集ごとの差分）: 2 つ目の hunk の L2 に書くと 2 つ目の hunk に付く
    await drawer.locator('.diff-scope-btn', { hasText: 'ターン' }).click();
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('3');
    await expect(drawer.locator('.diff-others .diff-comment')).toHaveCount(3);
    await row('new:2:1').locator('.diff-gutter').click();
    await page.keyboard.type('二回目の編集');
    await page.keyboard.press('Control+Enter');
    await expect(drawer.locator('.diff-file .diff-comment')).toHaveCount(1);
    await expect(drawer.locator('.diff-file .diff-comment-stale')).toHaveCount(0);
    // 指摘欄は 2 つ目の hunk の行の直後にある
    const boxTop = (await rectOf(drawer.locator('.diff-file .diff-comment'))).top;
    expect(boxTop).toBeGreaterThan((await rectOf(row('new:2:1'))).top);
    expect(boxTop).toBeGreaterThan((await rectOf(row('new:2:0'))).top);

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/diff-turn-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-turn-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
      await drawer.locator('.diff-scope-btn', { hasText: 'コミット' }).click();
      await expect(drawer.locator('.diff-file .diff-comment')).toHaveCount(2);
      await page.screenshot({ path: `${SHOTS}/diff-commit-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-commit-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    // 一括送信は出どころを問わず全部。作業ツリー以外は時点が入る
    await expect(drawer.locator('.diff-submit')).toHaveText('4件送信');
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].items.map((i) => i.text)).toEqual([
      'src/a.js:L2 「wt new」について:\n作業ツリーへの指摘',
      'src/a.js:L2（コミット abc1234 の時点） 「c1 new」について:\nコミットへの指摘',
      'src/a.js（コミット abc1234 で削除された行 旧L2） 「c1 old」について:\n消した行',
      'src/a.js:L2（ターン #3 の途中の編集の直後の行番号） 「three」について:\n二回目の編集',
    ]);
  });

  test('読み込み中に切り替えると、遅れて届いた古い応答は捨てる', async ({ page }) => {
    const { drawer, held, state, socket } = await openDrawer(page);
    // 作業ツリーに指摘を 1 件書いておく
    await drawer.locator('.diff-line[data-anchor="new:2"] .diff-gutter').click();
    await page.keyboard.type('作業ツリーへの指摘');
    await page.keyboard.press('Control+Enter');
    state.hold = true;
    await drawer.locator('.diff-scope-btn', { hasText: 'コミット' }).click();
    await expect.poll(() => held.length).toBe(1);
    // 最新を読み込み中（ref が決まる前）は「ほかの差分への指摘」を出さない（出し入れで本文を揺らさない）
    await expect(drawer.locator('.diff-drawer-empty')).toHaveText('読み込み中...');
    await expect(drawer.locator('.diff-others')).toHaveCount(0);
    held.shift().respond();
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('abc1234');
    await expect(drawer.locator('.diff-others .diff-comment')).toHaveCount(1);

    // def5678 を要求（保留）→ 続けて abc1234 を要求（保留）。新しい方を先に返し、古い方を後から返す
    await drawer.locator('.diff-ref-step').first().click();
    await expect(drawer.locator('.diff-drawer-empty')).toHaveText('読み込み中...');
    // 読み込み中に ↓ を押しても送りボタンにフォーカスが残らない
    await page.keyboard.press('ArrowDown');
    await expect(drawer.locator('.diff-drawer-body')).toBeFocused();
    await drawer.locator('.diff-ref-select').selectOption('abc1234');
    await expect.poll(() => held.length).toBe(2);
    const [stale, latest] = held.splice(0, 2);
    expect(stale.msg.ref).toBe('def5678');
    expect(latest.msg.ref).toBe('abc1234');
    latest.respond();
    await expect(drawer.locator('.diff-file-name')).toHaveText('a.js');
    stale.respond();
    // 古い応答（b.js）は入らない。同じ接続で後から送った候補の更新が見えた時点で、古い応答も処理済み
    socket.send(
      JSON.stringify({
        type: 'diff_sources',
        sessionId: SESSION.id,
        ...SOURCES,
        commits: [{ ...SOURCES.commits[0], subject: 'feat: 届いた' }, SOURCES.commits[1]],
      }),
    );
    await expect(drawer.locator('.diff-ref-select option').first()).toHaveText('abc1234 feat: 届いた');
    await expect(drawer.locator('.diff-file-name')).toHaveText('a.js');
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('abc1234');
  });

  test('openDiffAt でコミット・ターンの行を開ける', async ({ page }) => {
    const { drawer, diffRequests } = await openDrawer(page);
    await page.evaluate(() =>
      globalThis.claudeBridge.openDiffAt({ path: 'src/b.js', side: 'new', line: 2, scope: 'commit', ref: 'def5678' }),
    );
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('def5678');
    await expect(drawer.locator('.diff-line[data-anchor="new:2"]')).toHaveClass(/flash/);
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'commit', ref: 'def5678' });
    // ターンの編集ごとの差分は hunk を省いても前方一致で当たる
    await page.evaluate(() =>
      globalThis.claudeBridge.openDiffAt({ path: 'src/a.js', side: 'new', line: 2, scope: 'turn', ref: 3 }),
    );
    await expect(drawer.locator('.diff-ref-select')).toHaveValue('3');
    await expect(drawer.locator('.diff-line[data-anchor="new:2:0"]')).toHaveClass(/flash/);
  });
});
