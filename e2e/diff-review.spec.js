import { test, expect } from '@playwright/test';

// 差分ドロワー（/diff）の行への指摘 → 一括送信。fixture サーバーの cwd は git ではないので、
// working-indicator.spec.js と同じく WebSocket を差し替え、session_diff と submit_review_result を手で返す
const SESSION = {
  id: 'e2e-diff-tab',
  type: 'readonly',
  claudeSessionId: 'e2e-diff-claude',
  name: 'e2e diff',
  cwd: '/home/e2e/diff-project',
  alive: true,
};

const SHOTS = process.env.E2E_SHOT_DIR;

const MAIN_PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,6 +10,7 @@ function main() {',
  '   const port = 3000;',
  '-  const host = "0.0.0.0";',
  '+  const host = "127.0.0.1";',
  '+  const timeout = 30;',
  '   listen(port, host);',
  '   log("ready");',
  '   return 0;',
  '',
].join('\n');

// 取り直し後: 新しい L12（timeout）が消え、L12 以降は 1 行ずつ上へずれる（行番号だけでは取り違える）
const MAIN_PATCH_AFTER = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,6 +10,6 @@ function main() {',
  '   const port = 3000;',
  '-  const host = "0.0.0.0";',
  '+  const host = "127.0.0.1";',
  '   listen(port, host);',
  '   log("ready");',
  '   return 0;',
  '',
].join('\n');

// 300 行超で既定では畳まれるファイル（openDiffAt で開いてスクロールされるかを見る）
const BIG_LINES = Array.from({ length: 320 }, (_, i) => `+line ${i + 1}`);
const BIG_PATCH = ['diff --git a/big.txt b/big.txt', '@@ -0,0 +1,320 @@', ...BIG_LINES, ''].join('\n');

// 横スクロールが出る長い 1 行（指摘欄とガターが見える幅に貼り付くかを見る）
const LONG_PATCH = ['diff --git a/src/long.js b/src/long.js', '@@ -1 +1 @@', '-short', `+${'x'.repeat(600)}`, ''].join(
  '\n',
);

const files = (mainPatch) => [
  { path: 'big.txt', status: 'untracked', binary: false, additions: 320, deletions: 0, patch: BIG_PATCH },
  { path: 'src/app.js', status: 'modified', binary: false, additions: 2, deletions: 1, patch: mainPatch },
  { path: 'src/long.js', status: 'modified', binary: false, additions: 1, deletions: 1, patch: LONG_PATCH },
];

