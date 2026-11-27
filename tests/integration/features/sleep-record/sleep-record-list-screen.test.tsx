// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { deferred, flushPromises } from '../../helpers/deferred';
import { sAndroidPage, seedS, sIosSamples } from '../../helpers/seed-s';
import { captureLogs } from '../../helpers/capture-logs';
import { cleanupApp, loadApp, warmUpApp, type LoadedApp } from '../../helpers/load-app';
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
// T149 だけ、適用できない壊れた SQL のマイグレーションに差し替える（DB への入力データ。ほかのテストでは本物）
let mockMigrations: unknown;
jest.mock('@/drizzle/migrations', () => ({
  __esModule: true,
  get default() {
    return mockMigrations;
  },
}));

// 各テストで expo-router ごと読み込み直すため、1件にかかる時間の上限を既定（5秒）より上げる
jest.setTimeout(15000);

// 変換のキャッシュが空でも最初のテストが時間切れにならないよう、先に一度読み込む（変換の時間はテストの持ち時間に入れない）
beforeAll(() => warmUpApp(), 120000);

const load = loadApp;

/** 「S の一覧」が行の順も含めて出ていることを確かめる */
async function expectSList(app: LoadedApp) {
  const { rntl } = app;
  const rows = await app.screen.findAllByTestId('sleep-record-row');
  expect(rows).toHaveLength(2);
  const first = rntl.within(rows[0]);
  for (const text of ['11月25日（水）', '7時間42分', '23:14〜6:46', '昼寝 1件']) {
    expect(first.getByText(text)).toBeOnTheScreen();
  }
  const second = rntl.within(rows[1]);
  for (const text of ['11月24日（火）', '7時間0分', '23:00〜6:00']) {
    expect(second.getByText(text)).toBeOnTheScreen();
  }
  expect(second.queryByText(/昼寝/)).toBeNull();
}

const realMigrations = jest.requireActual('@/drizzle/migrations').default as {
  journal: { entries: { when: number }[] };
};

/**
 * 詳細 `/sleep/2026-11-25` に移り、「S の詳細」が出ていることを確かめる
 * （一覧はスタックの後ろに残り「23:14〜6:46」も出ているため、詳細だけに出る文字で見る）
 */
async function expectSDetailOpened(app: LoadedApp) {
  expect(await app.screen.findByText('7時間12分')).toBeOnTheScreen();
  expect(app.screen.getByText('13:00〜13:30')).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/sleep/2026-11-25');
}

beforeEach(() => {
  mockMigrations = realMigrations;
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

// T147
it('ready で DB にシード S があれば、S の一覧が新しい日から順に出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);

  await app.open();

  await expectSList(app);
});

// T148
it('1行目をタップすると、詳細の URL が /sleep/2026-11-25 になり S の詳細が出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  await app.open();
  await expectSList(app);

  await app.rntl.fireEvent.press(app.screen.getAllByTestId('sleep-record-row')[0]);

  await expectSDetailOpened(app);
});

// T149
it('マイグレーションが失敗したら失敗の表示が出て、連携状態の取得も読み取りも始まらない', async () => {
  const app = load();
  const lastWhen = Math.max(...realMigrations.journal.entries.map((e) => e.when));
  mockMigrations = {
    journal: { entries: [{ idx: 0, when: lastWhen + 1, tag: '0001_broken', breakpoints: true }] },
    migrations: { m0000: 'CREATE TABL broken (a);' },
  };

  await app.open();

  expect(await app.screen.findByText('データベースの準備に失敗しました')).toBeOnTheScreen();
  expect(app.hk.isHealthDataAvailable).not.toHaveBeenCalled();
  expect(app.hk.getRequestStatusForAuthorization).not.toHaveBeenCalled();
  expect(app.hk.queryCategorySamples).not.toHaveBeenCalled();
});

