/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/tests'],
  testMatch: ['<rootDir>/tests/{unit,integration}/**/*.test.{ts,tsx}'],
  // E2E のシードアプリは別の Expo プロジェクト（package.json・node_modules を持つ）なので、たどらない
  modulePathIgnorePatterns: ['<rootDir>/tests/e2e/seed/seeder-app/'],
  globalSetup: '<rootDir>/tests/setup/global-setup.js',
  // jest-expo の既定の setupFiles に加えて、描画をネイティブで行うライブラリを差し替える（設計書 02 の 3.3）
  setupFiles: [
    ...require('jest-expo/jest-preset').setupFiles,
    '<rootDir>/tests/setup/native-render-mocks.js',
  ],
  // アプリ（app.json の experiments.reactCompiler）と同じく React Compiler を通して変換する。
  // jest-expo の既定は Compiler を通さないため、本番では Compiler の最適化で起きる不具合をテストで見逃す（設計書 02 の 3.3）
  transform: (() => {
    const { transform } = require('jest-expo/jest-preset');
    const [babelJest, options] = transform['\\.[jt]sx?$'];
    return {
      ...transform,
      '\\.[jt]sx?$': [
        babelJest,
        { ...options, caller: { ...options.caller, supportsReactCompiler: true } },
      ],
    };
  })(),
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    // drizzle-kit が生成するマイグレーションを @/ から import するため、@/* より先に置く
    '^@/drizzle/(.*)$': '<rootDir>/drizzle/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
