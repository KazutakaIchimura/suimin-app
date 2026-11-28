// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { deferred } from '../../helpers/deferred';
import { cleanupApp, loadApp, warmUpApp, type LoadedApp } from '../../helpers/load-app';
import { seedE } from '../../helpers/seed-s';
import { createTestDb, type TestDb } from '../../helpers/test-db';
import { pickTime } from '../../helpers/time-picker';
/* eslint-enable import/first */

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`AppState`。
// アラームのライブラリ・UUID・時刻ピッカーは tests/setup/native-alarm-mocks.js が差し替える
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

jest.setTimeout(15000);
beforeAll(() => warmUpApp(), 120000);

/** JST の日時（`2026-11-29T05:48` または `2026-11-29T05:48:30` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local}${local.length === 16 ? ':00' : ''}+09:00`).getTime();

const STANDARD_PARAMS =
  '入眠 14分（標準値。あと 14日分の記録で切り替わります）・1サイクル 90分（標準値。あと 14日分の記録で切り替わります）';
const SEED_E_PARAMS =
  '入眠 8分（あなたの記録）・1サイクル 90分（標準値。あと 1日分の記録で切り替わります）';
const NOW_548 = '5:48 4サイクル（6時間14分後）';
const NOW_718 = '7:18 5サイクル（7時間44分後）';
const NOT_SET = 'アラームは設定されていません';
const BED = 'smart-alarm-bedtime-input';
const WAKE = 'smart-alarm-wake-input';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(jst('2026-11-28T23:34'));
  mockTestDb = createTestDb();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await cleanupApp();
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockTestDb.destroy();
});

/** アプリを開き、一覧の入口からアラームの画面へ移る */
async function openAlarm(app: LoadedApp) {
  await app.open();
  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: /^アラーム/ }));
  expect(await app.screen.findByText(/入眠 /)).toBeOnTheScreen();
}

const button = (app: LoadedApp, name: string | RegExp) => app.screen.getByRole('button', { name });

/** 偽物の予約の時刻（UNIX ミリ秒）の一覧 */
const scheduledTimes = (app: LoadedApp) =>
  app.alarm.fakeAlarmState().scheduled.map((a) => a.timestamp);

/** 今を進め、画面の状態は変えずに描き直させる（store の同じ値を入れ直して購読している部品を描き直す） */
async function advanceAndRerender(app: LoadedApp, ms: number) {
  jest.setSystemTime(ms);
  const { useSmartAlarmStore } =
    require('@/features/smart-alarm/smart-alarm.store') as typeof import('@/features/smart-alarm/smart-alarm.store');
  await app.rntl.act(async () => {
    useSmartAlarmStore.setState({ next: { ...useSmartAlarmStore.getState().next } });
  });
}

// T100
it('一覧の入口からアラームの画面へ移ると、未設定・使う値・今から寝る・起床時刻を指定が出る', async () => {
  const app = loadApp();
  await openAlarm(app);

  expect(app.screen).toHavePathname('/alarm');
  expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: '解除' })).toBeNull();
  expect(app.screen.getByText(STANDARD_PARAMS)).toBeOnTheScreen();
  for (const name of [
    NOW_548,
    NOW_718,
    '8:48 6サイクル（9時間14分後）',
    '就寝予定 23:34',
    '起きたい時刻 7:00',
    '4:18 3サイクル（4時間44分）',
    '5:48 4サイクル（6時間14分）',
    '7:00 希望の時刻（7時間26分）',
  ]) {
    const b = button(app, name);
    expect(b).toBeOnTheScreen();
    expect(b.props.accessibilityLabel).toBe(name);
  }
});

