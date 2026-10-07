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

  // Artifact ツールで公開したページは、会話内のカードと最上段のリンク一覧の両方に出る
  const artifactUrl = 'https://claude.ai/code/artifact/e2e00000-0000-4000-8000-000000000001';
  const artifactCard = page.locator('.chat-message.artifact');
  await expect(artifactCard).toHaveCount(1);
  await expect(artifactCard.locator('a')).toHaveAttribute('href', artifactUrl);
  await expect(artifactCard).toContainText('E2E ヘルスチェックレポート');
  const strip = page.locator('.artifact-strip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('a')).toHaveCount(1);
  await expect(strip.locator('a')).toHaveAttribute('href', artifactUrl);
  await expect(strip.locator('a')).toHaveAttribute('target', '_blank');

  // 実行中／終了済みの Bash 出力はチップ列に出て、クリックするとドロワーで本文が読める
  const taskStrip = page.locator('.task-strip');
  await expect(taskStrip).toBeVisible();
  const runningChip = taskStrip.locator('.task-chip-running', { hasText: 'transforming modules...' });
  await expect(runningChip).toHaveCount(1);
  await expect(taskStrip.locator('.task-chip-done', { hasText: 'tests 12 / pass 12 / fail 0' })).toHaveCount(1);
  await runningChip.click();
  const shellDrawer = page.locator('.shell-drawer');
  await expect(shellDrawer).toBeVisible();
  await expect(shellDrawer.locator('.shell-output-text')).toContainText('vite v5 building for production...');
  await shellDrawer.locator('.shell-drawer-close').click();
  await expect(shellDrawer).toHaveCount(0);

  // ヘッダの Links で、会話に出てきた URL（本文・ツール入力・Artifact）の一覧がドロワーで開く
  await page.locator('.thread-toggle', { hasText: 'Links' }).click();
  const linkDrawer = page.locator('.link-drawer');
  await expect(linkDrawer).toBeVisible();
  const linkRows = linkDrawer.locator('.link-row');
  await expect(linkRows).toHaveCount(3);
  const prUrl = 'https://github.com/swfz/claude-bridge/pull/1';
  const prRow = linkRows.filter({ hasText: 'github.com' });
  await expect(prRow.locator('a')).toHaveAttribute('href', prUrl);
  await expect(prRow.locator('a')).toHaveText('claude-bridge の PR');
  const docsRow = linkRows.filter({ hasText: 'example.com' });
  await expect(docsRow).toContainText('×2');
  await expect(docsRow.locator('.link-badge', { hasText: 'WebFetch' })).toHaveCount(1);
  // WebFetch の結果から取ったタイトルがアンカーに出て、URL が出てきた行の文脈が添えられる
  await expect(docsRow.locator('.link-row-anchor')).toHaveText('E2E フェッチ結果のタイトル');
  await expect(docsRow.locator('.link-row-context')).toContainText('参考:');
  await expect(linkRows.filter({ hasText: 'claude.ai' })).toHaveCount(1);
  // fixture のリンクはすべて Claude 側の出現が先なので「Claude」に数えられ、「自分」で絞ると 0 件
  const originToggles = linkDrawer.locator('.link-drawer-origin');
  await expect(originToggles.getByRole('button', { name: 'Claude 3' })).toBeVisible();
  await expect(prRow.locator('.link-row-icon')).toHaveAttribute('title', 'Claude が探した');
  await originToggles.getByRole('button', { name: '自分 0' }).click();
  await expect(linkRows).toHaveCount(0);
  await originToggles.getByRole('button', { name: 'すべて 3' }).click();
  await expect(linkRows).toHaveCount(3);
  // 絞り込み
  await linkDrawer.locator('.link-drawer-filter').fill('github');
  await expect(linkRows).toHaveCount(1);
  // 「会話へ」でドロワーが閉じ、そのメッセージへスクロールする
  await linkRows.first().getByRole('button', { name: '会話へ' }).click();
  await expect(linkDrawer).toHaveCount(0);
  await expect(page.locator('[data-message-uuid="e2e-uuid-links"]')).toBeInViewport();

  // 開いたセッションはサイドバーのタブとしても残る
  const tab = page.locator('.tab', { hasText: FIXTURE_TITLE });
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveClass(/active/);

  // ⌂ Home でホームに戻ってもタブ自体は消えない（閉じない限り残る）
  await page.locator('.tab-home').click();
  await expect(page.locator('.home-view')).toBeVisible();
  await expect(tab).toHaveCount(1);
});
