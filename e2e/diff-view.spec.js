import { test, expect } from '@playwright/test';

// 差分ドロワーの見やすさとキーボード操作（構文ハイライト・左右表示・ファイル一覧・確認済み・行カーソル）。
// diff-review.spec.js と同じく WebSocket を差し替えて session_diff を手で返す
const SESSION = {
  id: 'e2e-diffview-tab',
  type: 'readonly',
  claudeSessionId: 'e2e-diffview-claude',
  name: 'e2e diff view',
  cwd: '/home/e2e/diff-view',
  alive: true,
};

const SHOTS = process.env.E2E_SHOT_DIR;

// 旧: 1 /**, 2  * old doc, 3  */, 4 export…, 5 return a + b;, 6 }
// 新: 1 /**, 2  * new doc, 3  * more, 4  */, 5 export…, 6 return a + b + 0;, 7 }
const UTIL_PATCH = [
  'diff --git a/src/util.js b/src/util.js',
  '--- a/src/util.js',
  '+++ b/src/util.js',
  '@@ -1,6 +1,7 @@',
  ' /**',
  '- * old doc',
  '+ * new doc',
  '+ * more',
  '  */',
  ' export function add(a, b) {',
  '-  return a + b;',
  '+  return a + b + 0;',
  ' }',
  '',
].join('\n');

const STYLE_PATCH = [
  'diff --git a/src/style.css b/src/style.css',
  '@@ -1,3 +1,3 @@',
  ' .a {',
  '-  color: red;',
  '+  color: blue;',
  ' }',
  '@@ -20,2 +20,3 @@',
  ' .b {',
  '+  margin: 0;',
  ' }',
  '',
].join('\n');

const README_PATCH = [
  'diff --git a/README.md b/README.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+**bold** and _it_',
  '',
].join('\n');

const FILES = [
  { path: 'src/util.js', status: 'modified', binary: false, additions: 3, deletions: 2, patch: UTIL_PATCH },
  { path: 'src/style.css', status: 'modified', binary: false, additions: 2, deletions: 1, patch: STYLE_PATCH },
  { path: 'README.md', status: 'untracked', binary: false, additions: 2, deletions: 0, patch: README_PATCH },
];

async function openDrawer(page, init = {}) {
  await page.addInitScript(
    ({ id, init }) => {
      localStorage.setItem('showHome', 'false');
      localStorage.setItem('activeSessionId', id);
      localStorage.setItem('diffDrawerScope', 'all');
      for (const [k, v] of Object.entries(init)) {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
    },
    { id: SESSION.id, init },
  );
  let socket;
  let connections = 0;
  const submits = [];
  const diffRequests = [];
  let files = FILES;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
    connections += 1;
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'get_session_diff') {
        diffRequests.push(msg);
        ws.send(
          JSON.stringify({
            type: 'session_diff',
            sessionId: msg.sessionId,
            scope: msg.scope,
            root: '/home/e2e/diff-view',
            files,
            truncated: false,
            outside: 0,
          }),
        );
      }
      if (msg.type === 'submit_review') submits.push(msg);
    });
  });
  await page.goto('/');
  await expect.poll(() => !!socket).toBe(true);
  socket.send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));
  const input = page.locator('.input-textarea');
  const open = async () => {
    await input.fill('/diff');
    await input.press('Enter');
    await expect(page.locator('.diff-drawer .diff-file')).toHaveCount(3);
  };
  await open();
  // リロードして開き直す。古い接続を見て待ちが通らないよう、新しい接続が来るまで待ってから session_list を送る
  const reload = async () => {
    const before = connections;
    await page.reload();
    await expect.poll(() => connections).toBeGreaterThan(before);
    socket.send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));
    await open();
  };
  return {
    drawer: page.locator('.diff-drawer'),
    submits,
    diffRequests,
    socket: () => socket,
    reopen: open,
    reload,
    setFiles: (next) => {
      files = next;
    },
  };
}

const fileOf = (drawer, path) => drawer.locator(`.diff-file[data-file-path="${path}"]`);
const rectOf = (loc) => loc.evaluate((el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));