// T150
it('iOS の notRequested で「ヘルスケアと連携する」を押すと、許可を求めて同期し、S の一覧が出る', async () => {
  const app = load('ios');
  app.hk.getRequestStatusForAuthorization.mockResolvedValueOnce(1 as never); // shouldRequest
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('ヘルスケアと連携する'));

  await expectSList(app);
  expect(app.hk.requestAuthorization).toHaveBeenCalledTimes(1);
});

// T150
it('Android の notGranted で「ヘルスコネクトと連携する」を押すと、許可を求めて同期し、S の一覧が出る', async () => {
  const app = load('android');
  app.hc.getGrantedPermissions.mockResolvedValueOnce([]);
  app.hc.readRecords.mockResolvedValue(sAndroidPage() as never);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('ヘルスコネクトと連携する'));

  await expectSList(app);
  expect(app.hc.requestPermission).toHaveBeenCalledTimes(1);
});

// T151（02 の T043 で直した）
it.each([
  ['ios', 'unavailable', ['この端末ではヘルスケア連携を使えません'], []],
  ['android', 'unavailable', ['この端末ではヘルスケア連携を使えません'], []],
  ['android', 'updateRequired', ['ヘルスコネクトを更新してください'], []],
  [
    'android',
    'notGranted',
    ['許可しなかった場合は、ヘルスコネクトの設定から許可してください'],
    ['ヘルスコネクトと連携する', '設定を開く'],
  ],
] as const)(
  '%s の %s では、3.1 の表どおりの案内文とボタンが出る',
  async (os, status, texts, buttons) => {
    const app = load(os);
    if (os === 'ios') app.hk.isHealthDataAvailable.mockReturnValue(false);
    else if (status === 'unavailable') app.hc.getSdkStatus.mockResolvedValue(1);
    else if (status === 'updateRequired') app.hc.getSdkStatus.mockResolvedValue(2);
    else app.hc.getGrantedPermissions.mockResolvedValue([]);

    await app.open();

    for (const text of texts) expect(await app.screen.findByText(text)).toBeOnTheScreen();
    // どの状態でも一覧を表示しているので、02 で足した「週・月の推移」ボタンも出る（02 の T043）
    const chartEntry = app.screen.getByRole('button', { name: '週・月の推移' });
    // ボタンは表のものだけ（数と名前が一致）。「週・月の推移」ボタンは数えない
    const guideButtons = app.screen.queryAllByRole('button').filter((b) => b !== chartEntry);
    expect(guideButtons).toHaveLength(buttons.length);
    for (const name of buttons) expect(app.screen.getByRole('button', { name })).toBeOnTheScreen();
    expect(app.screen.queryByText(/睡眠データがありません/)).toBeNull();
  },
);

// T152
it('Android で要求のあとも notGranted なら、案内はそのままで読み取らない', async () => {
  const app = load('android');
  app.hc.getGrantedPermissions.mockResolvedValue([]);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('ヘルスコネクトと連携する'));
  await app.rntl.waitFor(() => expect(app.hc.getGrantedPermissions).toHaveBeenCalledTimes(2));

  expect(
    app.screen.getByText('許可しなかった場合は、ヘルスコネクトの設定から許可してください'),
  ).toBeOnTheScreen();
  expect(app.hc.readRecords).not.toHaveBeenCalled();
});

// T153
it('Android の notGranted で「設定を開く」を押すと、ヘルスコネクトの設定を1回開く', async () => {
  const app = load('android');
  app.hc.getGrantedPermissions.mockResolvedValue([]);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('設定を開く'));

  await app.rntl.waitFor(() => expect(app.hc.openHealthConnectSettings).toHaveBeenCalledTimes(1));
});

const OPEN_SETTINGS_FAILED =
  'ヘルスコネクトの設定を開けませんでした。設定アプリからヘルスコネクトを開いてください';