// T101
it('今から寝るの候補を押すと予約され、設定の文言と次のアラームが出て、一覧の入口も変わる', async () => {
  const app = loadApp();
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(await app.screen.findByText('5:48 にアラームを設定しました')).toBeOnTheScreen();
  expect(await app.screen.findByText('次のアラーム 11月29日（日） 5:48')).toBeOnTheScreen();
  expect(button(app, '解除')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([jst('2026-11-29T05:48')]);

  await app.rntl.act(async () =>
    (require('expo-router') as typeof import('expo-router')).router.back(),
  );
  expect(
    await app.screen.findByRole('button', { name: 'アラーム 11月29日（日） 5:48' }),
  ).toBeOnTheScreen();
});

// T102
it('起きたい時刻を選ぶと、起床時刻を指定の候補が替わる', async () => {
  const app = loadApp();
  await openAlarm(app);

  await pickTime(app, '起きたい時刻', WAKE, '6:30');

  for (const name of [
    '起きたい時刻 6:30',
    '4:18 3サイクル（4時間44分）',
    '5:48 4サイクル（6時間14分）',
    '6:30 希望の時刻（6時間56分）',
  ]) {
    expect(button(app, name)).toBeOnTheScreen();
  }
});

// T103
it('就寝予定を選ぶと、就寝予定から候補を計算し直す', async () => {
  const app = loadApp();
  await openAlarm(app);

  await pickTime(app, '起きたい時刻', WAKE, '6:30');
  await pickTime(app, '就寝予定', BED, '23:50');

  for (const name of [
    '就寝予定 23:50',
    '4:34 3サイクル（4時間44分）',
    '6:04 4サイクル（6時間14分）',
    '6:30 希望の時刻（6時間40分）',
  ]) {
    expect(button(app, name)).toBeOnTheScreen();
  }
});

// T104
it('起床時刻を指定の希望の時刻を押すと、その時刻に予約される', async () => {
  const app = loadApp();
  await openAlarm(app);

  await pickTime(app, '起きたい時刻', WAKE, '6:30');
  await app.rntl.fireEvent.press(button(app, '6:30 希望の時刻（6時間56分）'));

  expect(await app.screen.findByText('6:30 にアラームを設定しました')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([jst('2026-11-29T06:30')]);
});

// T105
it('就寝予定を選ばなければ、時刻が進むと就寝予定と候補が今に追従する（前面復帰で描き直す）', async () => {
  const app = loadApp();
  await openAlarm(app);

  jest.setSystemTime(jst('2026-11-28T23:35'));
  await app.emit('background');
  await app.emit('active');

  for (const name of [
    '就寝予定 23:35',
    '4:19 3サイクル（4時間44分）',
    '5:49 4サイクル（6時間14分）',
    '7:00 希望の時刻（7時間25分）',
    '5:49 4サイクル（6時間14分後）',
  ]) {
    expect(button(app, name)).toBeOnTheScreen();
  }
});

// T106
it('選んだ就寝予定は、その分の間はそのままで、過ぎたら今に戻る（翌日にずらさない）', async () => {
  const app = loadApp();
  await openAlarm(app);
  await pickTime(app, '就寝予定', BED, '23:40');

  jest.setSystemTime(jst('2026-11-28T23:40:59'));
  await app.emit('background');
  await app.emit('active');
  expect(button(app, '就寝予定 23:40')).toBeOnTheScreen();

  jest.setSystemTime(jst('2026-11-28T23:41'));
  await app.emit('background');
  await app.emit('active');
  for (const name of [
    '就寝予定 23:41',
    '4:25 3サイクル（4時間44分）',
    '5:55 4サイクル（6時間14分）',
    '7:00 希望の時刻（7時間19分）',
  ]) {
    expect(button(app, name)).toBeOnTheScreen();
  }
});

// T107
it('設定があるときに別の候補を押すと、前のものが取り消されて1つだけになる', async () => {
  const app = loadApp();
  app.alarm.seedAlarm('A', jst('2026-11-29T05:48'));
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_718));

  expect(await app.screen.findByText('次のアラーム 11月29日（日） 7:18')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([jst('2026-11-29T07:18')]);
});

// T108
it('許可がないと案内と「設定を開く」が出て、押すと正確なアラームの設定を開く', async () => {
  const app = loadApp();
  app.alarm.fakeAlarmState().permission.status = 'denied';
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(
    await app.screen.findByText('アラームの許可がありません。設定で許可してください'),
  ).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([]);
  await app.rntl.fireEvent.press(button(app, '設定を開く'));
  await app.rntl.waitFor(() =>
    expect(app.alarm.alarmMock().openAlarmSettingsAsync).toHaveBeenCalledTimes(1),
  );
  expect(app.alarm.alarmMock().openFullScreenIntentSettingsAsync).not.toHaveBeenCalled();
});

// T109
it.each([
  ['例外を投げる', 'reject'],
  ['false を返す', 'false'],
] as const)('設定を開く関数が%sと「設定を開けませんでした」', async (_label, mode) => {
  const app = loadApp();
  app.alarm.fakeAlarmState().permission.status = 'denied';
  const open = app.alarm.alarmMock().openAlarmSettingsAsync;
  if (mode === 'reject') open.mockRejectedValueOnce(new Error('native failure'));
  else open.mockResolvedValueOnce(false);
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));
  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: '設定を開く' }));

  expect(await app.screen.findByText('設定を開けませんでした')).toBeOnTheScreen();
});

