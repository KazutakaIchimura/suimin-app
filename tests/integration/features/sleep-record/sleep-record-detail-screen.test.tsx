// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { captureLogs } from '../../helpers/capture-logs';
import { deferred, flushPromises } from '../../helpers/deferred';
import { cleanupApp, loadApp, warmUpApp, type LoadedApp } from '../../helpers/load-app';
import { seedS, sIosSamples } from '../../helpers/seed-s';
import { createTestDb, type TestDb } from '../../helpers/test-db';
/* eslint-enable import/first */

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`Platform.OS`・`AppState`
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

// 各テストで expo-router ごと読み込み直すため、1件にかかる時間の上限を既定（5秒）より上げる
jest.setTimeout(15000);

// 変換のキャッシュが空でも最初のテストが時間切れにならないよう、先に一度読み込む（変換の時間はテストの持ち時間に入れない）
beforeAll(() => warmUpApp(), 120000);

const MIN = 60 * 1000;
/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

/** 前提の睡眠1件を SQL で入れる。ステージ区間は就寝から隙間なく続ける（長さはミリ秒） */
function seedSession(
  id: string,
  start: string,
  wakeDate: string,
  asleepMinutes: number,
  hasStages: boolean,
  stages: [string, number][],
) {
  let at = jst(start);
  const list = stages.map(([stage, ms]) => {
    const interval = { stage, startAt: at, endAt: at + ms };
    at = interval.endAt;
    return interval;
  });
  mockTestDb.sqlite
    .prepare(
      'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'com.soxai', jst(start), at, wakeDate, asleepMinutes, hasStages ? 1 : 0);
  const insert = mockTestDb.sqlite.prepare(
    'INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, ?, ?, ?)',
  );
  for (const s of list) insert.run(id, s.stage, s.startAt, s.endAt);
}

/** 起動時の同期で DB を変えないよう、ネイティブの読み取りは DB と同じ睡眠を返す（シード S のとき） */
function openWithS(app: LoadedApp, url = '/sleep/2026-11-25') {
  seedS(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  return app.open(url);
}

/** 「S の詳細」の主睡眠と昼寝が出ていることを確かめる */
async function expectSDetail(app: LoadedApp) {
  expect(await app.screen.findByText('23:14〜6:46')).toBeOnTheScreen();
  expect(app.screen.getByText('7時間12分')).toBeOnTheScreen();
  expect(app.screen.getByText('13:00〜13:30')).toBeOnTheScreen();
  expect(app.screen.getByText('30分')).toBeOnTheScreen();
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-11-25T12:00:00+09:00'));
  mockTestDb = createTestDb();
  // 共通ログの出力は、見るテストだけで受け取る（ほかは出力先の console だけ黙らせる）
  for (const level of ['info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(async () => {
  await cleanupApp();
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockTestDb.destroy();
});

// T168
it('シード S の 2026-11-25 を開くと、主睡眠・深い〜覚醒の順の内訳・昼寝が出て、不明の行はない', async () => {
  const app = loadApp();

  await openWithS(app);

  await expectSDetail(app);
  const rows = app.screen.getAllByTestId('sleep-record-breakdown-row');
  expect(rows.map((row) => app.rntl.within(row).getByText(/%$/).props.children)).toEqual([
    '深い 1時間30分 20%',
    '浅い 4時間40分 62%',
    'REM 1時間2分 14%',
    '覚醒 20分 4%',
  ]);
  expect(app.screen.queryByText(/^不明/)).toBeNull();
});

// T169
it('ステージなしの主睡眠は「ステージ情報なし」が出て、内訳の行は出ない', async () => {
  const app = loadApp();
  seedSession('plain', '2026-11-24T23:00', '2026-11-25', 420, false, [['unspecified', 420 * MIN]]);

  await app.open('/sleep/2026-11-25');

  expect(await app.screen.findByText('23:00〜6:00')).toBeOnTheScreen();
  expect(app.screen.getByText('7時間0分')).toBeOnTheScreen();
  expect(app.screen.getByText('ステージ情報なし')).toBeOnTheScreen();
  expect(app.screen.queryAllByTestId('sleep-record-breakdown-row')).toEqual([]);
});

// T192
it('ステージありでも出す行がなければ「ステージ情報なし」が出て、内訳の行は出ない', async () => {
  const app = loadApp();
  seedSession('tiny', '2026-11-24T23:00', '2026-11-25', 1, true, [
    ['light', 59 * 1000],
    ['deep', 59 * 1000],
  ]);

  await app.open('/sleep/2026-11-25');

  expect(await app.screen.findByText('ステージ情報なし')).toBeOnTheScreen();
  expect(app.screen.queryAllByTestId('sleep-record-breakdown-row')).toEqual([]);
});

// T170
it('睡眠のない日を開くと「この日の睡眠データはありません」が出る', async () => {
  const app = loadApp();

  await app.open('/sleep/2026-11-25');

  expect(await app.screen.findByText('この日の睡眠データはありません')).toBeOnTheScreen();
});

// T171
it.each(['2026-02-30', 'abc'])(
  '/sleep/%s を開くと「日付が正しくありません」が出る',
  async (date) => {
    const app = loadApp();

    await app.open(`/sleep/${date}`);

    expect(await app.screen.findByText('日付が正しくありません')).toBeOnTheScreen();
  },
);

// T172
it('詳細の読み取りが失敗したら読み込めない表示と日付なしの error ログが出て、DB を開き直して再試行すると S の詳細が出る', async () => {
  const app = loadApp();
  seedS(mockTestDb.sqlite);
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  await app.store.getState().refreshAccess();
  const { named } = captureLogs();
  mockTestDb.close();
  // renderRouter を通さず、詳細画面のコンポーネントを直接描画する（MigrationGate・同期の Provider を通さない）
  const { createElement } = require('react') as typeof import('react');
  const { SleepRecordDetailScreen } =
    require('@/features/sleep-record/sleep-record-detail-screen') as typeof import('@/features/sleep-record/sleep-record-detail-screen');
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  await render(createElement(SleepRecordDetailScreen, { date: '2026-11-25' }));

  expect(await app.screen.findByText('睡眠データを読み込めませんでした')).toBeOnTheScreen();
  const lines = named('sleepRecord.loadDetail');
  expect(lines.map((l) => l.level)).toEqual(['error']);
  expect(lines[0].line).not.toContain('2026-11-25');

  mockTestDb.reopen();
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  await expectSDetail(app);
});

// T173
it('起動の URL が詳細でも、連携状態の取得と読み取りがそれぞれ1回走る', async () => {
  const app = loadApp();

  await app.open('/sleep/2026-11-25');

  await app.rntl.waitFor(() => expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(1));
  await app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));
  expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(1);
});

// T185
it('詳細の表示中に同期が終わってその日の睡眠が消えたら、「この日の睡眠データはありません」に変わる', async () => {
  const app = loadApp();
  seedS(mockTestDb.sqlite);
  const reading = deferred<unknown[]>();
  app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);
  await app.open('/sleep/2026-11-25');
  expect(await app.screen.findByText('23:14〜6:46')).toBeOnTheScreen();

  await app.rntl.act(async () => {
    // 2026-11-24 の睡眠だけを返す
    reading.resolve(sIosSamples().filter((s) => s.uuid.startsWith('s-main-24-')));
    await flushPromises();
  });

  expect(await app.screen.findByText('この日の睡眠データはありません')).toBeOnTheScreen();
});

