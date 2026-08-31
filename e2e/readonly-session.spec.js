import { test, expect } from '@playwright/test';

const FIXTURE_TITLE = 'E2Eフィクスチャ: ヘルスチェック追加';

// サーバーはセッション一覧をプロセス全体でグローバルに保持し、全 WS クライアントへ
// broadcast する（1人のユーザーが1つのブラウザで使う前提の設計）。同じ fixture を
// 複数のテストから開くと readonly セッションが毎回新規に作られ蓄積してしまうため、
// 「開く→会話が見える→ホームに戻ってもタブが残る」を1テストにまとめて検証する。
test('行をクリックすると readonly セッションが開き、会話が見え、ホームに戻ってもタブは残る', async ({ page }) => {
  await page.goto('/');

  const row = page.locator('.home-row', { hasText: FIXTURE_TITLE });
  await expect(row).toBeVisible();
  await row.click();

  // readonly セッションが開くとチャットビューに切り替わる
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.chat-message.human').first()).toContainText('claude-bridge の E2E テスト用 fixture です');
  await expect(page.locator('.chat-message.assistant').first()).toContainText(
    'ヘルスチェックのエンドポイントを追加します',
  );

  // 開いたセッションはサイドバーのタブとしても残る
  const tab = page.locator('.tab', { hasText: FIXTURE_TITLE });
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveClass(/active/);

  // ⌂ Home でホームに戻ってもタブ自体は消えない（閉じない限り残る）
  await page.locator('.tab-home').click();
  await expect(page.locator('.home-view')).toBeVisible();
  await expect(tab).toHaveCount(1);
});
