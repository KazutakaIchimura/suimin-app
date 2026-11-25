import { defineConfig } from 'drizzle-kit';

// テーブル定義は各機能の *.schema.ts に置く（.claude/rules/architecture.md）
export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/features/**/*.schema.ts',
  out: './drizzle',
});