// T154
it('設定を開くのが失敗したら失敗の表示が出て、もう一度押すと（保留中のうちに）消える', async () => {
  const app = load('android');
  app.hc.getGrantedPermissions.mockResolvedValue([]);
  const second = deferred<void>();
  app.hc.openHealthConnectSettings
    .mockImplementationOnce(() => {
      throw new Error('open failed');
    })
    .mockImplementationOnce(() => second.promise as never);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('設定を開く'));
  expect(await app.screen.findByText(OPEN_SETTINGS_FAILED)).toBeOnTheScreen();

  await app.rntl.fireEvent.press(app.screen.getByText('設定を開く'));
  await app.rntl.waitFor(() => expect(app.screen.queryByText(OPEN_SETTINGS_FAILED)).toBeNull());
  expect(app.hc.openHealthConnectSettings).toHaveBeenCalledTimes(2);
  second.resolve();
});

// T155
it('iOS で許可の要求が失敗したら「連携の要求に失敗しました」が出て、ボタンは押せ、連携状態は取り直さない', async () => {
  const app = load('ios');
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  app.hk.requestAuthorization.mockRejectedValueOnce(new Error('request failed'));
  await app.open();
  const button = await app.screen.findByRole('button', { name: 'ヘルスケアと連携する' });
  const statusCalls = app.hk.getRequestStatusForAuthorization.mock.calls.length;

  await app.rntl.fireEvent.press(button);

  expect(await app.screen.findByText('連携の要求に失敗しました')).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: 'ヘルスケアと連携する' })).toBeEnabled();
  expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(statusCalls);
});

// T156
it('許可の要求が失敗したあともう一度押すと、要求し直し、保留中のうちに失敗の表示が消える', async () => {
  const app = load('ios');
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  const second = deferred<boolean>();
  app.hk.requestAuthorization
    .mockRejectedValueOnce(new Error('request failed'))
    .mockReturnValueOnce(second.promise);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('ヘルスケアと連携する'));
  expect(await app.screen.findByText('連携の要求に失敗しました')).toBeOnTheScreen();

  await app.rntl.fireEvent.press(app.screen.getByText('ヘルスケアと連携する'));
  await app.rntl.waitFor(() =>
    expect(app.screen.queryByText('連携の要求に失敗しました')).toBeNull(),
  );
  expect(app.hk.requestAuthorization).toHaveBeenCalledTimes(2);
  second.resolve(true);
});

// T157
it('許可の要求中はボタンを押せず、もう一度押しても要求は1回だけ', async () => {
  const app = load('ios');
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  const pending = deferred<boolean>();
  app.hk.requestAuthorization.mockReturnValueOnce(pending.promise);
  await app.open();

  await app.rntl.fireEvent.press(await app.screen.findByText('ヘルスケアと連携する'));
  const button = await app.screen.findByRole('button', { name: 'ヘルスケアと連携する' });
  await app.rntl.waitFor(() => expect(button).toBeDisabled());
  await app.rntl.fireEvent.press(button);

  expect(app.hk.requestAuthorization).toHaveBeenCalledTimes(1);
  pending.resolve(true);
});

// T158
it('iOS で連携状態の取得が失敗したら「再試行」が出て、押すと取り直し「ヘルスケアと連携する」に替わる', async () => {
  const app = load('ios');
  app.hk.getRequestStatusForAuthorization
    .mockRejectedValueOnce(new Error('status failed'))
    .mockResolvedValueOnce(1 as never); // shouldRequest
  await app.open();

  expect(await app.screen.findByText('ヘルスケアの状態を確認できませんでした')).toBeOnTheScreen();
  await app.rntl.fireEvent.press(app.screen.getByText('再試行'));

  expect(await app.screen.findByText('ヘルスケアと連携する')).toBeOnTheScreen();
  expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2);
  expect(app.screen.queryByText('ヘルスケアの状態を確認できませんでした')).toBeNull();
});

