// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { captureLogs } from '../../helpers/capture-logs';
import { deferred, flushPromises } from '../../helpers/deferred';
import { cleanupApp, loadApp, warmUpApp, type LoadedApp } from '../../helpers/load-app';
import { cIosSamples, seedC } from '../../helpers/seed-s';
import { createTestDb, type TestDb } from '../../helpers/test-db';
/* eslint-enable import/first */

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`Platform.OS`・`AppState`。
// victory-native・Skia は tests/setup/native-render-mocks.js で何も描かない部品に差し替え済み
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

// 変換のキャッシュが空でも最初のテストが時間切れにならないよう、先に一度読み込む
beforeAll(() => warmUpApp(), 120000);

const WEEK_TITLE = '11月23日（月）〜11月29日（日）';

/** シード C を DB に入れ、ネイティブの読み取りも同じ睡眠を返すようにする（起動時の同期で DB の行が消えない） */
function withSeedC(app: LoadedApp) {
  seedC(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(cIosSamples() as never);
}

/** 平均の3つの文字列が出ていることを確かめる */
async function expectAverage(app: LoadedApp, total: string, bed: string, wake: string) {
  expect(await app.screen.findByText(`平均 ${total}`)).toBeOnTheScreen();
  expect(app.screen.getByText(`就寝 ${bed}`)).toBeOnTheScreen();
  expect(app.screen.getByText(`起床 ${wake}`)).toBeOnTheScreen();
}

/**
 * 種類が `component` の部品が受け取った props（最初に見つかったもの）。
 * RNTL 14 は自作の部品を種類で選べない（`UNSAFE_getByType` がない）ため、描画されたネイティブの要素から
 * React の Fiber（`unstable_fiber`）を親へさかのぼって探す。入れ子の構造ではなく部品の種類で選ぶ
 */
function propsOf(app: LoadedApp, component: { name: string }): Record<string, unknown> {
  type Fiber = { type: unknown; memoizedProps: Record<string, unknown>; return: Fiber | null };
  for (const node of app.screen.container.queryAll(() => true)) {
    for (let f = node.unstable_fiber as Fiber | null; f; f = f.return) {
      if (f.type === component) return f.memoizedProps;
    }
  }
  // RNTL・React を上げて Fiber の作りが変わったときに、理由が分かるようにする
  throw new Error(
    `${component.name} が見つからない（描画されていないか、Fiber のたどり方が変わった）`,
  );
}

/** 日ごとのボタン */
const dayButtons = (app: LoadedApp) => app.screen.queryAllByTestId('sleep-record-chart-day');

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

// T028
it('一覧の「週・月の推移」を押すと /chart へ移り、今週の見出しと平均が出る', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByRole('button', { name: '週・月の推移' }));

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/chart');
  await expectAverage(app, '7時間21分', '23:07', '6:23');
  expect(app.screen.getByRole('button', { name: '週' })).toBeSelected();
});

/** グラフの画面のスクロールの部品の `RefreshControl`（引っ張り中かは `refreshing` で見る） */
const refreshControl = (app: LoadedApp) =>
  app.screen.getByTestId('sleep-record-chart-scroll').props.refreshControl?.props as
    { refreshing: boolean; onRefresh: () => Promise<void> } | undefined;
/** 下に引く（`onRefresh` を呼ぶ） */
const pull = async (app: LoadedApp) => {
  await app.rntl.act(async () => {
    void refreshControl(app)?.onRefresh();
    await flushPromises();
  });
};
/** 起動時の同期が終わるまで待つ */
const settle = (app: LoadedApp) =>
  app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));

/** 前提の睡眠1件（light だけ）を SQL で入れる */
function seedOne(id: string, start: string, end: string, wakeDate: string, minutes: number) {
  const at = (local: string) => new Date(`${local}:00+09:00`).getTime();
  mockTestDb.sqlite
    .prepare(
      'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, 1)',
    )
    .run(id, 'com.soxai', at(start), at(end), wakeDate, minutes);
  mockTestDb.sqlite
    .prepare(
      "INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, 'light', ?, ?)",
    )
    .run(id, at(start), at(end));
}

