// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { deferred } from '../../helpers/deferred';
import { cleanupApp, loadApp, warmUpApp } from '../../helpers/load-app';
import { createTestDb, type TestDb } from '../../helpers/test-db';
/* eslint-enable import/first */

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）。
// アラームのライブラリは tests/setup/native-alarm-mocks.js が差し替える
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

/** JST の日時（`2026-11-29T05:48` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(jst('2026-11-28T23:34'));
  mockTestDb = createTestDb();
});

afterEach(async () => {
  await cleanupApp();
  jest.useRealTimers();
  mockTestDb.destroy();
});

// T093
it('予約がなければ「アラーム 未設定」で、押すと /alarm へ移る', async () => {
  const app = loadApp();
  await app.open();

  const entry = await app.screen.findByRole('button', { name: 'アラーム 未設定' });
  await app.rntl.fireEvent.press(entry);

  expect(app.screen).toHavePathname('/alarm');
});

// T153
it('入口を続けて2回押しても、アラームの画面は1枚だけ', async () => {
  const app = loadApp();
  await app.open();
  const entry = await app.screen.findByRole('button', { name: 'アラーム 未設定' });

  await app.rntl.fireEvent.press(entry);
  await app.rntl.fireEvent.press(entry);
  expect(app.screen).toHavePathname('/alarm');

  await app.rntl.act(async () =>
    (require('expo-router') as typeof import('expo-router')).router.back(),
  );
  expect(app.screen).toHavePathname('/');
});

// T094
it.each([
  ['primary', 'アラーム 11月29日（日） 5:48'],
  ['deferred', 'アラーム 11月29日（日） 7:09（スヌーズ）'],
] as const)('予定（%s）があれば時刻の入口が出る', async (relationship, label) => {
  const app = loadApp();
  app.alarm.fakeAlarmState().occurrences.push({
    occurrenceId: 'A',
    alarmId: 'A',
    scheduledFor: jst(relationship === 'primary' ? '2026-11-29T05:48' : '2026-11-29T07:09'),
    relationship,
    phase: 'scheduled',
  });

  await app.open();

  expect(await app.screen.findByRole('button', { name: label })).toBeOnTheScreen();
});

// T095
it('予定の読み取りが終わるまでは「アラーム」だけで、終わると「アラーム 未設定」', async () => {
  const app = loadApp();
  const reading = deferred<unknown[]>();
  app.alarm.alarmMock().getAlarmOccurrencesAsync.mockReturnValueOnce(reading.promise);

  await app.open();

  expect(await app.screen.findByRole('button', { name: 'アラーム' })).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: 'アラーム 未設定' })).toBeNull();

  await app.rntl.act(async () => reading.resolve([]));

  expect(await app.screen.findByRole('button', { name: 'アラーム 未設定' })).toBeOnTheScreen();
});

// T096
it('予定の読み取りが失敗したら「アラーム」だけ（「未設定」にならない）', async () => {
  const app = loadApp();
  app.alarm.alarmMock().getAlarmOccurrencesAsync.mockRejectedValue(new Error('native failure'));
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await app.open();

  expect(await app.screen.findByRole('button', { name: 'アラーム' })).toBeOnTheScreen();
  await app.rntl.waitFor(() =>
    expect(app.alarm.alarmMock().getAlarmOccurrencesAsync).toHaveBeenCalled(),
  );
  expect(app.screen.queryByRole('button', { name: 'アラーム 未設定' })).toBeNull();
});
