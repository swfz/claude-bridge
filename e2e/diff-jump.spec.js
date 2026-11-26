import { test, expect } from '@playwright/test';

// 返答の `path:行` から差分ドロワーのその行へ飛ぶ（第 4 段階）。WebSocket を差し替えて会話と差分を手で返す。
// ピルの存在確認（/file-exists）とプレビュー（/preview）は fixture サーバーが実ファイルを読むので、
// このリポジトリのファイルを使う（cwd ＝ リポジトリのルート）
const ROOT = process.cwd();
const SESSION = {
  id: 'e2e-diffjump-tab',
  type: 'readonly',
  claudeSessionId: 'e2e-diffjump-claude',
  projectDir: 'e2e-diffjump',
  name: 'e2e diff jump',
  cwd: ROOT,
  alive: true,
};

const SHOTS = process.env.E2E_SHOT_DIR;

const REPLY = [
  '差分の要点です。',
  '',
  '- インライン: `server/session-diff.js:5`',
  '- 範囲: `server/session-diff.js:5-6`',
  '- 地の文: server/session-turns.js:3 を見てください。',
  '- 差分に無い行: `server/session-diff.js:200`',
  '- 存在しない: src/nope.js:3 と `src/nope.js:4`',
  '- 拾わない: http://localhost:8080/a.js:3 と 12:30、Node.js:18 以上、user@host.com:22、~/a.js:3',
  '- 大きすぎる: `server/session-completion.js:5`',
  '- このセッションに無い: `server/index.js:10`',
  '',
  '```',
  'server/session-turns.js:3',
  '```',
].join('\n');

const lines = (from, n, sign = ' ') => Array.from({ length: n }, (_, i) => `${sign}line ${from + i}`);
// 差分が大きく行を出していないファイル
const TOO_LARGE = {
  path: 'server/session-completion.js',
  status: 'modified',
  binary: false,
  additions: 900,
  deletions: 0,
  patch: '',
  tooLarge: true,
};
// 全体にだけあるファイル（このセッションの編集には無い。Bash で書き換えた想定）
const ONLY_ALL = {
  path: 'server/index.js',
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  patch: [
    'diff --git a/server/index.js b/server/index.js',
    '--- a/server/index.js',
    '+++ b/server/index.js',
    '@@ -9,3 +9,3 @@',
    ' line 9',
    '-old 10',
    '+new 10',
    ' line 11',
    '',
  ].join('\n'),
};
const DIFF_FILES = [
  {
    path: 'server/session-diff.js',
    status: 'modified',
    binary: false,
    additions: 2,
    deletions: 1,
    patch: [
      'diff --git a/server/session-diff.js b/server/session-diff.js',
      '--- a/server/session-diff.js',
      '+++ b/server/session-diff.js',
      '@@ -3,5 +3,6 @@',
      ...lines(3, 2),
      '-old 5',
      '+new 5',
      '+new 6',
      ...lines(7, 2),
      '',
    ].join('\n'),
  },
  {
    path: 'server/session-turns.js',
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 1,
    patch: [
      'diff --git a/server/session-turns.js b/server/session-turns.js',
      '--- a/server/session-turns.js',
      '+++ b/server/session-turns.js',
      '@@ -2,3 +2,3 @@',
      ' line 2',
      '-old 3',
      '+new 3',
      ' line 4',
      '',
    ].join('\n'),
  },
];