/** 日ごとのボタンの読み上げの説明と、押せるか */
const daysOf = (app: LoadedApp) =>
  dayButtons(app).map((b) => [b.props.accessibilityLabel, !b.props.accessibilityState?.disabled]);

// T029
it('日ごとのボタンが7つ並び、読み上げの説明が DB どおりで、睡眠のある過去の日だけ押せる', async () => {
  const app = loadApp();
  // 起動時の同期を走らせず DB の行を残す（今日より後の 11/27 の睡眠も DB に置く）
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedC(mockTestDb.sqlite);
  seedOne('future-27', '2026-11-26T23:00', '2026-11-27T06:00', '2026-11-27', 420);

  await app.open('/chart');

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(daysOf(app)).toEqual([
    ['11月23日（月） 睡眠データなし', false],
    ['11月24日（火） 睡眠 7時間0分 就寝 23:00 起床 6:00', true],
    ['11月25日（水） 睡眠 7時間42分 就寝 23:14 起床 6:46', true],
    ['11月26日（木） 睡眠データなし', false],
    ['11月27日（金） 睡眠データなし', false],
    ['11月28日（土） 睡眠データなし', false],
    ['11月29日（日） 睡眠データなし', false],
  ]);
  expect(dayButtons(app)[0]).toBeDisabled();
  expect(dayButtons(app)[2]).toBeEnabled();
});

// T030
it('睡眠のある日のボタンを押すと、その日の詳細へ移る', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);

  await app.rntl.fireEvent.press(
    app.screen.getByLabelText('11月25日（水） 睡眠 7時間42分 就寝 23:14 起床 6:46'),
  );

  expect(await app.screen.findByText('7時間12分')).toBeOnTheScreen();
  expect(app.screen.getByText('13:00〜13:30')).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/sleep/2026-11-25');
});

// T031
it('「月」で今月、「週」で今月の最初の日を含む週に替わる', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '月' }));

  expect(await app.screen.findByText('2026年11月')).toBeOnTheScreen();
  await expectAverage(app, '7時間14分', '23:35', '6:45');
  expect(dayButtons(app)).toHaveLength(30);
  expect(app.screen.getByRole('button', { name: '月' })).toBeSelected();
  expect(app.screen.getByRole('button', { name: '次の月' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '前の月' })).toBeEnabled();

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '週' }));

  expect(await app.screen.findByText('10月26日（月）〜11月1日（日）')).toBeOnTheScreen();
  await expectAverage(app, '7時間0分', '23:30', '6:30');
  expect(app.screen.getByRole('button', { name: '週' })).toBeSelected();
  expect(app.screen.getByRole('button', { name: '月' })).not.toBeSelected();
  expect(dayButtons(app)).toHaveLength(7);
});

// T032
it('「前の週」で前の週へ移り、最も古い睡眠の週で押せなくなる', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  expect(app.screen.getByRole('button', { name: '次の週' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '前の週' })).toBeEnabled();

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の週' }));

  expect(await app.screen.findByText('11月16日（月）〜11月22日（日）')).toBeOnTheScreen();
  await expectAverage(app, '7時間0分', '0:30', '7:30');
  expect(daysOf(app)).toEqual([
    ['11月16日（月） 睡眠データなし', false],
    ['11月17日（火） 睡眠 7時間0分 就寝 0:30 起床 7:30', true],
    ['11月18日（水） 睡眠データなし', false],
    ['11月19日（木） 睡眠データなし', false],
    ['11月20日（金） 睡眠データなし', false],
    ['11月21日（土） 睡眠データなし', false],
    ['11月22日（日） 睡眠データなし', false],
  ]);

  for (let i = 0; i < 3; i += 1) {
    await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の週' }));
  }

  expect(await app.screen.findByText('10月26日（月）〜11月1日（日）')).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: '前の週' })).toBeDisabled();

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '次の週' }));

  expect(await app.screen.findByText('11月2日（月）〜11月8日（日）')).toBeOnTheScreen();
});