test.describe('差分ドロワーの見やすさとキーボード操作', () => {
  test('構文ハイライト（複数行コメントも崩れない）と、ファイル一覧・確認済み', async ({ page }) => {
    const { drawer, reopen } = await openDrawer(page, { diffDrawerView: 'unified', diffReviewed: null });
    const util = fileOf(drawer, 'src/util.js');
    // 新側を連結して色付けするので、2 行目（* new doc）も /** … */ のコメントとして色が付く
    await expect(util.locator('.diff-line[data-anchor="new:2"] .hljs-comment')).toHaveCount(1);
    await expect(util.locator('.diff-line[data-anchor="old:2"] .hljs-comment')).toHaveCount(1);
    await expect(util.locator('.diff-line[data-anchor="new:5"] .hljs-keyword').first()).toHaveText('export');
    // 追加・削除の背景色は残る
    const addBg = await util
      .locator('.diff-line[data-anchor="new:6"]')
      .evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor);
    expect(addBg).not.toBe('rgba(0, 0, 0, 0)');
    // 拡張子の無い・知らない言語は素のテキスト
    await expect(fileOf(drawer, 'README.md').locator('.diff-line[data-anchor="new:1"]')).toContainText('# Title');
    // ライトでは Markdown の太字・斜体が github-dark の淡い本文色（#c9d1d9）のまま残らない
    await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
    const readme2 = fileOf(drawer, 'README.md').locator('.diff-line[data-anchor="new:2"]');
    for (const cls of ['.hljs-strong', '.hljs-emphasis']) {
      const color = await readme2
        .locator(cls)
        .evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).color);
      expect(color, cls).not.toBe('rgb(201, 209, 217)');
    }
    await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/diff-unified-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-unified-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    // ── ファイル一覧: クリックでそのファイルへ。今見ているファイルを示す
    const list = drawer.locator('.diff-filelist');
    await expect(list.locator('.diff-filelist-item')).toHaveCount(3);
    await expect(list.locator('.diff-filelist-head')).toContainText('0/3');
    await list.locator('.diff-filelist-item', { hasText: 'README.md' }).click();
    await expect(fileOf(drawer, 'README.md').locator('.diff-file-header')).toBeInViewport();
    await expect(list.locator('.diff-filelist-item.current')).toContainText('README.md');
    await list.locator('.diff-filelist-item', { hasText: 'util.js' }).click();
    await expect(list.locator('.diff-filelist-item.current')).toContainText('util.js');

    // ── 確認済み: 付けると畳まれ、件数が増える。見出し・一覧の項目は動かない
    const header = util.locator('.diff-file-header');
    const headerBefore = await rectOf(header);
    const itemsBefore = await list
      .locator('.diff-filelist-item')
      .evaluateAll((els) => els.map((e) => JSON.parse(JSON.stringify(e.getBoundingClientRect()))));
    await util.locator('.diff-file-reviewed').click();
    await expect(util.locator('.diff-line')).toHaveCount(0);
    await expect(util.locator('.diff-file-reviewed')).toHaveAttribute('aria-pressed', 'true');
    await expect(drawer.locator('.diff-drawer-reviewed')).toHaveText('確認済み 1/3');
    await expect(list.locator('.diff-filelist-item.reviewed')).toHaveCount(1);
    expect(await rectOf(header)).toEqual(headerBefore);
    expect(
      await list
        .locator('.diff-filelist-item')
        .evaluateAll((els) => els.map((e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())))),
    ).toEqual(itemsBefore);

    // 閉じて開き直しても残る（localStorage）
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await reopen();
    await expect(util.locator('.diff-file-reviewed')).toHaveAttribute('aria-pressed', 'true');
    await expect(util.locator('.diff-line')).toHaveCount(0);
    // 外すと開く
    await util.locator('.diff-file-reviewed').click();
    await expect(util.locator('.diff-line').first()).toBeVisible();
    await expect(drawer.locator('.diff-drawer-reviewed')).toHaveText('確認済み 0/3');

    // ── 一覧の開閉でヘッダの並びは動かない
    const scope = drawer.locator('.diff-drawer-scope');
    const scopeBefore = await rectOf(scope);
    await drawer.locator('.diff-list-toggle').click();
    await expect(list).toHaveCount(0);
    expect(await rectOf(scope)).toEqual(scopeBefore);
    await drawer.locator('.diff-list-toggle').click();
    await expect(list).toBeVisible();
    expect(await rectOf(scope)).toEqual(scopeBefore);
  });

  test('左右に並べて、左右それぞれの行に指摘を書ける。狭いと 1 列に倒れる', async ({ page }) => {
    const { drawer, submits, socket } = await openDrawer(page, { diffDrawerView: 'unified' });
    await drawer.locator('.diff-segment', { hasText: '左右' }).click();
    await expect(drawer.locator('.diff-segment.active')).toHaveText('左右');
    const util = fileOf(drawer, 'src/util.js');
    await expect(util.locator('.diff-split-line').first()).toBeVisible();

    // 削除（旧 L2）と追加（新 L2）は同じ表示行に横並び、新 L3 は左が空
    const pair = util.locator('.diff-split-line', { has: page.locator('[data-anchor="old:2"]') });
    await expect(pair.locator('.diff-cell').nth(1)).toHaveAttribute('data-anchor', 'new:2');
    const only = util.locator('.diff-split-line', { has: page.locator('[data-anchor="new:3"]') });
    await expect(only.locator('.diff-cell').first()).toHaveClass(/empty/);
    const leftBox = await rectOf(pair.locator('.diff-cell').first());
    const rightBox = await rectOf(pair.locator('.diff-cell').nth(1));
    expect(rightBox.left).toBeGreaterThan(leftBox.left);
    expect(rightBox.top).toBe(leftBox.top);

    // 左（削除行）に指摘
    await util.locator('[data-anchor="old:5"] .diff-gutter').click();
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('削除行 旧L5');
    await page.keyboard.type('左の指摘');
    await page.keyboard.press('Control+Enter');
    // 右（追加行）に指摘
    await util.locator('[data-anchor="new:6"] .diff-gutter').click();
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('L6');
    await page.keyboard.type('右の指摘');
    await page.keyboard.press('Control+Enter');
    // 左の文脈行は新側の行として扱う
    const ctx = util.locator('.diff-split-line', { has: page.locator('[data-anchor="new:1"]') });
    await ctx.locator('.diff-cell').first().locator('.diff-gutter').click();
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('L1');
    await page.keyboard.press('Escape');
    // 右の範囲（Shift+クリック）
    await util.locator('[data-anchor="new:2"] .diff-gutter').click();
    await util.locator('[data-anchor="new:3"] .diff-gutter').click({ modifiers: ['Shift'] });
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('L2-L3');
    await page.keyboard.type('範囲の指摘');
    await page.keyboard.press('Control+Enter');

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/diff-split-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-split-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].items.map((i) => i.text.split('\n')[0])).toEqual([
      'src/util.js（削除された行 旧L5） 「return a + b;」について:',
      'src/util.js:L6 「return a + b + 0;」について:',
      'src/util.js:L2-L3 「* new doc ⏎ * more」について:',
    ]);
    socket().send(JSON.stringify({ type: 'submit_review_result', ok: true, requestId: submits[0].requestId }));
    await expect(drawer.locator('.diff-comment')).toHaveCount(0);

    // 選んだ表示は覚える
    expect(await page.evaluate(() => localStorage.getItem('diffDrawerView'))).toBe('split');

    // 狭い画面: 一覧は既定で畳み、左右表示は 1 列に倒す。ヘッダは折り返さない
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(drawer.locator('.diff-filelist')).toHaveCount(0);
    await expect(util.locator('.diff-split-line')).toHaveCount(0);
    await expect(util.locator('.diff-line[data-anchor="new:2"]')).toBeVisible();
    await expect(drawer.locator('.diff-segment.active')).toHaveText('左右');
    const tops = await drawer
      .locator('.diff-drawer-header > *')
      .evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)),
      );
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  });

  test('キーボードだけで行を選び、範囲を広げ、指摘を書いて送る', async ({ page }) => {
    const { drawer, submits } = await openDrawer(page, { diffDrawerView: 'unified' });
    const util = fileOf(drawer, 'src/util.js');
    const style = fileOf(drawer, 'src/style.css');
    await expect(drawer.locator('.diff-drawer-body')).toBeFocused();
    const cursor = drawer.locator('.diff-line.cursor');

    // 最初の ↓ は先頭の行へ
    await page.keyboard.press('ArrowDown');
    await expect(cursor).toHaveCount(1);
    await expect(cursor).toHaveAttribute('data-anchor', 'new:1');
    // カーソルが動いても行の位置は変わらない（outline と下地だけ）
    const rowsBefore = await util
      .locator('.diff-line')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    await page.keyboard.press('ArrowDown');
    await expect(cursor).toHaveAttribute('data-anchor', 'old:2');
    await page.keyboard.press('Alt+j');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:2');
    await page.keyboard.press('Alt+k');
    await expect(cursor).toHaveAttribute('data-anchor', 'old:2');
    expect(
      await util.locator('.diff-line').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top)),
    ).toEqual(rowsBefore);

    // 次のファイル（]）・次の hunk（n）・前の hunk（p）
    await page.keyboard.press(']');
    await expect(style.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:1');
    await page.keyboard.press('n');
    await expect(style.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:20');
    await page.keyboard.press('p');
    await expect(style.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:1');
    await page.keyboard.press('[');
    await expect(util.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:1');

    // 追加行 新 L2 から Shift+↓ で新 L3 まで
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:2');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:3');
    await expect(util.locator('.diff-line.target')).toHaveCount(2);
    // 範囲は Esc で解ける（ドロワーは閉じない）
    await page.keyboard.press('Escape');
    await expect(util.locator('.diff-line.target')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowDown');
    // 削除行（旧 L2）の上へは広げられない（側が違う）
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:2');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:3');

    // Enter で範囲の指摘欄を開いて書く（改行は入らない）
    await page.keyboard.press('Enter');
    const box = util.locator('.diff-comment.active');
    await expect(box.locator('.diff-comment-where')).toHaveText('L2-L3');
    await expect(box.locator('textarea')).toBeFocused();
    await expect(box.locator('textarea')).toHaveValue('');
    await page.keyboard.type('キーボードの指摘');
    // 指摘欄の中では ↓ はカーソルを動かさない
    await page.keyboard.press('ArrowDown');
    await expect(cursor).toHaveAttribute('data-anchor', 'new:3');
    await page.keyboard.press('Control+Enter');
    await expect(drawer.locator('.diff-drawer-body')).toBeFocused();

    // 削除行へ移って 1 行の指摘
    await page.keyboard.press('ArrowDown'); // */
    await page.keyboard.press('ArrowDown'); // export
    await page.keyboard.press('ArrowDown'); // - return
    await expect(cursor).toHaveAttribute('data-anchor', 'old:5');
    await page.keyboard.press('Enter');
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('削除行 旧L5');
    await page.keyboard.type('削除の理由');
    await page.keyboard.press('Escape');

    // Ctrl+D はカーソルを半画面分先へ（先は同じか後ろ）
    await page.keyboard.press('Control+d');
    await expect(cursor).toHaveCount(1);

    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].items.map((i) => i.text)).toEqual([
      'src/util.js:L2-L3 「* new doc ⏎ * more」について:\nキーボードの指摘',
      'src/util.js（削除された行 旧L5） 「return a + b;」について:\n削除の理由',
    ]);
  });

  test('左端のつまみで幅を変えて覚え、ダブルクリックで既定に戻す。周りは動かない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { drawer, reload } = await openDrawer(page, { diffDrawerView: 'unified' });
    const handle = drawer.locator('.diff-drawer-resize');
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    const before = await rectOf(drawer);
    // 既定は 80%（1024px）
    expect(Math.round(before.width)).toBe(1024);

    // つまみのホバー・押しただけ（動かす前）では周りの要素は動かない
    const watched = ['.diff-drawer-header', '.diff-drawer-body', '.diff-filelist', '.diff-file-header'];
    const tops = () =>
      Promise.all(
        watched.map((sel) =>
          drawer
            .locator(sel)
            .first()
            .evaluate((el) => el.getBoundingClientRect()),
        ),
      ).then((rs) => rs.map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]));
    const layout0 = await tops();
    const hb = await rectOf(handle);
    await page.mouse.move(hb.left + 2, hb.top + 200);
    expect(await tops()).toEqual(layout0);
    await page.mouse.down();
    expect(await tops()).toEqual(layout0);
    expect(Math.round((await rectOf(drawer)).width)).toBe(1024);
    // ドラッグ中はテキストを選択させない
    await page.mouse.move(hb.left + 2 - 60, hb.top + 200, { steps: 3 });
    expect(await page.evaluate(() => globalThis.document.body.style.userSelect)).toBe('none');
    await page.mouse.move(hb.left + 2 - 100, hb.top + 200, { steps: 3 });
    await page.mouse.up();
    expect(await page.evaluate(() => globalThis.document.body.style.userSelect)).toBe('');
    expect(Math.round((await rectOf(drawer)).width)).toBe(1124);
    expect(await page.evaluate(() => localStorage.getItem('diffDrawerWidth'))).toBe('1124');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-resized-wide.png` });

    // ←/→ でも変えられる（← で広がる）
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    expect(Math.round((await rectOf(drawer)).width)).toBe(1092);
    await page.keyboard.press('ArrowLeft');
    expect(Math.round((await rectOf(drawer)).width)).toBe(1124);
    // 上限（画面の 95%）より広げない
    await page.keyboard.press('Shift+ArrowLeft');
    expect(Math.round((await rectOf(drawer)).width)).toBe(1216);
    await page.keyboard.press('Shift+ArrowRight');
    expect(Math.round((await rectOf(drawer)).width)).toBe(1056);
    await expect(handle).toHaveAttribute('aria-valuenow', '1056');

    // リロードしても覚えている
    await reload();
    expect(Math.round((await rectOf(drawer)).width)).toBe(1056);
    // 画面を狭めて上限を超えたら詰め、広げ直せば戻る
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect.poll(async () => Math.round((await rectOf(drawer)).width)).toBe(950);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => Math.round((await rectOf(drawer)).width)).toBe(1056);

    // ダブルクリックで既定の幅に戻し、保存も消す
    await handle.dblclick();
    await expect.poll(async () => Math.round((await rectOf(drawer)).width)).toBe(1024);
    expect(await page.evaluate(() => localStorage.getItem('diffDrawerWidth'))).toBeNull();
  });

  test('ドロワーを狭めると左右表示が 1 列に倒れ、広げると戻る（判定はドロワーの幅）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { drawer } = await openDrawer(page, { diffDrawerView: 'split', diffFileListOpen: '1' });
    const util = fileOf(drawer, 'src/util.js');
    await expect(util.locator('.diff-split-line').first()).toBeVisible();
    const handle = drawer.locator('.diff-drawer-resize');
    const hb = await rectOf(handle);
    // 1024 → 824 にすると、一覧（220px）を除いた差分の列は 720px 未満になる
    await page.mouse.move(hb.left + 2, hb.top + 200);
    await page.mouse.down();
    await page.mouse.move(hb.left + 202, hb.top + 200, { steps: 4 });
    await page.mouse.up();
    expect(Math.round((await rectOf(drawer)).width)).toBe(824);
    await expect(util.locator('.diff-split-line')).toHaveCount(0);
    await expect(util.locator('.diff-line[data-anchor="new:2"]')).toBeVisible();
    // 選んだ表示は左右のまま（トグルの title で知らせる）
    await expect(drawer.locator('.diff-segment.active')).toHaveText('左右');
    await expect(drawer.locator('.diff-segment.active')).toHaveAttribute('title', /1 列で表示しています/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-resized-narrow.png` });
    // 一覧を畳めば差分の列が広がり左右に戻る
    await drawer.locator('.diff-list-toggle').click();
    await expect(util.locator('.diff-split-line').first()).toBeVisible();
  });

  test('小窓に移して指摘を書き、小窓から送る。Esc では閉じず、メインのキーを塞がない', async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { drawer, submits, socket, diffRequests } = await openDrawer(page, {
      diffDrawerView: 'unified',
      diffReviewed: null,
    });
    test.skip(!(await page.evaluate(() => 'documentPictureInPicture' in globalThis)), 'Document PiP が使えない');
    const pipPromise = context.waitForEvent('page');
    await drawer.locator('.diff-drawer-pip').click();
    const pip = await pipPromise;
    const pipDrawer = pip.locator('.diff-drawer-pip-host .diff-drawer');
    await expect(pipDrawer.locator('.diff-file')).toHaveCount(3);
    // メイン側のドロワーは閉じ、overlay も残らない。小窓にはつまみも小窓ボタンも無い
    await expect(page.locator('.diff-drawer-overlay')).toHaveCount(0);
    await expect(pipDrawer.locator('.diff-drawer-resize')).toHaveCount(0);
    await expect(pipDrawer.locator('.diff-drawer-pip')).toHaveCount(0);
    // サイドバーのタブに ⧉
    await expect(page.locator('.tab .tab-mark-pip')).toHaveCount(1);

    // 小窓で行に指摘を書く（キーは小窓の document で完結する）
    const util = pipDrawer.locator('.diff-file[data-file-path="src/util.js"]');
    await util.locator('[data-anchor="new:6"] .diff-gutter').click();
    await expect(util.locator('.diff-comment.active .diff-comment-where')).toHaveText('L6');
    await pip.keyboard.type('小窓の指摘');
    // 指摘欄の Esc は確定（窓も閉じない）
    await pip.keyboard.press('Escape');
    await expect(pipDrawer.locator('.diff-drawer-body')).toBeFocused();
    // 本文の Esc でも閉じない
    await pip.keyboard.press('Escape');
    await expect(pipDrawer).toBeVisible();
    // 行カーソルも小窓で動く
    // （ガターのクリックでカーソルは 新 L6 にある）
    await pip.keyboard.press('ArrowDown');
    await expect(pipDrawer.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:7');
    // 小窓の幅（1000px）では一覧が出ている
    await expect(pipDrawer.locator('.diff-filelist')).toBeVisible();
    if (SHOTS) {
      await pip.screenshot({ path: `${SHOTS}/diff-pip-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await expect(pip.locator('body')).toHaveClass(/light-mode/);
      await pip.screenshot({ path: `${SHOTS}/diff-pip-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    // 左右表示と一覧の判定は小窓の中の幅で決まる（小窓の ResizeObserver で測る）
    await pipDrawer.locator('.diff-segment', { hasText: '左右' }).click();
    await expect(util.locator('.diff-split-line').first()).toBeVisible();
    await pip.setViewportSize({ width: 700, height: 600 });
    await expect(util.locator('.diff-split-line')).toHaveCount(0);
    await pipDrawer.locator('.diff-segment', { hasText: '1列' }).click();

    // メインのキーは塞がない（送信欄に打てる）
    const input = page.locator('.input-textarea');
    await input.fill('main');
    await expect(input).toHaveValue('main');
    await input.fill('');

    await pip.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].sessionId).toBe(SESSION.id);
    expect(submits[0].sessionKey).toBe(SESSION.claudeSessionId);
    expect(submits[0].items.map((i) => i.text)).toEqual(['src/util.js:L6 「return a + b + 0;」について:\n小窓の指摘']);
    socket().send(JSON.stringify({ type: 'submit_review_result', ok: true, requestId: submits[0].requestId }));
    await expect(pipDrawer.locator('.diff-comment')).toHaveCount(0);

    // メインで開き直した差分ドロワーとも下書きを共有する
    await util.locator('[data-anchor="new:2"] .diff-gutter').click();
    await pip.keyboard.type('共有');
    await pip.keyboard.press('Control+Enter');
    const reopened = page.locator('.input-textarea');
    await reopened.fill('/diff');
    await reopened.press('Enter');
    await expect(
      page.locator('.diff-drawer-overlay .diff-file[data-file-path="src/util.js"] .diff-comment-input'),
    ).toHaveValue('共有');
    // 小窓で付けた確認済みは、開いているメイン側のドロワーにもそのまま出る
    const mainStyle = page.locator('.diff-drawer-overlay .diff-file[data-file-path="src/style.css"]');
    await expect(mainStyle.locator('.diff-file-reviewed')).not.toHaveClass(/\bon\b/);
    await pipDrawer.locator('.diff-file[data-file-path="src/style.css"] .diff-file-reviewed').click();
    await expect(mainStyle.locator('.diff-file-reviewed')).toHaveClass(/\bon\b/);
    // 小窓の範囲切り替えは小窓のセッションで取り直し、メイン側（全体）は読み込み中にならない
    const before = diffRequests.length;
    await pipDrawer.locator('.diff-scope-btn', { hasText: 'このセッション' }).click();
    await expect.poll(() => diffRequests.length).toBe(before + 1);
    expect(diffRequests.at(-1)).toMatchObject({ sessionId: SESSION.id, scope: 'session' });
    await expect(pipDrawer.locator('.diff-scope-btn.active')).toHaveText('このセッション');
    await expect(pipDrawer.locator('.diff-file')).toHaveCount(3);
    await expect(page.locator('.diff-drawer-overlay .diff-scope-btn.active')).toHaveText('全体');
    await expect(page.locator('.diff-drawer-overlay .diff-file')).toHaveCount(3);
    // 取り直しも小窓のセッションで
    await pipDrawer.locator('.diff-drawer-refresh').click();
    await expect.poll(() => diffRequests.length).toBe(before + 2);
    expect(diffRequests.at(-1)).toMatchObject({ sessionId: SESSION.id, scope: 'session' });
    await page.keyboard.press('Escape');

    // x で小窓を閉じると片付く
    const closed = pip.waitForEvent('close');
    await pipDrawer.locator('.diff-drawer-close').click();
    await closed;
    await expect(page.locator('.tab .tab-mark-pip')).toHaveCount(0);
  });

  test('プレビューの幅のつまみも同じ仕組み（ドラッグ・キー・ダブルクリック。幅は覚えない）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { drawer, reopen } = await openDrawer(page, { diffDrawerView: 'unified' });
    const storageKeys = () => page.evaluate(() => Object.keys(globalThis.localStorage).sort());
    const keysBefore = await storageKeys();
    // 差分のファイル名からプレビューを開く（ファイルは無いので本文はエラーだが、ドロワーとつまみは出る）
    await fileOf(drawer, 'src/util.js').locator('.diff-file-path').click();
    const preview = page.locator('.drawer-overlay .drawer');
    const handle = preview.locator('.drawer-resize-handle');
    await expect(handle).toHaveAttribute('role', 'separator');
    // 開くときのスライドインが終わってから位置を測る
    await expect.poll(() => preview.evaluate((el) => el.getAnimations().length)).toBe(0);
    const w0 = Math.round((await rectOf(preview)).width);
    const hb = await rectOf(handle);
    await page.mouse.move(hb.left + 2, hb.top + 200);
    await page.mouse.down();
    expect(Math.round((await rectOf(preview)).width)).toBe(w0);
    await page.mouse.move(hb.left + 2 - 100, hb.top + 200, { steps: 4 });
    await page.mouse.up();
    expect(Math.round((await rectOf(preview)).width)).toBe(w0 + 100);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    expect(Math.round((await rectOf(preview)).width)).toBe(w0 + 100 - 32);
    // つまみの ← / → は閉じたりピックに取られたりしない
    await expect(preview).toBeVisible();
    await handle.dblclick();
    await expect.poll(async () => Math.round((await rectOf(preview)).width)).toBe(w0);
    // 開き直すと既定の幅（覚えない）
    await page.mouse.move(hb.left + 2, hb.top + 200);
    await page.mouse.down();
    await page.mouse.move(hb.left + 2 - 80, hb.top + 200, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer-overlay')).toHaveCount(0);
    expect(await storageKeys()).toEqual(keysBefore);
    await reopen();
    await fileOf(drawer, 'src/util.js').locator('.diff-file-path').click();
    await expect.poll(() => preview.evaluate((el) => el.getAnimations().length)).toBe(0);
    expect(Math.round((await rectOf(preview)).width)).toBe(w0);
  });

  test('ボタンを押した後でも、カーソルを動かした Enter は指摘欄を開く（ボタンを押し直さない）', async ({ page }) => {
    const { drawer } = await openDrawer(page, { diffDrawerView: 'unified', diffReviewed: null });
    const util = fileOf(drawer, 'src/util.js');
    const cursor = drawer.locator('.diff-line.cursor');
    // ボタンを押してフォーカスを残す（表示の切り替え・ファイル一覧の項目・範囲・取り直す）
    for (const button of [
      drawer.locator('.diff-segment', { hasText: '1列' }),
      drawer.locator('.diff-filelist-item').first(),
      drawer.locator('.diff-scope-btn', { hasText: '全体' }),
      drawer.locator('.diff-drawer-refresh'),
    ]) {
      await button.click();
      await expect(button).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(cursor).toHaveCount(1);
      await expect(drawer.locator('.diff-drawer-body')).toBeFocused();
      // Enter はボタンではなく指摘欄を開く。空のまま Esc で確定すると捨てて本文へ戻る
      await page.keyboard.press('Enter');
      await expect(drawer.locator('.diff-comment.active textarea')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(drawer.locator('.diff-comment')).toHaveCount(0);
      await expect(drawer.locator('.diff-drawer-body')).toBeFocused();
    }
    await expect(drawer.locator('.diff-file')).toHaveCount(3);
    // 確認済みを押した直後に ↓ → Enter で指摘欄が開き、確認済みは付いたまま
    const style = fileOf(drawer, 'src/style.css');
    await style.locator('.diff-file-reviewed').click();
    await expect(style.locator('.diff-file-reviewed')).toHaveClass(/\bon\b/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.diff-comment.active textarea')).toBeFocused();
    await expect(style.locator('.diff-file-reviewed')).toHaveClass(/\bon\b/);
    await expect(util.locator('.diff-comment.active')).toHaveCount(1);
  });

  test('確認済みで畳んだファイルは、取り直して中身が変わると開き、行カーソルの移動先に戻る', async ({ page }) => {
    const { drawer, setFiles } = await openDrawer(page, { diffDrawerView: 'unified', diffReviewed: null });
    const util = fileOf(drawer, 'src/util.js');
    await util.locator('.diff-file-reviewed').click();
    await expect(util.locator('.diff-file-body')).toHaveCount(0);
    await drawer.locator('.diff-drawer-body').focus();
    await page.keyboard.press('ArrowDown');
    // util.js を飛ばして style.css の先頭へ
    await expect(fileOf(drawer, 'src/style.css').locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:1');

    setFiles(
      FILES.map((f) =>
        f.path === 'src/util.js' ? { ...f, patch: f.patch.replace('return a + b + 0;', 'return a + b + 1;') } : f,
      ),
    );
    await drawer.locator('.diff-drawer-refresh').click();
    await expect(util.locator('.diff-file-reviewed')).not.toHaveClass(/\bon\b/);
    await expect(util.locator('.diff-file-body')).toBeVisible();
    await page.keyboard.press('[');
    await expect(util.locator('.diff-line.cursor')).toHaveAttribute('data-anchor', 'new:1');
  });

  test('行カーソルの移動先が無いときは ↑↓ の既定動作（スクロール）を止めない', async ({ page }) => {
    const { drawer } = await openDrawer(page, { diffDrawerView: 'unified', diffReviewed: null });
    for (const path of ['src/util.js', 'src/style.css', 'README.md']) {
      await fileOf(drawer, path).locator('.diff-file-reviewed').click();
    }
    await expect(drawer.locator('.diff-file-body')).toHaveCount(0);
    await drawer.locator('.diff-drawer-body').focus();
    await page.evaluate(() => {
      globalThis.__prevented = [];
      globalThis.addEventListener('keydown', (e) => globalThis.__prevented.push(e.defaultPrevented));
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('n');
    expect(await page.evaluate(() => globalThis.__prevented)).toEqual([false, false]);
    await expect(drawer.locator('.diff-line.cursor')).toHaveCount(0);
  });

  test('小窓のファイル名から開いたプレビューの指摘は、メインで別のタブを見ていても小窓のセッションへ送る', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { drawer, submits, socket } = await openDrawer(page, { diffDrawerView: 'unified' });
    test.skip(!(await page.evaluate(() => 'documentPictureInPicture' in globalThis)), 'Document PiP が使えない');
    // tmux タブの起動直後のように、claudeSessionId がまだ分からない状態で小窓を開く（キーはブリッジ ID）
    const { claudeSessionId: _cid, ...unresolved } = SESSION;
    socket().send(JSON.stringify({ type: 'session_list', sessions: [unresolved] }));
    await expect(page.locator('.diff-drawer-overlay')).toBeVisible();
    const pipPromise = context.waitForEvent('page');
    await drawer.locator('.diff-drawer-pip').click();
    const pip = await pipPromise;
    const pipDrawer = pip.locator('.diff-drawer-pip-host .diff-drawer');
    await expect(pipDrawer.locator('.diff-file')).toHaveCount(3);
    // その後 claudeSessionId が決まる
    socket().send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));

    // メイン画面では別のタブ（B）へ移る
    const other = {
      ...SESSION,
      id: 'e2e-diffview-other',
      claudeSessionId: 'e2e-diffview-other-claude',
      name: 'other tab',
    };
    socket().send(JSON.stringify({ type: 'session_list', sessions: [SESSION, other] }));
    await page.locator('.tab', { hasText: 'other tab' }).click();
    await expect(page.locator('.tab.active')).toContainText('other tab');

    // 小窓のファイル名 → メイン画面のプレビュー（小窓は残る）
    await pipDrawer.locator('.diff-file[data-file-path="src/util.js"] .diff-file-path').click();
    const preview = page.locator('.drawer-overlay .drawer');
    await expect(preview).toBeVisible();
    await expect(pipDrawer).toBeVisible();
    await page.bringToFront();
    await preview.locator('.drawer-body').focus();
    await page.keyboard.press('Enter');
    await expect(preview.locator('.review-pane-input').first()).toBeFocused();
    await page.keyboard.type('プレビューの指摘');
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0]).toMatchObject({ sessionId: SESSION.id, sessionKey: SESSION.claudeSessionId });
    expect(submits[0].items[0].text).toContain('プレビューの指摘');

    // 小窓を開いた元のタブが閉じても、下書き・確認済みのキーはブリッジ ID に戻らない（claudeSessionId のまま）
    await page.keyboard.press('Escape');
    const pipUtil = pipDrawer.locator('.diff-file[data-file-path="src/util.js"]');
    await pipUtil.locator('[data-anchor="new:6"] .diff-gutter').click();
    await pip.keyboard.type('残る指摘');
    await pip.keyboard.press('Control+Enter');
    await pipUtil.locator('.diff-file-reviewed').click();
    socket().send(JSON.stringify({ type: 'session_list', sessions: [other] }));
    await expect(page.locator('.tab', { hasText: SESSION.name })).toHaveCount(0);
    // 確認済みで畳んでいるので、指摘は見出しの件数で確かめる
    await expect(pipUtil.locator('.diff-file-comments')).toHaveText('指摘 1');
    await expect(pipUtil.locator('.diff-file-reviewed')).toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => globalThis.localStorage.getItem('diffReviewed'))).toContain(
      `${SESSION.claudeSessionId}|`,
    );
    await pip.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(2);
    expect(submits[1]).toMatchObject({ sessionId: SESSION.id, sessionKey: SESSION.claudeSessionId });
  });
});