async function setup(page, { scope = 'commit', pins = [] } = {}) {
  await page.addInitScript(
    ({ id, scope }) => {
      localStorage.setItem('showHome', 'false');
      localStorage.setItem('activeSessionId', id);
      localStorage.setItem('diffDrawerScope', scope);
      // 地の文の誤検出（Node.js:18）が一瞬でもピルとして描かれたかを記録する
      globalThis.__bareFlash = [];
      new globalThis.MutationObserver(() => {
        for (const el of globalThis.document.querySelectorAll('.file-preview-inline')) {
          if (/Node\.js|host\.com|~\/a\.js/.test(el.textContent)) globalThis.__bareFlash.push(el.textContent);
        }
      }).observe(globalThis.document, { childList: true, subtree: true });
    },
    { id: SESSION.id, scope },
  );
  let socket;
  const diffRequests = [];
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'load_session_history') {
        ws.send(
          JSON.stringify({
            type: 'session_history',
            bridgeSessionId: msg.sessionId,
            messages: [
              { role: 'human', uuid: 'u1', content: '差分を説明して', timestamp: '2026-11-26T01:00:00Z' },
              { role: 'assistant', uuid: 'a1', content: REPLY, timestamp: '2026-11-26T01:00:05Z' },
            ],
          }),
        );
      }
      if (msg.type === 'get_session_diff') {
        diffRequests.push(msg);
        ws.send(
          JSON.stringify({
            type: 'session_diff',
            sessionId: msg.sessionId,
            scope: msg.scope,
            ref: msg.ref ?? null,
            resolvedRef: null,
            root: ROOT,
            files: msg.scope === 'session' ? [...DIFF_FILES, TOO_LARGE] : [...DIFF_FILES, TOO_LARGE, ONLY_ALL],
            cwdPrefix: '',
            truncated: false,
            outside: 0,
          }),
        );
      }
      if (msg.type === 'get_pins') {
        ws.send(JSON.stringify({ type: 'pins_update', sessionId: msg.sessionId, pins }));
      }
      if (msg.type === 'get_diff_sources') {
        ws.send(JSON.stringify({ type: 'diff_sources', sessionId: msg.sessionId, commits: [], turns: [] }));
      }
    });
  });
  await page.goto('/');
  await expect.poll(() => !!socket).toBe(true);
  socket.send(JSON.stringify({ type: 'session_list', sessions: [SESSION] }));
  const message = page.locator('.chat-message.assistant').filter({ hasText: '差分の要点です' });
  await expect(message.locator('.file-preview-inline')).toHaveCount(6);
  return { socket, message, diffRequests };
}

const rectOf = (loc) => loc.evaluate((el) => JSON.parse(JSON.stringify(el.getBoundingClientRect())));
const pill = (message, text) => message.locator('.file-preview-inline').filter({ hasText: text });

