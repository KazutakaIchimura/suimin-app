// シードの定義（../sleep-seed.js）はこのプロジェクトのフォルダの外にあるため、その親フォルダも監視の対象に入れる
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];

module.exports = config;
