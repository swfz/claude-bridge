import { test, expect } from '@playwright/test';

// fixture: e2e/fixtures/projects/-home-e2e-fixture-project/e2e-fixture-session-1.jsonl
const FIXTURE_TITLE = 'E2Eフィクスチャ: ヘルスチェック追加';
const FIXTURE_CWD_BASE = 'fixture-project';

test.describe('ホーム画面', () => {
  test('直近セッション一覧に fixture のタイトルと cwd が表示される', async ({ page }) => {
    await page.goto('/');

    // WS 接続後にヘッダーの接続状態が Connected になる
    await expect(page.locator('.connection-status')).toContainText('Connected');

    const row = page.locator('.home-row', { hasText: FIXTURE_TITLE });
    await expect(row).toBeVisible();
    await expect(row.locator('.home-card-path')).toContainText(FIXTURE_CWD_BASE);
  });

  test('直近セッション一覧に 2 件目の fixture も表示される', async ({ page }) => {
    await page.goto('/');

    const row = page.locator('.home-row', {
      hasText: 'レート制限メーターの表示がずれているので直してください',
    });
    await expect(row).toBeVisible();
    await expect(row.locator('.home-card-path')).toContainText('second-project');
  });
});