test.describe('返答の path:行 から差分へ飛ぶ', () => {
  test('ピルの見た目と拾わないもの。インライン・範囲・地の文から差分の行へ飛んでカーソルを置く', async ({ page }) => {
    const { socket, message, diffRequests } = await setup(page);
    // 行は薄く添える。存在しないものは地の文なら素の文字、インラインコードならコード
    await expect(message.locator('.file-line')).toHaveText([':5', ':5-6', ':3', ':200', ':5', ':10']);
    // 地の文の誤検出は一度もピルにならない（存在すると分かるまで素の文字）
    await expect(message).toContainText('Node.js:18 以上');
    expect(await page.evaluate(() => globalThis.__bareFlash)).toEqual([]);
    await expect(message).toContainText('src/nope.js:3');
    await expect(message.locator('code.inline-code', { hasText: 'nope.js:4' })).toHaveCount(1);
    await expect(message.locator('.file-preview-inline', { hasText: 'nope' })).toHaveCount(0);
    await expect(message.locator('.file-preview-inline', { hasText: 'a.js' })).toHaveCount(0);
    await expect(message.locator('pre code')).toContainText('server/session-turns.js:3');

    // ポーリングで App が描き直してもピルは作り直さない（FilePreview のちらつき対策）
    await pill(message, ':5-6').evaluate((el) => (el.dataset.mark = 'kept'));
    socket.send(JSON.stringify({ type: 'session_list', sessions: [{ ...SESSION, name: 'renamed' }] }));
    socket.send(JSON.stringify({ type: 'subagent_tasks', sessionId: SESSION.id, tasks: [] }));
    await expect(page.locator('.tab-name', { hasText: 'renamed' }).first()).toBeVisible();
    await expect(message.locator('.file-preview-inline[data-mark="kept"]')).toHaveCount(1);

    if (SHOTS) {
      await message.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/diff-jump-chat-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-jump-chat-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    // インライン: 保存した範囲がコミットでも、作業ツリー全体で開く
    await pill(message, ':5').first().locator('.file-link').click();
    const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
    const row = (path, anchor) =>
      drawer.locator(`.diff-file[data-file-path="${path}"] .diff-line[data-anchor="${anchor}"]`);
    await expect(row('server/session-diff.js', 'new:5')).toHaveClass(/cursor/);
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'all' });
    // そのまま Enter で指摘欄
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.diff-comment.active .diff-comment-where')).toHaveText('L5');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // 範囲: 先頭から末尾までが範囲、カーソルは末尾。Enter で範囲の指摘欄
    await pill(message, ':5-6').locator('.file-link').click();
    await expect(row('server/session-diff.js', 'new:6')).toHaveClass(/cursor/);
    await expect(row('server/session-diff.js', 'new:5')).toHaveClass(/target/);
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.diff-comment.active .diff-comment-where')).toHaveText('L5-L6');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // 地の文
    await pill(message, ':3').locator('.file-link').click();
    await expect(row('server/session-turns.js', 'new:3')).toHaveClass(/cursor/);
  });

  test('差分に無い行は注記を出し（ヘッダは動かない）、プレビューでその行を開く', async ({ page }) => {
    const { message } = await setup(page);
    await pill(message, ':5').first().locator('.file-link').click();
    const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
    await expect(drawer.locator('.diff-line.cursor')).toHaveCount(1);
    const parts = ['.diff-drawer-header', '.diff-drawer-title-row', '.diff-drawer-scope', '.diff-drawer-refresh'];
    const measure = async () => Promise.all(parts.map((sel) => rectOf(drawer.locator(sel))));
    const before = await measure();
    const bodyBefore = await rectOf(drawer.locator('.diff-drawer-body'));
    await expect(drawer.locator('.diff-jump-miss')).toHaveCount(0);

    // 開いたまま、差分に無い行（ファイルは差分にある）へ
    await page.keyboard.press('Escape');
    await pill(message, ':200').locator('.file-link').click();
    await expect(drawer.locator('.diff-jump-miss')).toHaveText(/session-diff\.js:200 は差分に無い行/);
    // 1280px 幅では文言が切れない（title にリポジトリ相対のパス）
    const text = drawer.locator('.diff-jump-miss-text');
    expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(text).toHaveAttribute('title', /server\/session-diff\.js:200: この行は変更されていません/);
    await expect(drawer.locator('.diff-jump-miss-open', { hasText: '全体で探す' })).toHaveCount(0);
    await expect(drawer.locator('.diff-line.cursor')).toHaveCount(0);
    expect(await measure()).toEqual(before);
    expect(await rectOf(drawer.locator('.diff-drawer-body'))).toEqual(bodyBefore);

    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/diff-jump-miss-dark.png` });
      await page.locator('body').evaluate((b) => b.classList.add('light-mode'));
      await page.screenshot({ path: `${SHOTS}/diff-jump-miss-light.png` });
      await page.locator('body').evaluate((b) => b.classList.remove('light-mode'));
    }

    // 注記を閉じてもヘッダは動かない
    await drawer.locator('.diff-jump-miss-close').click();
    await expect(drawer.locator('.diff-jump-miss')).toHaveCount(0);
    expect(await measure()).toEqual(before);

    // もう一度出してプレビューで開く: その行へ寄せて光らせる
    await page.keyboard.press('Escape');
    await pill(message, ':200').locator('.file-link').click();
    await drawer.locator('.diff-jump-miss-open').click();
    await expect(drawer).toHaveCount(0);
    const line = page.locator('.drawer-overlay pre.drawer-text [data-line="200"]');
    await expect(line).toHaveClass(/line-initial/);
    await expect(line).toBeInViewport();

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/diff-jump-preview-dark.png` });
  });

  test('同じセッションの差分を小窓に出していれば、小窓の方で飛ぶ', async ({ page, context }) => {
    const { message } = await setup(page);
    test.skip(!(await page.evaluate(() => 'documentPictureInPicture' in globalThis)), 'Document PiP が使えない');
    const input = page.locator('.input-textarea');
    await input.fill('/diff');
    await input.press('Enter');
    const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
    await expect(drawer.locator('.diff-file')).toHaveCount(4);
    const pipPromise = context.waitForEvent('page');
    await drawer.locator('.diff-drawer-pip').click();
    const pip = await pipPromise;
    const pipDrawer = pip.locator('.diff-drawer-pip-host .diff-drawer');
    await expect(pipDrawer.locator('.diff-file')).toHaveCount(4);

    await pill(message, ':3').locator('.file-link').click();
    await expect(
      pipDrawer.locator('.diff-file[data-file-path="server/session-turns.js"] .diff-line[data-anchor="new:3"]'),
    ).toHaveClass(/cursor/);
    // メインにはドロワーを開かない（チャットを見ながら小窓で追える）
    await expect(page.locator('.diff-drawer-overlay')).toHaveCount(0);
  });

  test('理由の出し分け: 行を出していないファイル、このセッションに無いファイルは「全体で探す」', async ({ page }) => {
    const { message, diffRequests } = await setup(page, { scope: 'session' });
    const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
    await pill(message, 'session-completion').locator('.file-link').click();
    await expect(drawer.locator('.diff-jump-miss-text')).toHaveText(
      'session-completion.js:5 は差分が大きく行を出していない',
    );
    await page.keyboard.press('Escape');

    await pill(message, ':10').locator('.file-link').click();
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'session' });
    await expect(drawer.locator('.diff-jump-miss-text')).toHaveText('index.js:10 は差分に無い行');
    await drawer.locator('.diff-jump-miss-open', { hasText: '全体で探す' }).click();
    expect(diffRequests.at(-1)).toMatchObject({ scope: 'all' });
    await expect(drawer.locator('.diff-scope-btn.active')).toHaveText('全体');
    await expect(
      drawer.locator('.diff-file[data-file-path="server/index.js"] .diff-line[data-anchor="new:10"]'),
    ).toHaveClass(/cursor/);
    await expect(drawer.locator('.diff-jump-miss')).toHaveCount(0);
  });

  test('Refs のピン一覧のピルから飛ぶと、Refs を閉じて差分が前面に出る', async ({ page }) => {
    const pins = [{ messageUuid: 'a1', role: 'assistant', label: '要点', excerpt: '差分の要点', messageTimestamp: '' }];
    await setup(page, { pins });
    await page.locator('button', { hasText: 'Refs' }).click();
    await page.locator('.ref-drawer-tab', { hasText: 'ピン' }).click();
    const pinPill = page.locator('.ref-drawer .file-preview-inline', { hasText: ':3' }).first();
    await pinPill.locator('.file-link').click();
    await expect(page.locator('.ref-drawer')).toHaveCount(0);
    const target = page.locator(
      '.diff-drawer-overlay .diff-file[data-file-path="server/session-turns.js"] .diff-line[data-anchor="new:3"]',
    );
    await expect(target).toHaveClass(/cursor/);
    // 差分ドロワーが前面にある（その行の位置で一番上の要素が差分の行）
    const onTop = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = globalThis.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(top);
    });
    expect(onTop).toBe(true);
  });

  test('メッセージピックの p でも差分へ飛び、続けて Enter で指摘欄', async ({ page }) => {
    await setup(page);
    await page.locator('.input-textarea').focus();
    await page.keyboard.press('Alt+r');
    await page.keyboard.press('1');
    await page.keyboard.press('p');
    const drawer = page.locator('.diff-drawer-overlay .diff-drawer');
    await expect(drawer.locator('.diff-line.cursor[data-anchor="new:5"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.diff-comment.active textarea')).toBeFocused();
  });
});
