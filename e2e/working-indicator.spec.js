import { test, expect } from '@playwright/test';

// 推論中インジケータ（.working-indicator）は「busy な tmux / PTY タブ」でしか出ないが、
// fixture サーバーでは claude を動かせないので、WebSocket をこのテストで丸ごと差し替えて
// サーバーからのメッセージを手で流す（HTML / JS は fixture サーバーから配信される）。
// 純粋関数のテストだけでは App 側の表示条件の壊れ（choicePrompts に残る {prompt: null} で
// インジケータごと描かれなくなる等）を拾えないため、画面を通して確かめる
const SESSION = {
  id: 'e2e-working-tab',
  type: 'tmux',
  name: 'e2e working',
  cwd: '/home/e2e/working-project',
  alive: true,
  status: 'busy',
  waitingFor: null,
};

const CHOICE = {
  kind: 'question',
  question: 'どちらにしますか？',
  options: [
    { index: 1, label: 'A' },
    { index: 2, label: 'B' },
  ],
};

test.describe('推論中インジケータ', () => {
  test('待ちが解けた choice_prompt（prompt: null）を受け取っても busy の間は出続け、選択肢があるときだけカードに替わる', async ({
    page,
  }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('showHome', 'false');
      localStorage.setItem('activeSessionId', id);
    }, SESSION.id);

    let socket;
    await page.routeWebSocket('**/ws', (ws) => {
      socket = ws;
      // クライアントからの要求（履歴・一覧など）には応答しない
      ws.onMessage(() => {});
    });

    await page.goto('/');
    await expect.poll(() => !!socket).toBe(true);
    const send = (msg) => socket.send(JSON.stringify(msg));

    send({ type: 'session_list', sessions: [SESSION] });
    const indicator = page.locator('.working-indicator');
    await expect(indicator).toContainText('考え中…');

    // タブを開いたとき・待ちが解けたときにサーバーが送る「待っていない」通知
    send({ type: 'choice_prompt', sessionId: SESSION.id, prompt: null, waitingFor: null });
    await expect(indicator).toContainText('考え中…');
    await expect(page.locator('.choice-prompt')).toHaveCount(0);

    // 選択肢が出ている間はカードを出し、インジケータは出さない
    send({ type: 'session_list', sessions: [{ ...SESSION, status: 'waiting', waitingFor: 'input needed' }] });
    send({ type: 'choice_prompt', sessionId: SESSION.id, prompt: CHOICE, waitingFor: 'input needed' });
    await expect(page.locator('.choice-prompt')).toContainText('どちらにしますか？');
    await expect(indicator).toHaveCount(0);

    // 回答して busy に戻ったら、インジケータが戻る
    send({ type: 'session_list', sessions: [SESSION] });
    send({ type: 'choice_prompt', sessionId: SESSION.id, prompt: null, waitingFor: null });
    await expect(page.locator('.choice-prompt')).toHaveCount(0);
    await expect(indicator).toContainText('考え中…');
  });

  test('タスクのチップ列の上に背景なしで出て、出し入れでチップ列を動かさない', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('showHome', 'false');
      localStorage.setItem('activeSessionId', id);
    }, SESSION.id);

    let socket;
    await page.routeWebSocket('**/ws', (ws) => {
      socket = ws;
      ws.onMessage(() => {});
    });

    await page.goto('/');
    await expect.poll(() => !!socket).toBe(true);
    const send = (msg) => socket.send(JSON.stringify(msg));

    send({ type: 'session_list', sessions: [SESSION] });
    send({
      type: 'subagent_tasks',
      sessionId: SESSION.id,
      tasks: [{ agentId: 'a1', description: 'e2e task', status: 'running' }],
    });
    const indicator = page.locator('.working-indicator');
    const strip = page.locator('.task-strip');
    await expect(indicator).toContainText('考え中…');
    await expect(strip).toContainText('e2e task');

    const ind = await indicator.boundingBox();
    const busyStrip = await strip.boundingBox();
    expect(ind.y + ind.height).toBeLessThanOrEqual(busyStrip.y + 0.5);
    const bg = await indicator.evaluate((el) => globalThis.getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');

    // 推論が終わって空の行に戻っても、チップ列の位置は変わらない
    send({ type: 'session_list', sessions: [{ ...SESSION, status: 'idle' }] });
    await expect(indicator).not.toContainText('考え中…');
    const idleStrip = await strip.boundingBox();
    expect(idleStrip.y).toBe(busyStrip.y);
    expect(idleStrip.height).toBe(busyStrip.height);
  });
});
