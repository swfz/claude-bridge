import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // node:test には既定のタイムアウトが無かった。遅い環境（CI・カバレッジ計測中）で
    // 数秒かかる結合テストが既定の 5 秒で落ちないよう広めに取る
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'client/src/utils/**/*.js'],
      // index.js（エントリポイント）はテストから読み込まない。node:test の組み込みカバレッジは
      // 読み込んだファイルしか数えなかったので、同じ母数にするため除外する
      exclude: ['server/index.js'],
      thresholds: { lines: 90 },
    },
  },
});
