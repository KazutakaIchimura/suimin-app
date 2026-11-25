module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // drizzle-kit が生成するマイグレーション（.sql）をアプリに取り込むため
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