// T033
it('「月」→「前の月」で最も古い睡眠の月へ移り、「前の月」が押せなくなる', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '月' }));
  await app.screen.findByText('2026年11月');

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の月' }));

  expect(await app.screen.findByText('2026年10月')).toBeOnTheScreen();
  await expectAverage(app, '7時間0分', '23:30', '6:30');
  expect(app.screen.getByRole('button', { name: '前の月' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '次の月' })).toBeEnabled();
  expect(dayButtons(app)).toHaveLength(31);
  expect(daysOf(app).filter(([, pressable]) => pressable)).toEqual([
    ['10月30日（金） 睡眠 7時間0分 就寝 23:30 起床 6:30', true],
  ]);
});

// T034
it('期間に睡眠がなければ「この期間の睡眠データはありません」が出て、平均と日ごとのボタンは出ない', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の週' }));
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の週' }));

  expect(await app.screen.findByText('11月9日（月）〜11月15日（日）')).toBeOnTheScreen();
  expect(app.screen.getByText('この期間の睡眠データはありません')).toBeOnTheScreen();
  expect(app.screen.queryByText(/^平均/)).toBeNull();
  expect(dayButtons(app)).toEqual([]);
});

// T035
it('DB が空なら今週・今月だけで、前へも後ろへも移れない', async () => {
  const app = loadApp();

  await app.open('/chart');

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(app.screen.getByText('この期間の睡眠データはありません')).toBeOnTheScreen();
  expect(dayButtons(app)).toEqual([]);
  expect(app.screen.getByRole('button', { name: '前の週' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '次の週' })).toBeDisabled();

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '月' }));

  expect(await app.screen.findByText('2026年11月')).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: '前の月' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '次の月' })).toBeDisabled();
});

// T049
it('期間に今日より後の睡眠しかなければ「この期間の睡眠データはありません」が出て、平均と日ごとのボタンは出ない', async () => {
  const app = loadApp();
  // 起動時の同期を走らせず DB の行を残す（DB には今日より後の 11/27 の睡眠だけ）
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedOne('future-27', '2026-11-26T23:00', '2026-11-27T06:00', '2026-11-27', 420);

  await app.open('/chart');

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(app.screen.getByText('この期間の睡眠データはありません')).toBeOnTheScreen();
  expect(app.screen.queryByText(/^平均/)).toBeNull();
  expect(dayButtons(app)).toEqual([]);
  expect(app.screen.getByRole('button', { name: '前の週' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '次の週' })).toBeDisabled();
});

// T051
it('描画の部品には切った棒・帯が日の順に渡り、読み上げと平均は切る前の値で出る', async () => {
  const app = loadApp();
  // 起動時の同期を走らせず DB の行を残す（今日より後の 11/27 の睡眠も DB に置く）
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedC(mockTestDb.sqlite);
  seedOne('long-23', '2026-11-22T17:00', '2026-11-23T06:00', '2026-11-23', 721);
  seedOne('future-27', '2026-11-26T23:00', '2026-11-27T06:00', '2026-11-27', 420);
  // loadApp で読み込み直したあとの部品（描画されるものと同じもの）
  const { SleepRecordChartCanvas } =
    require('@/features/sleep-record/sleep-record-chart-canvas') as typeof import('@/features/sleep-record/sleep-record-chart-canvas');

  await app.open('/chart');

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  const props = propsOf(app, SleepRecordChartCanvas);
  expect(props.bars).toEqual([720, 420, 462, null, null, null, null]);
  expect(props.bands).toEqual([
    { from: 0, to: 720 },
    { from: 300, to: 720 },
    { from: 314, to: 766 },
    null,
    null,
    null,
    null,
  ]);
  expect(dayButtons(app)[0].props.accessibilityLabel).toBe(
    '11月23日（月） 睡眠 12時間1分 就寝 17:00 起床 6:00',
  );
  await expectAverage(app, '8時間54分', '21:05', '6:15');
});

