import { test, expect } from '@playwright/test';

// fixture: e2e/fixtures/projects/-home-e2e-fixture-project/e2e-fixture-session-1.jsonl
const FIXTURE_TITLE = 'E2Eフィクスチャ: ヘルスチェック追加';
const FIXTURE_CWD_BASE = 'fixture-project';
const FIXTURE_SECOND_TITLE = 'レート制限メーターの表示がずれているので直してください';
const FIXTURE_THIRD_TITLE = 'ビルド時間を短縮したい';
const FIXTURE_FOURTH_TITLE = 'ログの保存期間をどうするか相談したい';
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

  test('直近一覧にやり残し判定のバッジが出て、状態で絞り込める', async ({ page }) => {
    await page.goto('/');

    // fixture 1・2 はターンを終えて編集なし・最後の応答が質問ではない＝相談のみ、
    // 3 はツール実行中のまま止まっている＝途中で終了、4 は編集なしで質問で終わっている＝回答待ち
    const consult = page.locator('.home-row', { hasText: FIXTURE_TITLE });
    const interrupted = page.locator('.home-row', { hasText: FIXTURE_THIRD_TITLE });
    const asking = page.locator('.home-row', { hasText: FIXTURE_FOURTH_TITLE });
    await expect(consult.locator('.home-completion')).toHaveText('相談のみ');
    await expect(consult.locator('.home-completion')).toHaveAttribute('title', /最後の応答は質問ではない/);
    await expect(interrupted.locator('.home-completion')).toHaveText('途中で終了');
    await expect(interrupted.locator('.home-completion')).toHaveAttribute('title', /ツールの実行中に止まった/);
    await expect(asking.locator('.home-completion')).toHaveText('回答待ち');
    await expect(asking.locator('.home-completion')).toHaveAttribute('title', /最後の応答が質問で終わっている/);

    // 途中で終了の行は応答の代わりに離席要約（現状）を出す
    await expect(interrupted.locator('.home-row-away-label')).toHaveText('現状');
    await expect(interrupted).toContainText('次はビルドを流し直して計測してください');
    await expect(consult.locator('.home-row-away-label')).toHaveCount(0);

    const filter = page.locator('.home-completion-filter');
    await expect(filter.getByRole('button', { name: '途中で終了 1' })).toBeVisible();
    await expect(filter.getByRole('button', { name: '相談のみ 2' })).toBeVisible();
    await expect(filter.getByRole('button', { name: '回答待ち 1' })).toBeVisible();
    await expect(filter.getByRole('button', { name: '完了 0' })).toBeVisible();

    await filter.getByRole('button', { name: '途中で終了 1' }).click();
    await expect(page.locator('.home-row')).toHaveCount(1);
    await expect(interrupted).toBeVisible();

    // もう一度押すと解除
    await filter.getByRole('button', { name: '途中で終了 1' }).click();
    await expect(consult).toBeVisible();
    await expect(interrupted).toBeVisible();

    await filter.getByRole('button', { name: '回答待ち 1' }).click();
    await expect(page.locator('.home-row')).toHaveCount(1);
    await expect(asking).toBeVisible();
  });

  test('直近一覧の行の「詳細」でターン詳細のパネルが開く', async ({ page }) => {
    await page.goto('/');

    const row = page.locator('.home-row', { hasText: FIXTURE_SECOND_TITLE });
    await row.hover();
    await row.getByRole('button', { name: '詳細' }).click();

    const detail = page.locator('.session-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.session-turn')).toHaveCount(1);
    await expect(detail.locator('.session-turn-prompt')).toHaveText(FIXTURE_SECOND_TITLE);
    await expect(detail.locator('.session-detail-cwd')).toHaveText('/home/e2e/second-project');

    // 背景のクリックで閉じる
    await page.locator('.session-detail-overlay').click({ position: { x: 10, y: 10 } });
    await expect(detail).toHaveCount(0);
  });

  // 帯のクリックは readonly セッションを開く（サーバーにセッションが残る）ので、このファイルの最後に置く
  test('カレンダービューで fixture の活動が帯として出て、クリックで詳細から閲覧が開く', async ({ page }) => {
    // fixture は 2026-08-10 の活動。どの TZ でもその週が「今週」になる時刻に固定する
    await page.clock.setFixedTime(new Date('2026-08-10T09:30:00.000Z'));
    await page.goto('/');

    const activity = page.locator('.activity');
    await activity.getByRole('button', { name: 'カレンダー' }).click();

    // 1 週間 = 7 列。メトリック切替はカレンダーでは出さない
    await expect(activity.locator('.cal-day')).toHaveCount(7);
    await expect(activity.getByRole('button', { name: 'トークン' })).toHaveCount(0);

    const segment = activity.locator(`.cal-seg[title*="${FIXTURE_TITLE}"]`);
    await expect(segment).toHaveCount(1, { timeout: 30_000 });
    await expect(segment).toHaveAttribute('title', /fixture-project/);
    // 発言のあった枠は左端に濃淡が付く
    await expect(segment.locator('.cal-density')).not.toHaveCount(0);
    await expect(activity.locator('.cal-legend')).toContainText('fixture-project');

    // 前の週には fixture の活動が無い
    await activity.getByRole('button', { name: '◀' }).click();
    await expect(activity.locator('.cal-count')).toHaveText('0 セッション');
    await activity.getByRole('button', { name: '今週' }).click();
    await expect(segment).toHaveCount(1);

    // 色分けを「調査 / 実装」に切り替えると、帯の中が 10 分枠ごとに塗られ凡例が時間の内訳になる
    await activity.getByRole('button', { name: '調査 / 実装' }).click();
    await expect(segment).toHaveClass(/phase/);
    await expect(segment.locator('.cal-phase')).not.toHaveCount(0);
    await expect(activity.locator('.cal-legend')).toContainText('調査');
    await expect(activity.locator('.cal-legend')).toContainText('実装');
    await expect(activity.locator('.cal-legend')).toContainText('対話');
    await activity.getByRole('button', { name: 'プロジェクト' }).click();
    await expect(activity.locator('.cal-legend')).toContainText('fixture-project');

    // 帯のクリックはまずセッション詳細（ターン詳細）を出し、「開く」でセッションへ移る
    await segment.click();
    const detail = page.locator('.session-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.session-detail-title')).toHaveText(FIXTURE_TITLE);
    await expect(detail.locator('.session-turn').first()).toContainText('claude-bridge の E2E テスト用 fixture です');
    await expect(detail.locator('.session-detail-totals')).toContainText('指示 2');

    // Esc で閉じる → もう一度開いて「開く」
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await segment.click();
    await detail.getByRole('button', { name: '開く' }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator('.chat-view')).toBeVisible();
    await expect(page.locator('.chat-message.human').first()).toContainText(
      'claude-bridge の E2E テスト用 fixture です',
    );
  });
});