// T127
it('「設定を開く」が続けて失敗しても、「設定を開けませんでした」は1つだけ', async () => {
  const app = loadApp();
  app.alarm.fakeAlarmState().permission.status = 'denied';
  app.alarm.alarmMock().openAlarmSettingsAsync.mockResolvedValue(false);
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));
  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: '設定を開く' }));
  expect(await app.screen.findByText('設定を開けませんでした')).toBeOnTheScreen();
  await app.rntl.fireEvent.press(button(app, '設定を開く'));
  await app.rntl.waitFor(() =>
    expect(app.alarm.alarmMock().openAlarmSettingsAsync).toHaveBeenCalledTimes(2),
  );

  expect(app.screen.getAllByText('設定を開けませんでした')).toHaveLength(1);
  const keyWarnings = (console.error as jest.Mock).mock.calls.filter((c) =>
    String(c[0]).includes('same key'),
  );
  expect(keyWarnings).toEqual([]);
});

// T110
it('全画面表示の許可がないと、設定の成功と案内の両方が出て、全画面表示の設定を開く', async () => {
  const app = loadApp();
  Object.assign(app.alarm.fakeAlarmState().permission, {
    platform: 'android',
    canUseFullScreenIntent: false,
  });
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(await app.screen.findByText('5:48 にアラームを設定しました')).toBeOnTheScreen();
  expect(
    app.screen.getByText('ロック中の画面にアラームを大きく出すには、設定で許可してください'),
  ).toBeOnTheScreen();
  await app.rntl.fireEvent.press(button(app, '設定を開く'));
  await app.rntl.waitFor(() =>
    expect(app.alarm.alarmMock().openFullScreenIntentSettingsAsync).toHaveBeenCalledTimes(1),
  );
  expect(app.alarm.alarmMock().openAlarmSettingsAsync).not.toHaveBeenCalled();
});

// T111
it('解除すると未設定になり、前の設定の文言は消える', async () => {
  const app = loadApp();
  await openAlarm(app);
  await app.rntl.fireEvent.press(button(app, NOW_548));
  expect(await app.screen.findByText('5:48 にアラームを設定しました')).toBeOnTheScreen();

  await app.rntl.fireEvent.press(button(app, '解除'));

  expect(await app.screen.findByText('アラームを解除しました')).toBeOnTheScreen();
  expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();
  expect(app.screen.queryByText('5:48 にアラームを設定しました')).toBeNull();
  expect(app.screen.queryByRole('button', { name: '解除' })).toBeNull();
});

// T112
it('予約が失敗すると「アラームを設定できませんでした」と、読み直した実際の状態が出る', async () => {
  const app = loadApp();
  app.alarm.alarmMock().scheduleAlarmAsync.mockRejectedValueOnce(new Error('native failure'));
  await openAlarm(app);
  expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();
  app.alarm.seedAlarm('A', jst('2026-11-29T06:00'));

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(await app.screen.findByText('アラームを設定できませんでした')).toBeOnTheScreen();
  expect(await app.screen.findByText('次のアラーム 11月29日（日） 6:00')).toBeOnTheScreen();
});

