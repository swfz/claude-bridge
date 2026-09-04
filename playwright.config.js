import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, readdirSync, utimesSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 既定は 3199。別の worktree / 別セッションのサーバーが掴んでいると reuseExistingServer で
// そちらに繋いでしまうため、E2E_PORT で逃がせるようにしてある
const PORT = Number(process.env.E2E_PORT) || 3199;
const PROJECTS_DIR = join(__dirname, 'e2e', 'fixtures', 'projects');
const SESSIONS_DIR = join(__dirname, 'e2e', 'fixtures', 'sessions');
// 実行中シェルの出力は本来 os.tmpdir() 配下に書かれるので、フィクスチャに向ける
const SHELL_TASKS_DIR = join(__dirname, 'e2e', 'fixtures', 'shell-tasks');
const BRIDGE_DIR = join(__dirname, 'e2e', '.tmp', 'bridge');

// CLAUDE_BRIDGE_DIR はサーバー起動時に Storage が mkdirSync するが、
// webServer の起動前に一応存在させておく（gitignore 対象の作業ディレクトリ）
mkdirSync(BRIDGE_DIR, { recursive: true });

// 直近セッション一覧は JSONL の mtime で期間（既定 7 日）を絞るため、fixture が
// コミットされてから日が経つとローカルでは 0 件になりテストが落ちる。CI は checkout
// 時刻が mtime に入るので気づけない。内容は変えず mtime だけ現在に合わせる。
const now = new Date();
for (const projectDir of readdirSync(PROJECTS_DIR)) {
  for (const file of readdirSync(join(PROJECTS_DIR, projectDir))) {
    if (file.endsWith('.jsonl')) utimesSync(join(PROJECTS_DIR, projectDir, file), now, now);
  }
}

export default defineConfig({
  testDir: 'e2e',
  // サーバーはこのブリッジの想定どおり単一プロセス・全 WS クライアントへブロードキャストする
  // 設計（session_list 等はグローバル状態）。ワーカーを並列にすると、あるテストが開いた
  // readonly セッションが他テストのページにも broadcast されてカード/タブ数がぶれるため、
  // 常に直列実行にする（実際の利用も「一人のユーザーが一つのブラウザ」を想定しており妥当）。
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // 注意: webServer はビルド済み client/dist を配信するだけで、ここでビルドは実行しない。
  // テスト実行前に `npm run build` 済みであることが前提（npm scripts 側で担保する）。
  webServer: {
    command: 'node server/index.js',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    cwd: __dirname,
    env: {
      PORT: String(PORT),
      CLAUDE_BRIDGE_PROJECTS_DIR: PROJECTS_DIR,
      CLAUDE_BRIDGE_SESSIONS_DIR: SESSIONS_DIR,
      CLAUDE_BRIDGE_DIR: BRIDGE_DIR,
      CLAUDE_BRIDGE_SHELL_TASKS_ROOT: SHELL_TASKS_DIR,
    },
  },
});
