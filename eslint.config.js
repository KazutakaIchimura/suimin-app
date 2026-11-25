// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['dist/*', 'drizzle/*', '.expo/*'],
  },
  {
    // ログは src/lib/logger.ts の共通ログ関数を経由する（.claude/rules/logging.md）
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/logger.ts'],
    rules: {
      'no-console': 'error',
    },
  },
]);