/**
 * 一覧の `RefreshControl`（引っ張り中かは `refreshing` で見る）。
 * jest の RefreshControl の差し替えは testID を描画に残さないため、一覧（FlatList）の props から取る
 */
const refreshControl = (app: LoadedApp) =>
  app.screen.getByTestId('sleep-record-list').props.refreshControl.props as {
    refreshing: boolean;
    onRefresh: () => Promise<void>;
  };
/** 下に引く（`RefreshControl` の `onRefresh` を呼ぶ） */
const pull = async (app: LoadedApp) => {
  await app.rntl.act(async () => {
    void refreshControl(app).onRefresh();
    await flushPromises();
  });
};

// T159
it.each(['成功', '失敗'] as const)(
  'ready で下に引くと同期が走り、引っ張り中の表示は同期が%sで終わると止まる',
  async (outcome) => {
    const app = load();
    seedS(mockTestDb.sqlite);
    app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
    await app.open();
    await expectSList(app);
    await app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));
    const reading = deferred<unknown[]>();
    app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);

    await pull(app);

    await app.rntl.waitFor(() => expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(2));
    expect(refreshControl(app).refreshing).toBe(true);
    await app.rntl.act(async () => {
      if (outcome === '成功') reading.resolve(sIosSamples());
      else reading.reject(new Error('read failed'));
      await flushPromises();
    });
    await app.rntl.waitFor(() => expect(refreshControl(app).refreshing).toBe(false));
  },
);

// T160
it('notRequested で下に引くと、連携状態の取得だけをして読み取らず、引っ張り中の表示が止まる', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  await app.open();
  await expectSList(app);

  await pull(app);

  await app.rntl.waitFor(() =>
    expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2),
  );
  await app.rntl.waitFor(() => expect(refreshControl(app).refreshing).toBe(false));
  expect(app.hk.queryCategorySamples).not.toHaveBeenCalled();
});

// T194
it('ready で下に引いたとき連携状態の取得が失敗したら、読み取らず、再試行の案内と一覧が出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  await app.open();
  await expectSList(app);
  await app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));
  app.hk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('status failed'));

  await pull(app);

  expect(await app.screen.findByText('ヘルスケアの状態を確認できませんでした')).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: '再試行' })).toBeOnTheScreen();
  await app.rntl.waitFor(() => expect(refreshControl(app).refreshing).toBe(false));
  expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  await expectSList(app);
});

// T161
it('同期に失敗したら失敗の表示と一覧が出て、再試行の保留中は同期中の表示だけになり、成功すると失敗の表示は出ない', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  const retry = deferred<unknown[]>();
  app.hk.queryCategorySamples
    .mockRejectedValueOnce(new Error('read failed'))
    .mockReturnValueOnce(retry.promise as never);
  await app.open();

  expect(await app.screen.findByText('睡眠データの取り込みに失敗しました')).toBeOnTheScreen();
  await expectSList(app);

  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  expect(await app.screen.findByTestId('sleep-record-syncing')).toBeOnTheScreen();
  expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(2);
  expect(app.screen.queryByText('睡眠データの取り込みに失敗しました')).toBeNull();
  await app.rntl.act(async () => {
    retry.resolve(sIosSamples());
    await flushPromises();
  });
  await app.rntl.waitFor(() => expect(app.screen.queryByTestId('sleep-record-syncing')).toBeNull());
  expect(app.screen.queryByText('睡眠データの取り込みに失敗しました')).toBeNull();
  await expectSList(app);
});

