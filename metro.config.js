const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// drizzle-kit が生成するマイグレーション（.sql）を読み込めるようにする
config.resolver.sourceExts.push('sql');

// E2E のシードアプリは別の Expo プロジェクトなので、本体のバンドルの対象にしない
config.resolver.blockList = [/tests\/e2e\/seed\/seeder-app\/.*/];

module.exports = config;
