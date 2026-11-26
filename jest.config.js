/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/tests'],
  testMatch: ['<rootDir>/tests/{unit,integration}/**/*.test.{ts,tsx}'],
  // E2E のシードアプリは別の Expo プロジェクト（package.json・node_modules を持つ）なので、たどらない
  modulePathIgnorePatterns: ['<rootDir>/tests/e2e/seed/seeder-app/'],
  globalSetup: '<rootDir>/tests/setup/global-setup.js',
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    // drizzle-kit が生成するマイグレーションを @/ から import するため、@/* より先に置く
    '^@/drizzle/(.*)$': '<rootDir>/drizzle/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