// T113
it('予約のあとの取り消しが失敗すると、その文言と、読み直した最も早いアラームが出る', async () => {
  const app = loadApp();
  app.alarm.seedAlarm('A', jst('2026-11-29T07:18'));
  app.alarm.alarmMock().cancelAlarmAsync.mockRejectedValueOnce(new Error('native failure'));
  await openAlarm(app);
  expect(await app.screen.findByText('次のアラーム 11月29日（日） 7:18')).toBeOnTheScreen();

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(
    await app.screen.findByText(
      '5:48 にアラームを設定しましたが、前のアラームを取り消せませんでした',
    ),
  ).toBeOnTheScreen();
  expect(await app.screen.findByText('次のアラーム 11月29日（日） 5:48')).toBeOnTheScreen();
});

// T114
it('解除が途中で失敗すると「アラームを解除できませんでした」と残ったアラームが出る', async () => {
  const app = loadApp();
  app.alarm.seedAlarm('A', jst('2026-11-29T05:48'));
  app.alarm.seedAlarm('B', jst('2026-11-29T07:18'));
  const cancel = app.alarm.alarmMock().cancelAlarmAsync;
  const original = cancel.getMockImplementation()!;
  cancel.mockImplementation(async (id: string) => {
    if (id === 'B') throw new Error('native failure');
    return original(id);
  });
  await openAlarm(app);

  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: '解除' }));

  expect(await app.screen.findByText('アラームを解除できませんでした')).toBeOnTheScreen();
  expect(await app.screen.findByText('次のアラーム 11月29日（日） 7:18')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([jst('2026-11-29T07:18')]);
});

// T115
it.each([
  ['予約', 'scheduleAlarmAsync', NOW_718],
  ['取り消し', 'cancelAlarmAsync', '解除'],
  ['許可の要求', 'requestPermissionsAsync', NOW_718],
] as const)('%sの処理中は、全部の候補と「解除」が押せない', async (_label, fn, press) => {
  const app = loadApp();
  app.alarm.seedAlarm('A', jst('2026-11-29T05:48'));
  const held = deferred<void>();
  const mock = app.alarm.alarmMock()[fn];
  const original = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (...args: unknown[]) => {
    await held.promise;
    return original(...args);
  });
  await openAlarm(app);
  await app.screen.findByRole('button', { name: '解除' });

  await app.rntl.fireEvent.press(button(app, press));

  const targets = [
    NOW_548,
    NOW_718,
    '8:48 6サイクル（9時間14分後）',
    '4:18 3サイクル（4時間44分）',
    '5:48 4サイクル（6時間14分）',
    '7:00 希望の時刻（7時間26分）',
    '解除',
  ];
  for (const name of targets) expect(button(app, name)).toBeDisabled();

  await app.rntl.act(async () => held.resolve());
  await app.rntl.waitFor(() => expect(button(app, NOW_548)).toBeEnabled());
});

/** 止めておける関数：次の1回だけ、`held` が解けるまで待ってから本物の振る舞いをする */
function holdNext(fn: jest.Mock) {
  const held = deferred<void>();
  const original = fn.getMockImplementation()!;
  fn.mockImplementationOnce(async (...args: unknown[]) => {
    await held.promise;
    return original(...args);
  });
  return held;
}

/** 読み込み直したアプリの store */
const storeOf = () =>
  (
    require('@/features/smart-alarm/smart-alarm.store') as typeof import('@/features/smart-alarm/smart-alarm.store')
  ).useSmartAlarmStore;

// T148
it.each([[Number.NaN], [Infinity]])(
  'store の設定に %p を渡すと「アラームを設定できませんでした」',
  async (at) => {
    const app = loadApp();
    await app.open('/alarm');
    expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();

    await app.rntl.act(async () => storeOf().getState().set(at));

    expect(await app.screen.findByText('アラームを設定できませんでした')).toBeOnTheScreen();
    expect(scheduledTimes(app)).toEqual([]);
  },
);

