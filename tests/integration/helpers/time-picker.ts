// 時刻ピッカーの偽物（tests/setup/native-alarm-mocks.js）を操作する補助（設計書 03 の「テストリスト」共通の前提）。
// 入力のボタン（表示の文字が `label` で始まる）を押してピッカーを出し、`testID` のピッカーに選んだ時刻を渡す
import type { LoadedApp } from './load-app';

export async function pickTime(
  app: LoadedApp,
  label: string,
  testID: string,
  hhmm: string,
): Promise<void> {
  const [hour, minute] = hhmm.split(':').map(Number);
  await app.rntl.fireEvent.press(
    app.screen.getByRole('button', { name: new RegExp(`^${label} `) }),
  );
  const picker = await app.screen.findByTestId(testID);
  const value = new Date(picker.props.value as Date);
  value.setHours(hour, minute, 0, 0);
  await app.rntl.act(async () => {
    picker.props.onChange({ type: 'set', nativeEvent: { timestamp: value.getTime() } }, value);
  });
}