// T162
it('一覧の読み取りが失敗したら読み込めない表示と error ログが出て、DB を開き直して再試行すると S の一覧が出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  await app.store.getState().refreshAccess();
  const { named } = captureLogs();
  mockTestDb.close();
  // renderRouter を通さず、一覧画面のコンポーネントを直接描画する（MigrationGate・同期の Provider を通さない）
  const { createElement } = require('react') as typeof import('react');
  const { SleepRecordListScreen } =
    require('@/features/sleep-record/sleep-record-list-screen') as typeof import('@/features/sleep-record/sleep-record-list-screen');

  // expo-router/testing-library が読み込んだのと同じ RNTL（型定義に render がないため直接読む）
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');
  await render(createElement(SleepRecordListScreen));

  expect(await app.screen.findByText('睡眠データを読み込めませんでした')).toBeOnTheScreen();
  expect(named('sleepRecord.loadList').map((l) => l.level)).toEqual(['error']);

  mockTestDb.reopen();
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  await expectSList(app);
  expect(app.screen.queryByText('睡眠データを読み込めませんでした')).toBeNull();
});

// T163
it('Android の notGranted でも DB に睡眠があれば、案内と一緒に S の一覧が出て、1行目のタップで S の詳細が出る', async () => {
  const app = load('android');
  seedS(mockTestDb.sqlite);
  app.hc.getGrantedPermissions.mockResolvedValue([]);

  await app.open();

  await expectSList(app);
  expect(app.screen.getByRole('button', { name: 'ヘルスコネクトと連携する' })).toBeOnTheScreen();
  expect(
    app.screen.getByText('許可しなかった場合は、ヘルスコネクトの設定から許可してください'),
  ).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: '設定を開く' })).toBeOnTheScreen();

  await app.rntl.fireEvent.press((await app.screen.findAllByTestId('sleep-record-row'))[0]);

  await expectSDetailOpened(app);
});

// T164
it('ready で DB が空のまま初回同期の途中なら「取り込んでいます」だけが出て、終わると S の一覧が出る', async () => {
  const app = load();
  const reading = deferred<unknown[]>();
  app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);
  await app.open();

  expect(await app.screen.findByText('睡眠データを取り込んでいます')).toBeOnTheScreen();
  expect(app.screen.queryByText(/睡眠データがありません/)).toBeNull();

  await app.rntl.act(async () => {
    reading.resolve(sIosSamples());
    await flushPromises();
  });

  await expectSList(app);
  expect(app.screen.queryByText('睡眠データを取り込んでいます')).toBeNull();
});

// T165
it('連携状態の取得中は「読み込み中」だけが出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  const status = deferred<number>();
  app.hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);

  await app.open();

  expect(await app.screen.findByText('読み込み中')).toBeOnTheScreen();
  expect(app.screen.queryAllByTestId('sleep-record-row')).toEqual([]);
  expect(app.screen.queryAllByRole('button')).toEqual([]);
  expect(app.screen.queryByText(/睡眠データがありません/)).toBeNull();
  status.resolve(1);
});

// T180
it('連携状態が notRequested で DB にシード S があれば、待ったあとは連携ボタンと S の一覧が出て、読み込み中・空の案内は出ていない', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest

  await app.open();

  expect(await app.screen.findByRole('button', { name: 'ヘルスケアと連携する' })).toBeOnTheScreen();
  await expectSList(app);
  expect(app.screen.queryByText('読み込み中')).toBeNull();
  expect(app.screen.queryByText(/睡眠データがありません/)).toBeNull();
});

// T184
it('一覧が出たあとの前面復帰で連携状態の取得が保留でも、一覧が出たままで読み込み中・案内は出ない', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  await app.open();
  await expectSList(app);
  await app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));
  const status = deferred<number>();
  app.hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);

  await app.emit('background');
  await app.emit('active');

  expect(app.hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2);
  await expectSList(app);
  expect(app.screen.queryByText('読み込み中')).toBeNull();
  // 案内（連携・再試行のボタン）は出ない
  expect(app.screen.queryByRole('button', { name: /連携する|再試行/ })).toBeNull();
  await app.rntl.act(async () => {
    status.resolve(2); // unnecessary
    await flushPromises();
  });
});