test.describe('差分ドロワーの行への指摘', () => {
  test('行番号のクリックで指摘を書き、側つきの本文で一括送信し、成功した分だけ消える', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('showHome', 'false');
      localStorage.setItem('activeSessionId', id);
      localStorage.setItem('diffDrawerScope', 'all');
    }, SESSION.id);

    let socket;
    let mainPatch = MAIN_PATCH;
    const submits = [];
    const diffRequests = [];
    // hold が true の間は差分の応答を返さず、release() で返す（読み込み中の状態を作る）
    let hold = false;
    let held = null;
    const release = () => {
      hold = false;
      held?.();
      held = null;
    };
    await page.routeWebSocket('**/ws', (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'get_session_diff') {
          diffRequests.push(msg);
          // 「このセッション」は long.js だけを編集した想定（app.js は範囲外になる）
          const list = files(mainPatch).filter((f) => msg.scope === 'all' || f.path === 'src/long.js');
          const respond = () =>
            ws.send(
              JSON.stringify({
                type: 'session_diff',
                sessionId: msg.sessionId,
                scope: msg.scope,
                root: '/home/e2e/diff-project',
                files: list,
                truncated: false,
                outside: 0,
              }),
            );
          if (hold) held = respond;
          else respond();
        }
        if (msg.type === 'submit_review') submits.push(msg);
      });
    });

    await page.goto('/');
    await expect.poll(() => !!socket).toBe(true);
    socket.send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));

    // Review パネルに別の下書きを置いておく（差分ドロワーからの一括送信で一緒に送らない・消さないことを見る）
    await page.locator('.panel-tab', { hasText: 'Review' }).click();
    await page.locator('.review-draft-item-input').first().fill('パネルの下書き');

    const input = page.locator('.input-textarea');
    await input.fill('/diff');
    await input.press('Enter');
    const drawer = page.locator('.diff-drawer');
    await expect(drawer).toBeVisible();
    // 開いたら本文にフォーカス（送信欄に残すと Ctrl+D / U が効かず、打鍵が裏の送信欄に入る）
    await expect(drawer.locator('.diff-drawer-body')).toBeFocused();

    const app = drawer.locator('.diff-file', { hasText: 'app.js' });
    const row = (anchor) => app.locator(`.diff-line[data-anchor="${anchor}"]`);
    await expect(row('new:11')).toBeVisible();
    // 畳んだファイル（300 行超）は行を出さない
    await expect(drawer.locator('.diff-file', { hasText: 'big.txt' }).locator('.diff-line')).toHaveCount(0);

    // ── レイアウト計測: ホバーの「＋」で行・本文が動かない、未送信 0 件でもヘッダの並びが動かない
    const rectOf = (loc) => loc.evaluate((el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
    const textBefore = await rectOf(row('new:11').locator('.diff-line-text'));
    const nextBefore = await rectOf(row('new:12'));
    const scopeBefore = await rectOf(drawer.locator('.diff-drawer-scope'));
    const refreshBefore = await rectOf(drawer.locator('.diff-drawer-refresh'));
    await row('new:11').hover();
    await expect(row('new:11').locator('.diff-gutter-plus')).toHaveCSS('opacity', '1');
    expect(await rectOf(row('new:11').locator('.diff-line-text'))).toEqual(textBefore);
    expect(await rectOf(row('new:12'))).toEqual(nextBefore);

    // ── 横スクロール: 指摘欄とガターは見える幅に貼り付いたまま
    const long = drawer.locator('.diff-file', { hasText: 'long.js' });
    await long.locator('.diff-line[data-anchor="new:1"] .diff-gutter').click();
    await page.keyboard.type('長い行');
    const longBox = long.locator('.diff-comment');
    const longGutter = long.locator('.diff-line[data-anchor="new:1"] .diff-gutter');
    const boxLeft = (await rectOf(longBox)).left;
    const gutterLeft = (await rectOf(longGutter)).left;
    await long.locator('.diff-lines').evaluate((el) => {
      el.scrollLeft = 400;
    });
    expect(await long.locator('.diff-lines').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    // 横に長い行があっても、短い行（削除行 -short）の背景は長い行と同じ右端まで塗る
    const longRows = await long.locator('.diff-lines').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      widths: [...el.querySelectorAll('.diff-line')].map((r) => r.getBoundingClientRect().width),
    }));
    expect(new Set(longRows.widths).size).toBe(1);
    // scrollWidth は整数に丸められるので 1px の誤差を許す
    expect(longRows.widths[0]).toBeGreaterThanOrEqual(longRows.scrollWidth - 1);
    expect((await rectOf(longBox)).left).toBe(boxLeft);
    expect((await rectOf(longGutter)).left).toBe(gutterLeft);
    await page.keyboard.press('Control+Shift+Backspace');
    await expect(longBox).toHaveCount(0);

    // ── 追加行（新 L11）に指摘
    await row('new:11').locator('.diff-gutter').click();
    const box1 = app.locator('.diff-comment.active');
    await expect(box1.locator('.diff-comment-where')).toHaveText('L11');
    await expect(box1.locator('textarea')).toBeFocused();
    await expect(row('new:11')).toHaveClass(/target/);
    await page.keyboard.type('localhost に限定した理由を書いて');
    await page.keyboard.press('Control+Enter');
    await expect(app.locator('.diff-comment.active')).toHaveCount(0);
    await expect(row('new:11')).toHaveClass(/has-comment/);
    await expect(row('new:11').locator('.diff-gutter-mark')).toHaveCSS('opacity', '1');
    // 未送信の印・件数が出ても本文・ヘッダは動かない
    expect(await rectOf(row('new:11').locator('.diff-line-text'))).toEqual(textBefore);
    expect(await rectOf(drawer.locator('.diff-drawer-scope'))).toEqual(scopeBefore);
    expect(await rectOf(drawer.locator('.diff-drawer-refresh'))).toEqual(refreshBefore);
    await expect(drawer.locator('.diff-submit')).toHaveText('1件送信');

    // ── 削除行（旧 L11）に指摘。新 L11 と取り違えない
    await row('old:11').locator('.diff-gutter').click();
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('削除行 旧L11');
    await page.keyboard.type('0.0.0.0 は外から繋ぐ用途があったはず');
    await page.keyboard.press('Escape');
    // Esc は確定だけでドロワーは閉じない
    await expect(drawer).toBeVisible();

    // ── 指摘欄が開いていない Shift+クリックは、押した 1 行の指摘になる（範囲の起点は「今書いている指摘」だけ）
    await row('new:14')
      .locator('.diff-gutter')
      .click({ modifiers: ['Shift'] });
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('L14');
    await page.keyboard.press('Escape');
    await expect(app.locator('.diff-comment')).toHaveCount(2);

    // ── 側の違う行への Shift+クリックは範囲にしない。書いた指摘の本文は動かない
    await row('new:10').locator('.diff-gutter').click();
    await row('old:11')
      .locator('.diff-gutter')
      .click({ modifiers: ['Shift'] });
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('削除行 旧L11');
    await expect(app.locator('.diff-comment.active textarea')).toBeFocused();
    await expect(app.locator('.diff-comment.active textarea')).toHaveValue('0.0.0.0 は外から繋ぐ用途があったはず');
    // 空のまま離れた新 L10 の欄は捨てる
    await expect(app.locator('.diff-comment')).toHaveCount(2);
    await page.keyboard.press('Escape');

    // ── 別の指摘欄にフォーカスしてから Shift+クリックすると、その指摘の範囲が変わる（起点はその指摘の先頭行）
    const newL11 = app
      .locator('.diff-comment')
      .filter({ has: page.locator('.diff-comment-where', { hasText: /^L11/ }) });
    await newL11.locator('textarea').focus();
    await row('new:13')
      .locator('.diff-gutter')
      .click({ modifiers: ['Shift'] });
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('L11-L13');
    await expect(app.locator('.diff-comment.active textarea')).toHaveValue('localhost に限定した理由を書いて');
    // 先頭行へ Shift+クリックすると 1 行に戻る
    await row('new:11')
      .locator('.diff-gutter')
      .click({ modifiers: ['Shift'] });
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('L11');
    await expect(app.locator('.diff-comment.active textarea')).toHaveValue('localhost に限定した理由を書いて');
    await page.keyboard.press('Escape');
    await expect(app.locator('.diff-comment')).toHaveCount(2);

    // ── 文脈行（新 L13）から Shift+クリックで新 L15 までの範囲
    await row('new:13').locator('.diff-gutter').click();
    await row('new:15')
      .locator('.diff-gutter')
      .click({ modifiers: ['Shift'] });
    await expect(app.locator('.diff-comment.active .diff-comment-where')).toHaveText('L13-L15');
    for (const a of ['new:13', 'new:14', 'new:15']) await expect(row(a)).toHaveClass(/target/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-review-active-dark.png` });
    await page.keyboard.type('ここはまとめて関数に');
    await page.keyboard.press('Control+Enter');

    // ── 新 L12 にも書いてから取り直すと、対象行が無くなった指摘は消さずに残る
    await row('new:12').locator('.diff-gutter').click();
    await page.keyboard.type('timeout は設定から読む');
    await page.keyboard.press('Control+Enter');
    await expect(drawer.locator('.diff-submit')).toHaveText('4件送信');
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/diff-review-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-review-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }
    mainPatch = MAIN_PATCH_AFTER;
    await drawer.locator('.diff-drawer-refresh').click();
    const stale = app.locator('.diff-comment.stale');
    // L12 は消え、L13-L15 は行番号が同じでも中身がずれたので、どちらも「対象行が見つからない」で残す
    await expect(stale).toHaveCount(2);
    await expect(stale.first()).toContainText('対象行が見つからない');
    await expect(stale.locator('textarea')).toHaveText(['ここはまとめて関数に', 'timeout は設定から読む']);
    // 本文の変わらない L11 と旧 L11 は今の行に付いたまま
    await expect(row('new:11')).toHaveClass(/has-comment/);
    await expect(row('old:11')).toHaveClass(/has-comment/);
    await expect(drawer.locator('.diff-submit')).toHaveText('4件送信');

    // ── 読み込み中は送れない（ボタンもショートカットも）
    hold = true;
    await drawer.locator('.diff-scope-btn', { hasText: 'このセッション' }).click();
    await expect(drawer.locator('.diff-drawer-empty')).toHaveText('読み込み中...');
    await expect(drawer.locator('.diff-submit')).toBeDisabled();
    await page.keyboard.press('Control+Shift+Enter');
    release();

    // ── 範囲外になったファイルの指摘（「このセッション」に app.js が無い）は、確かめようがないので
    // 「取り直す前の行番号」を付けずに送る（失敗させて残す）
    const orphans = drawer.locator('.diff-orphans .diff-comment');
    await expect(orphans).toHaveCount(4);
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].items.map((i) => i.text.split('\n')[0])).toEqual([
      'src/app.js:L11 「const host = "127.0.0.1";」について:',
      'src/app.js（削除された行 旧L11） 「const host = "0.0.0.0";」について:',
      'src/app.js:L13-L15 「listen(port, host); ⏎ log("ready"); ⏎ return 0;」について:',
      'src/app.js:L12 「const timeout = 30;」について:',
    ]);
    socket.send(JSON.stringify({ type: 'submit_review_result', ok: false, requestId: submits[0].requestId }));
    await expect(drawer.locator('.diff-drawer-status.error')).toBeVisible();
    await drawer.locator('.diff-scope-btn', { hasText: '全体' }).click();
    await expect(stale).toHaveCount(2);
    await drawer.locator('.diff-drawer-refresh').click();
    await expect(stale).toHaveCount(2);

    // ── 一括送信（失敗）: 下書きは残り、ドロワー内に失敗が出る。指摘欄の外（更新ボタン）にフォーカスがあっても効く
    await expect(drawer.locator('.diff-drawer-refresh')).toBeFocused();
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(2);
    const first = submits[1];
    expect(first.keepDraft).toBe(true);
    expect(first.sessionKey).toBe(SESSION.claudeSessionId);
    expect(first.items.map((i) => i.text)).toEqual([
      'src/app.js:L11 「const host = "127.0.0.1";」について:\nlocalhost に限定した理由を書いて',
      'src/app.js（削除された行 旧L11） 「const host = "0.0.0.0";」について:\n0.0.0.0 は外から繋ぐ用途があったはず',
      'src/app.js:L13-L15（差分を取り直す前の行番号） 「listen(port, host); ⏎ log("ready"); ⏎ return 0;」について:\nここはまとめて関数に',
      'src/app.js:L12（差分を取り直す前の行番号） 「const timeout = 30;」について:\ntimeout は設定から読む',
    ]);
    // 送信中は二重に送れない
    await expect(drawer.locator('.diff-submit')).toBeDisabled();
    socket.send(JSON.stringify({ type: 'submit_review_result', ok: false, requestId: first.requestId }));
    await expect(drawer.locator('.diff-drawer-status.error')).toBeVisible();
    await expect(drawer.locator('.diff-submit')).toHaveText('4件送信');
    await expect(drawer.locator('.diff-submit')).toBeEnabled();

    // ── 再送（成功）: 指摘欄の中から。指摘が消え、ドロワーは開いたまま
    await app.locator('.diff-comment textarea').first().focus();
    await page.keyboard.press('Control+Shift+Enter');
    await expect.poll(() => submits.length).toBe(3);
    socket.send(JSON.stringify({ type: 'submit_review_result', ok: true, requestId: submits[2].requestId }));
    await expect(drawer.locator('.diff-drawer-status')).toHaveText('4件送信しました');
    await expect(drawer.locator('.diff-comment')).toHaveCount(0);
    await expect(drawer.locator('.diff-drawer-review')).toHaveClass(/empty/);
    expect(await rectOf(drawer.locator('.diff-drawer-scope'))).toEqual(scopeBefore);
    // 後ろの Review パネルは送っていない（送信は 3 回とも差分ドロワーの keepDraft 付きだけ。読み込み中は送らない）、下書きも残る
    expect(submits.length).toBe(3);
    expect(submits.every((m) => m.keepDraft === true && m.items.length === 4)).toBe(true);
    await expect(page.locator('.review-draft-item-input').first()).toHaveValue('パネルの下書き');

    // ── 送ってすぐ閉じても、送信結果の表示は次に開いたときまで残らない（store 側で消える）
    await drawer.locator('.diff-drawer-close').click();
    await expect(drawer).toHaveCount(0);
    await page.evaluate(() => globalThis.claudeBridge.openDiffAt({ path: 'src/app.js', line: 11 }));
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.diff-drawer-status')).toHaveCount(0);

    // ── 閉じても書きかけは残る
    await row('new:11').locator('.diff-gutter').click();
    await page.keyboard.type('閉じても残る');
    await drawer.locator('.diff-drawer-close').click();
    await expect(drawer).toHaveCount(0);
    await input.fill('/diff');
    await input.press('Enter');
    await expect(drawer.locator('.diff-comment textarea')).toHaveValue('閉じても残る');
    await drawer.locator('.diff-comment textarea').focus();
    await page.keyboard.press('Control+Shift+Backspace');
    await expect(drawer.locator('.diff-comment')).toHaveCount(0);

    // ── 将来の口: 指定したファイル・行で開き、畳んでいたファイルを開いてスクロールする
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    const opened = await page.evaluate(() =>
      globalThis.claudeBridge.openDiffAt({ path: 'big.txt', side: 'new', line: 300 }),
    );
    expect(opened).toBe(true);
    const target = drawer.locator('.diff-file', { hasText: 'big.txt' }).locator('.diff-line[data-anchor="new:300"]');
    await expect(target).toBeInViewport();
    expect(diffRequests.at(-1).scope).toBe('all');
  });
});
