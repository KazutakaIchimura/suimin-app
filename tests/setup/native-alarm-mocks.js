// アラームのライブラリ・UUID の生成・OS の時刻ピッカーを、Jest では偽物に差し替える
// （.claude/rules/testing.md の境界「アラーム」「OS の部品を出すライブラリ」・設計書 docs/features/03_smart-alarm.md の 3.3）。
// renderRouter が src/app/ のすべてのルートと _layout.tsx（スマートアラームの部品）を読み込むため、全テストに効かせる。
// アラームの偽物の中身は tests/integration/helpers/alarm-mocks.ts に置き、ここでは jest.mock に渡すだけ

jest.mock('react-native-alarm-scheduler', () =>
  jest.requireActual('../integration/helpers/alarm-mocks').createAlarmSchedulerModuleMock(),
);

jest.mock('expo-crypto', () =>
  jest.requireActual('../integration/helpers/alarm-mocks').createCryptoModuleMock(),
);

// 時刻ピッカー：何も出さず、渡された props（`testID`・`value`・`onChange`）を持つだけの部品にする。
// テストは `testID` で選び、`props.onChange` に選んだ時刻を渡す
jest.mock('@react-native-community/datetimepicker', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  const MockDateTimePicker = (props) => createElement(View, props);
  return {
    __esModule: true,
    default: MockDateTimePicker,
    DateTimePickerAndroid: { open: jest.fn(), dismiss: jest.fn() },
  };
});