// T054
it('開いたまま日付が変わり background → active になると、新しい今日で描き直す（inactive → active では描き直さない）', async () => {
  const app = loadApp();
  // 起動時の同期を走らせず DB の行を残す（今日より後の 11/27 の睡眠も DB に置く）
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedC(mockTestDb.sqlite);
  seedOne('future-27', '2026-11-26T23:00', '2026-11-27T06:00', '2026-11-27', 420);
  const day27 = () => dayButtons(app)[4];
  const BEFORE = '11月27日（金） 睡眠データなし';
  const AFTER = '11月27日（金） 睡眠 7時間0分 就寝 23:00 起床 6:00';

  await app.open('/chart');
  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(day27().props.accessibilityLabel).toBe(BEFORE);
  expect(day27()).toBeDisabled();
  await expectAverage(app, '7時間21分', '23:07', '6:23');

  jest.setSystemTime(new Date('2026-11-27T12:00:00+09:00'));
  // 01 と同じく inactive → active は前面復帰として扱わない
  await app.emit('inactive');
  await app.emit('active');

  expect(day27().props.accessibilityLabel).toBe(BEFORE);
  expect(day27()).toBeDisabled();
  await expectAverage(app, '7時間21分', '23:07', '6:23');

  // 01 の前面復帰の同期が store を更新してついでに描き直さないよう、2回目からの連携状態の取得は保留にする
  const status = deferred<number>();
  app.hk.getRequestStatusForAuthorization.mockReturnValue(status.promise as never);
  await app.emit('background');
  await app.emit('active');

  await app.rntl.waitFor(() => expect(day27().props.accessibilityLabel).toBe(AFTER));
  expect(day27()).toBeEnabled();
  await expectAverage(app, '7時間14分', '23:05', '6:15');
  status.resolve(1);
});

// T036
it('下に引くと同期が走って引っ張り中の表示が止まり、睡眠が変われば表示も替わる', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  await settle(app);
  app.hk.queryCategorySamples.mockResolvedValue(cIosSamples(['s-main-24']) as never);

  await pull(app);

  await app.rntl.waitFor(() => expect(refreshControl(app)?.refreshing).toBe(false));
  expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(2);
  await expectAverage(app, '7時間42分', '23:14', '6:46');
  expect(app.screen.getByLabelText('11月24日（火） 睡眠データなし')).toBeDisabled();
});

// T037
it('下に引いたときの同期が失敗しても引っ張り中の表示が止まり、エラーは出ず表示はそのまま', async () => {
  const app = loadApp();
  withSeedC(app);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  await settle(app);
  app.hk.queryCategorySamples.mockRejectedValueOnce(new Error('read failed'));

  await pull(app);

  await app.rntl.waitFor(() => expect(refreshControl(app)?.refreshing).toBe(false));
  expect(app.screen.queryByText('睡眠データの取り込みに失敗しました')).toBeNull();
  expect(app.screen.getByText(WEEK_TITLE)).toBeOnTheScreen();
  await expectAverage(app, '7時間21分', '23:07', '6:23');
});

// T038
it('ready 以外で下に引くと、同期せず連携状態の取得だけをして引っ張り中の表示が止まり、案内は出ない', async () => {
  const app = loadApp();
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedC(mockTestDb.sqlite);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  await app.rntl.waitFor(() => expect(app.store.getState().accessStatus).toBe('notRequested'));
  const statusCalls = app.hk.getRequestStatusForAuthorization.mock.calls.length;

  await pull(app);

  await app.rntl.waitFor(() => expect(refreshControl(app)?.refreshing).toBe(false));
  expect(app.hk.queryCategorySamples).not.toHaveBeenCalled();
  expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(statusCalls + 1);
  expect(app.screen.queryByText('ヘルスケアと連携する')).toBeNull();
  await expectAverage(app, '7時間21分', '23:07', '6:23');
});

