// 描画をネイティブ（Skia）で行うライブラリを、Jest では何も描かない部品に差し替える
// （.claude/rules/testing.md「描画をネイティブで行うライブラリ」・設計書 docs/features/02_sleep-chart.md の 3.3）。
// Jest では描いた絵を確かめられないため。描画の部品に渡す値は純粋関数の単体テストで、絵は実機で確かめる。
// renderRouter が src/app/ のすべてのルート（グラフの画面を含む）を読み込むため、全テストに効かせる
const Nothing = () => null;

jest.mock('victory-native', () => ({
  __esModule: true,
  CartesianChart: Nothing,
  Bar: Nothing,
}));

jest.mock('@shopify/react-native-skia', () => ({
  __esModule: true,
  Rect: Nothing,
}));
