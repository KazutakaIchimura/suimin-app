// 日付の扱い（帰属日・時刻の整形）をテスト環境で固定する（設計書 3.3「設定・依存」）
module.exports = async () => {
  process.env.TZ = 'Asia/Tokyo';
};