// T149
it.each([
  ['設定中に設定', 'set', 'set'],
  ['解除中に解除', 'cancel', 'cancel'],
  ['設定中に解除', 'set', 'cancel'],
  ['解除中に設定', 'cancel', 'set'],
] as const)('%s：処理中の2回目の呼び出しは何もしない', async (_label, first, second) => {
  const app = loadApp();
  if (first === 'cancel') app.alarm.seedAlarm('A', jst('2026-11-29T06:00'));
  await app.open('/alarm');
  await app.screen.findByText(/次のアラーム|アラームは設定されていません/);
  const mock = app.alarm.alarmMock();
  const held = holdNext(
    first === 'set' ? mock.requestPermissionsAsync : mock.getScheduledAlarmsAsync,
  );
  const store = storeOf();
  const callsBefore = mock.getScheduledAlarmsAsync.mock.calls.length;

  let pending!: Promise<void>;
  await app.rntl.act(async () => {
    pending =
      first === 'set' ? store.getState().set(jst('2026-11-29T05:48')) : store.getState().cancel();
  });
  await app.rntl.act(async () => {
    await (second === 'set'
      ? store.getState().set(jst('2026-11-29T07:18'))
      : store.getState().cancel());
  });
  await app.rntl.act(async () => {
    held.resolve();
    await pending;
  });

  if (first === 'set') {
    expect(mock.scheduleAlarmAsync).toHaveBeenCalledTimes(1);
    expect(scheduledTimes(app)).toEqual([jst('2026-11-29T05:48')]);
    expect(mock.cancelAlarmAsync).not.toHaveBeenCalled();
  } else {
    expect(mock.scheduleAlarmAsync).not.toHaveBeenCalled();
    expect(mock.cancelAlarmAsync.mock.calls).toEqual([['A']]);
    // 解除の ID を集める予約の一覧の読み取りは1回だけ（2回目の解除・設定は始まらない）
    expect(mock.getScheduledAlarmsAsync.mock.calls.length - callsBefore).toBe(1);
  }
});

// T116
it('予定の読み取りが失敗すると「再試行」が出て、再試行で読み直す', async () => {
  const app = loadApp();
  const reads = app.alarm.alarmMock().getAlarmOccurrencesAsync;
  const original = reads.getMockImplementation()!;
  reads.mockRejectedValue(new Error('native failure'));

  await app.open('/alarm');

  expect(await app.screen.findByText('アラームの状態を読み込めませんでした')).toBeOnTheScreen();
  reads.mockImplementation(original);
  await app.rntl.fireEvent.press(button(app, '再試行'));
  expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();
});

// T117
it('推定の元データが読めなくても、標準値の候補と失敗の文言が出て、予約できる', async () => {
  const app = loadApp();
  mockTestDb.close();
  const { createElement } = require('react') as typeof import('react');
  const { SmartAlarmScreen } =
    require('@/features/smart-alarm/smart-alarm-screen') as typeof import('@/features/smart-alarm/smart-alarm-screen');
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  await render(createElement(SmartAlarmScreen));

  expect(await app.screen.findByText(STANDARD_PARAMS)).toBeOnTheScreen();
  expect(
    app.screen.getByText('睡眠の記録を読み込めなかったため、標準値を使っています'),
  ).toBeOnTheScreen();
  for (const name of [NOW_548, NOW_718, '8:48 6サイクル（9時間14分後）']) {
    expect(button(app, name)).toBeOnTheScreen();
  }
  await app.rntl.fireEvent.press(button(app, NOW_548));
  expect(await app.screen.findByText('5:48 にアラームを設定しました')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([jst('2026-11-29T05:48')]);
  mockTestDb.reopen();
});

// T118
it('画面を開いたまま睡眠が増えても再描画だけでは変わらず、前面に戻ると新しい値になる', async () => {
  const app = loadApp();
  await openAlarm(app);

  seedE(mockTestDb.sqlite);
  await advanceAndRerender(app, jst('2026-11-28T23:35'));
  // 描き直されたこと（就寝予定が今に追従した）を確かめたうえで、使う値の説明は前のまま
  expect(button(app, '就寝予定 23:35')).toBeOnTheScreen();
  expect(app.screen.getByText(STANDARD_PARAMS)).toBeOnTheScreen();

  await app.emit('background');
  await app.emit('active');
  expect(await app.screen.findByText(SEED_E_PARAMS)).toBeOnTheScreen();
});

// T119
it('画面を閉じて開き直すと、新しい値になる', async () => {
  const app = loadApp();
  await openAlarm(app);

  seedE(mockTestDb.sqlite);
  await app.rntl.act(async () =>
    (require('expo-router') as typeof import('expo-router')).router.back(),
  );
  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: /^アラーム/ }));

  expect(await app.screen.findByText(SEED_E_PARAMS)).toBeOnTheScreen();
});

