import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 起動中セッションの「終了」ボタン。起動中一覧は ~/.claude/sessions/<pid>.json ＋生存 pid から
// 作るので、テスト中だけ fixture の sessions ディレクトリにステータスファイルを置き、pid には
// このテストプロセス自身（確実に生きている）を使う。
// 実際の tmux ペインは終了しない: confirm は必ず dismiss し、paneId も実在し得ない番号にする。
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, 'fixtures', 'sessions');
const STATUS_FILE = join(SESSIONS_DIR, `${process.pid}.json`);
const SESSION_ID = 'e2e-terminate-running';
const SESSION_NAME = 'e2e-terminate-card';

function writeStatus(status) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const now = Date.now();
  writeFileSync(
    STATUS_FILE,
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION_ID,
      cwd: '/home/e2e/terminate-project',
      name: SESSION_NAME,
      status,
      kind: 'interactive',
      tmux: 'e2e:@999999.%999999',
      startedAt: now,
      updatedAt: now,
    }),
  );
}

test.describe('起動中セッションの終了', () => {
  test.afterEach(() => {
    rmSync(STATUS_FILE, { force: true });
  });

  test('tmux で動いている起動中カードに「終了」が出て、確認ダイアログでキャンセルできる', async ({ page }) => {
    writeStatus('busy');
    await page.goto('/');

    const card = page.locator('.home-card', { hasText: SESSION_NAME });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.hover();
    const button = card.locator('.home-action.danger');
    await expect(button).toHaveText('終了');

    const dialogs = [];
    page.once('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    });
    await button.click();

    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0].type).toBe('confirm');
    expect(dialogs[0].message).toContain('claude を終了し、tmux ペインを閉じます');
    expect(dialogs[0].message).toContain('作業中です');

    // キャンセルしたのでカードは残り、カードのクリック（タブを開く）にも伝播していない
    await expect(card).toBeVisible();
    await expect(page.locator('.home-error')).toHaveCount(0);
    await expect(page.locator('.home-view')).toBeVisible();
  });
});