// T174
it('詳細の表示中に同期が終わって起床が 7:10 に変わったら、表示が「23:14〜7:10」に変わる', async () => {
  const app = loadApp();
  seedS(mockTestDb.sqlite);
  const reading = deferred<unknown[]>();
  app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);
  await app.open('/sleep/2026-11-25');
  expect(await app.screen.findByText('23:14〜6:46')).toBeOnTheScreen();

  // 同じ睡眠の最後の覚醒を 7:10 までにする（睡眠時間は変わらない）
  const samples = sIosSamples().map((s) =>
    s.uuid === 's-main-25-3' ? { ...s, endDate: new Date(jst('2026-11-25T07:10')) } : s,
  );
  await app.rntl.act(async () => {
    reading.resolve(samples);
    await flushPromises();
  });

  expect(await app.screen.findByText('23:14〜7:10')).toBeOnTheScreen();
  expect(app.screen.queryByText('23:14〜6:46')).toBeNull();
});

// T175
it('ready で DB にシード S があれば、待ったあとは S の詳細が出て、読み込み中・データなしは出ていない', async () => {
  const app = loadApp();

  await openWithS(app);

  await expectSDetail(app);
  expect(app.screen.queryByText('読み込み中')).toBeNull();
  expect(app.screen.queryByText('この日の睡眠データはありません')).toBeNull();
});