// T039
it('同期で古い睡眠が消えて表示中の期間が範囲の外になったら、範囲の端の期間が出る', async () => {
  const app = loadApp();
  // 起動時は notRequested（同期が走らず同期記録もできない）。下に引くときは ready で、初回の90日の範囲で入れ替わる
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  seedC(mockTestDb.sqlite);
  await app.open('/chart');
  await app.screen.findByText(WEEK_TITLE);
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '前の週' }));
  await app.screen.findByText('11月16日（月）〜11月22日（日）');
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(2 as never); // unnecessary
  app.hk.queryCategorySamples.mockResolvedValue(cIosSamples(['c-main-17', 'c-main-1030']) as never);

  await pull(app);

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  expect(app.screen.getByRole('button', { name: '前の週' })).toBeDisabled();
  expect(app.screen.getByRole('button', { name: '次の週' })).toBeDisabled();
});

// T040
it('DB の読み取りが失敗したら読み込めない表示と error ログが出て、下に引けず、閉じたままの再試行では出ず、開き直して再試行すると出る', async () => {
  const app = loadApp();
  seedC(mockTestDb.sqlite);
  const { named } = captureLogs();
  mockTestDb.close();
  // renderRouter を通さず、グラフの画面の部品を直接描画する（MigrationGate・同期の Provider を通さない）
  const { createElement } = require('react') as typeof import('react');
  const { SleepRecordChartScreen } =
    require('@/features/sleep-record/sleep-record-chart-screen') as typeof import('@/features/sleep-record/sleep-record-chart-screen');
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  await render(createElement(SleepRecordChartScreen));

  expect(await app.screen.findByText('睡眠データを読み込めませんでした')).toBeOnTheScreen();
  expect(named('sleepRecord.loadList').map((l) => l.level)).toEqual(['error']);
  expect(app.screen.queryByTestId('sleep-record-chart-scroll')).toBeNull();

  // DB を閉じたまま再試行すると、もう一度失敗して同じ表示のまま
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  await app.rntl.waitFor(() =>
    expect(named('sleepRecord.loadList').map((l) => l.level)).toEqual(['error', 'error']),
  );
  expect(app.screen.getByText('睡眠データを読み込めませんでした')).toBeOnTheScreen();
  expect(app.screen.queryByTestId('sleep-record-chart-scroll')).toBeNull();

  mockTestDb.reopen();
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  await expectAverage(app, '7時間21分', '23:07', '6:23');
  expect(refreshControl(app)?.refreshing).toBe(false);
});

// T041
it.each([
  ['iOS で連携状態の取得が失敗（checkFailed）', 'ios'],
  ['Android で notGranted', 'android'],
] as const)('%s でも、グラフの画面に案内は出ない', async (_label, os) => {
  const app = loadApp(os);
  if (os === 'ios') {
    app.hk.getRequestStatusForAuthorization.mockRejectedValue(new Error('status failed'));
  } else {
    app.hc.getGrantedPermissions.mockResolvedValue([]);
  }
  seedC(mockTestDb.sqlite);

  await app.open('/chart');

  expect(await app.screen.findByText(WEEK_TITLE)).toBeOnTheScreen();
  await expectAverage(app, '7時間21分', '23:07', '6:23');
  await app.rntl.waitFor(() =>
    expect(app.store.getState().accessStatus).toBe(os === 'ios' ? 'checkFailed' : 'notGranted'),
  );
  for (const text of [
    'ヘルスケアの状態を確認できませんでした',
    '再試行',
    'ヘルスコネクトと連携する',
    '設定を開く',
  ]) {
    expect(app.screen.queryByText(text)).toBeNull();
  }
});
