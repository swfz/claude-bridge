import { test, expect } from '@playwright/test';

// fixture: e2e/fixtures/projects/-home-e2e-fixture-project/e2e-fixture-session-1.jsonl
const FIXTURE_TITLE = 'E2Eフィクスチャ: ヘルスチェック追加';
const FIXTURE_CWD_BASE = 'fixture-project';
const FIXTURE_SECOND_TITLE = 'レート制限メーターの表示がずれているので直してください';
const FIXTURE_ARTIFACT_URL = 'https://claude.ai/code/artifact/e2e00000-0000-4000-8000-000000000001';

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

    const row = page.locator('.home-row', { hasText: FIXTURE_SECOND_TITLE });
    await expect(row).toBeVisible();
    await expect(row.locator('.home-card-path')).toContainText('second-project');
  });

  test('公開した Artifact のリンクが直近セッションの行に出る', async ({ page }) => {
    await page.goto('/');

    const row = page.locator('.home-row', { hasText: FIXTURE_TITLE });
    const chips = row.locator('.home-artifact-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute('href', FIXTURE_ARTIFACT_URL);
    await expect(chips.first()).toHaveAttribute('title', /E2E ヘルスチェックレポート/);
  });

  test('活動パネルが草・日別・週別・月別・曜日の 5 ビューを切り替えられる', async ({ page }) => {
    await page.goto('/');

    const activity = page.locator('.activity');
    await expect(activity).toBeVisible();

    // 集計が届くまでは「集計中…」。届いたら 53 週分の列が出る
    await expect(activity.locator('.activity-week')).toHaveCount(53, { timeout: 30_000 });
    // 1 年分の升目（先頭の週は曜日合わせで欠ける日がある）
    expect(await activity.locator('.activity-week .activity-cell').count()).toBeGreaterThanOrEqual(365);

    // 日別: 1 日 1 本の棒
    await activity.getByRole('button', { name: '日別' }).click();
    await expect(activity.locator('.activity-bar-slot')).toHaveCount(365);

    // 週別・月別: 畳んだ分だけ本数が減る（日数はローカル TZ 次第なので下限だけ見る）
    await activity.getByRole('button', { name: '週別' }).click();
    const weeklyBars = await activity.locator('.activity-bar-slot').count();
    expect(weeklyBars).toBeGreaterThan(50);
    expect(weeklyBars).toBeLessThan(60);

    await activity.getByRole('button', { name: '月別' }).click();
    const monthlyBars = await activity.locator('.activity-bar-slot').count();
    expect(monthlyBars).toBeGreaterThan(11);
    expect(monthlyBars).toBeLessThan(15);

    // 曜日別: 月〜日の 7 行
    await activity.getByRole('button', { name: '曜日' }).click();
    const weekdayRows = activity.locator('.activity-weekday-row');
    await expect(weekdayRows).toHaveCount(7);
    await expect(weekdayRows.first().locator('.activity-weekday-label')).toHaveText('月');

    // メトリック切替はビューをまたいで効く（fixture の活動量には依存しない）
    await activity.getByRole('button', { name: 'トークン' }).click();
    await expect(activity.locator('.activity-segment.active')).toHaveText(['曜日', 'トークン']);

    await activity.getByRole('button', { name: '草' }).click();
    await expect(activity.locator('.activity-week')).toHaveCount(53);
  });

  test('活動グラフの棒をクリックすると直近一覧がその期間に絞られる', async ({ page }) => {
    await page.goto('/');

    const activity = page.locator('.activity');
    await expect(activity.locator('.activity-week')).toHaveCount(53, { timeout: 30_000 });
    await activity.getByRole('button', { name: '日別' }).click();

    // fixture の活動は 2 日ぶん。どのローカル TZ でも 2 日に分かれる（25 時間差）ので、
    // 「活動のある棒のうち古い方」＝ 1 件目の fixture の日、と特定できる
    const activeBars = activity.locator('.activity-bar-slot[title*="メッセージ"]');
    await expect(activeBars).toHaveCount(2);
    await expect(activeBars.first()).toHaveAttribute('title', /^8\/\d+/);
    await activeBars.first().click();

    // その日に活動したセッションだけが一覧に残る
    await expect(page.locator('.home-period-chip')).toBeVisible();
    await expect(page.locator('.home-row', { hasText: FIXTURE_TITLE })).toBeVisible();
    await expect(page.locator('.home-row', { hasText: FIXTURE_SECOND_TITLE })).toHaveCount(0);

    // × で解除すると日数モードに戻り、両方の fixture が並ぶ
    await page.locator('.home-period-clear').click();
    await expect(page.locator('.home-period-chip')).toHaveCount(0);
    await expect(page.locator('.home-row', { hasText: FIXTURE_SECOND_TITLE })).toBeVisible();
  });
});