// T120
it.each([
  ['ちょうど', '2026-11-29T05:48:00'],
  ['同じ分のうち', '2026-11-29T05:48:30'],
])('押した候補が今以前（%s）なら「その時刻は過ぎています」で予約しない', async (_label, nowAt) => {
  const app = loadApp();
  await openAlarm(app);

  jest.setSystemTime(jst(nowAt));
  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(await app.screen.findByText('その時刻は過ぎています')).toBeOnTheScreen();
  expect(scheduledTimes(app)).toEqual([]);
});

// T122
it.each([
  ['許可の要求が失敗する', 'アラームを設定できませんでした'],
  ['使えない端末', 'この端末ではアラームを使えません'],
] as const)('%sと「%s」が出て予約されない', async (label, message) => {
  const app = loadApp();
  if (label === '許可の要求が失敗する') {
    app.alarm
      .alarmMock()
      .requestPermissionsAsync.mockRejectedValueOnce(new Error('native failure'));
  } else {
    app.alarm.fakeAlarmState().permission.status = 'unavailable';
  }
  await openAlarm(app);

  await app.rntl.fireEvent.press(button(app, NOW_548));

  expect(await app.screen.findByText(message)).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: '設定を開く' })).toBeNull();
  expect(scheduledTimes(app)).toEqual([]);
});

// T123
it('前面復帰なしで今だけが進んで描き直されても、候補が新しい今で作り直される', async () => {
  const app = loadApp();
  await openAlarm(app);

  await advanceAndRerender(app, jst('2026-11-28T23:35'));

  expect(button(app, '就寝予定 23:35')).toBeOnTheScreen();
  expect(button(app, '5:49 4サイクル（6時間14分後）')).toBeOnTheScreen();
});

// T124
it.each([
  [
    '全画面表示の案内',
    { platform: 'android', canUseFullScreenIntent: false },
    'ロック中の画面にアラームを大きく出すには、設定で許可してください',
  ],
  ['許可の案内', { status: 'denied' }, 'アラームの許可がありません。設定で許可してください'],
] as const)('%sは、次の操作（設定して解除）で消える', async (_label, permission, guide) => {
  const app = loadApp();
  Object.assign(app.alarm.fakeAlarmState().permission, permission);
  await openAlarm(app);
  await app.rntl.fireEvent.press(button(app, NOW_548));
  expect(await app.screen.findByText(guide)).toBeOnTheScreen();

  Object.assign(app.alarm.fakeAlarmState().permission, app.alarm.DEFAULT_PERMISSION, {
    canUseFullScreenIntent: undefined,
  });
  await app.rntl.fireEvent.press(button(app, NOW_548));
  expect(await app.screen.findByText('5:48 にアラームを設定しました')).toBeOnTheScreen();
  await app.rntl.fireEvent.press(button(app, '解除'));

  expect(await app.screen.findByText('アラームを解除しました')).toBeOnTheScreen();
  expect(app.screen.queryByText(guide)).toBeNull();
  expect(app.screen.queryByRole('button', { name: '設定を開く' })).toBeNull();
});

// T125
it('設定中のアラームを読み込んでいる間は、その欄に何も出ず、候補は押せる', async () => {
  const app = loadApp();
  const reading = deferred<unknown[]>();
  app.alarm.alarmMock().getAlarmOccurrencesAsync.mockReturnValueOnce(reading.promise);

  await app.open('/alarm');

  expect(await app.screen.findByText(STANDARD_PARAMS)).toBeOnTheScreen();
  for (const text of [/次のアラーム/, NOT_SET, 'アラームの状態を読み込めませんでした']) {
    expect(app.screen.queryByText(text)).toBeNull();
  }
  expect(app.screen.queryByRole('button', { name: '解除' })).toBeNull();
  expect(button(app, NOW_548)).toBeEnabled();

  await app.rntl.act(async () => reading.resolve([]));
  expect(await app.screen.findByText(NOT_SET)).toBeOnTheScreen();
});
