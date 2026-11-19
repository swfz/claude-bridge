import { defineConfig } from '@mizchi/mutator';

// ミューテーションテスト（pnpm mutation）の設定。全体は重いので、普段は
// `pnpm mutation --include <file>` か `--since main` で対象を絞って使う。CI では回さない
export default defineConfig({
  include: ['server/**/*.js', 'client/src/utils/**/*.js'],
  // エントリポイントはテストから読み込まない（カバレッジの除外と同じ）
  exclude: ['server/index.js'],
  runner: 'vitest',
});