// T166
it.each(['前面復帰', '下に引く'] as const)(
  '一覧が出たあと%sで読み取りが保留の間も、一覧が出たままで読み込み中は出ない',
  async (trigger) => {
    const app = load();
    seedS(mockTestDb.sqlite);
    app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
    await app.open();
    await expectSList(app);
    await app.rntl.waitFor(() => expect(app.store.getState().syncing).toBe(false));
    const reading = deferred<unknown[]>();
    app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);

    if (trigger === '前面復帰') {
      await app.emit('background');
      await app.emit('active');
    } else {
      await pull(app);
    }

    await app.rntl.waitFor(() => expect(app.hk.queryCategorySamples).toHaveBeenCalledTimes(2));
    await expectSList(app);
    expect(app.screen.queryByText('読み込み中')).toBeNull();
    await app.rntl.act(async () => {
      reading.resolve(sIosSamples());
      await flushPromises();
    });
  },
);

// T167
it('ready で DB に睡眠があって同期中なら、行が出たまま上部に同期中の表示が出る', async () => {
  const app = load();
  seedS(mockTestDb.sqlite);
  const reading = deferred<unknown[]>();
  app.hk.queryCategorySamples.mockReturnValueOnce(reading.promise as never);

  await app.open();

  expect(await app.screen.findByTestId('sleep-record-syncing')).toBeOnTheScreen();
  await expectSList(app);
  await app.rntl.act(async () => {
    reading.resolve(sIosSamples());
    await flushPromises();
  });
});

const CHART_ENTRY = '週・月の推移';

// 02 の T025
it.each([
  ['DB にシード S', true],
  ['DB 空でモックも0件', false],
] as const)('ready で %s のとき、「週・月の推移」ボタンが出る', async (_label, seeded) => {
  const app = load();
  if (seeded) {
    seedS(mockTestDb.sqlite);
    app.hk.queryCategorySamples.mockResolvedValue(sIosSamples() as never);
  }

  await app.open();

  if (seeded) await expectSList(app);
  else expect(await app.screen.findByText(/睡眠データがありません。/)).toBeOnTheScreen();
  expect(app.screen.getByRole('button', { name: CHART_ENTRY })).toBeOnTheScreen();
});

// 02 の T047
it('「週・月の推移」ボタンは案内のボタンより上にある', async () => {
  const app = load('android');
  app.hc.getGrantedPermissions.mockResolvedValue([]);
  // 一覧を表示している状態にする（「週・月の推移」は一覧の表示中だけ出る）
  seedS(mockTestDb.sqlite);

  await app.open();

  await expectSList(app);
  const buttons = app.screen.getAllByRole('button');
  const indexOf = (name: string) => buttons.indexOf(app.screen.getByRole('button', { name }));
  expect(indexOf(CHART_ENTRY)).toBeLessThan(indexOf('ヘルスコネクトと連携する'));
  expect(indexOf(CHART_ENTRY)).toBeLessThan(indexOf('設定を開く'));
});

// 02 の T026
it('連携状態の取得中（読み込み中）は「週・月の推移」ボタンが出ない', async () => {
  const app = load();
  const status = deferred<number>();
  app.hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);

  await app.open();

  expect(await app.screen.findByText('読み込み中')).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: CHART_ENTRY })).toBeNull();
  status.resolve(1);
});

// 02 の T027
it('一覧の読み取りに失敗したときは「週・月の推移」ボタンが出ない', async () => {
  const app = load();
  app.hk.getRequestStatusForAuthorization.mockResolvedValue(1 as never); // shouldRequest
  await app.store.getState().refreshAccess();
  mockTestDb.close();
  const { createElement } = require('react') as typeof import('react');
  const { SleepRecordListScreen } =
    require('@/features/sleep-record/sleep-record-list-screen') as typeof import('@/features/sleep-record/sleep-record-list-screen');
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  await render(createElement(SleepRecordListScreen));

  expect(await app.screen.findByText('睡眠データを読み込めませんでした')).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: CHART_ENTRY })).toBeNull();
  mockTestDb.reopen();
});
