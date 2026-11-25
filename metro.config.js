const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// drizzle-kit が生成するマイグレーション（.sql）を読み込めるようにする
config.resolver.sourceExts.push('sql');

module.exports = config;
