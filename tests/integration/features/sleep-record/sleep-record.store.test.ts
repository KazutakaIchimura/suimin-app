import type * as HealthKit from '@kingstinct/react-native-healthkit';
import type * as HealthConnect from 'react-native-health-connect';

import type { HealthOs } from '@/features/sleep-record/sleep-record.types';

import { NOT_READY_STATES } from '../../helpers/access-states';
import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';
import { deferred, flushPromises } from '../../helpers/deferred';
import { createTestDb, type TestDb } from '../../helpers/test-db';

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`Platform.OS`
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

type StoreModule = typeof import('@/features/sleep-record/sleep-record.store');

/**
 * store を読み込み直す（前のテストの状態・実行中の Promise を持ち越さない）。
 * ネイティブのモックも読み込み直されるので、既定に戻したものをあわせて返す
 */
function load(os: HealthOs = 'ios') {
  jest.resetModules();
  const { Platform } = require('react-native') as typeof import('react-native');
  jest.replaceProperty(Platform, 'OS', os);
  (
    require('../../helpers/reset-health-mocks') as typeof import('../../helpers/reset-health-mocks')
  ).resetHealthMocks();
  const store = (require('@/features/sleep-record/sleep-record.store') as StoreModule)
    .useSleepRecordStore;
  const hk = jest.mocked(require('@kingstinct/react-native-healthkit') as typeof HealthKit);
  const hc = jest.mocked(require('react-native-health-connect') as typeof HealthConnect);
  return { store, hk, hc };
}

/** 共通ログ関数が console に出した1行の JSON（出力の境界で受け取る） */
let logs: CapturedLog[];
let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-11-25T12:00:00+09:00'));
  mockTestDb = createTestDb();
  ({ logs, named: logsNamed } = captureLogs());
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockTestDb.destroy();
});

// T132
it('同期中にもう一度 sync() を呼んでも読み取りは1回だけで、2回目は1回目が終わるまで終わらない', async () => {
  const { store, hk } = load();
  const reading = deferred<never[]>();
  hk.queryCategorySamples.mockReturnValueOnce(reading.promise);

  const done: string[] = [];
  const first = store
    .getState()
    .sync()
    .then(() => done.push('first'));
  const second = store
    .getState()
    .sync()
    .then(() => done.push('second'));
  await flushPromises();

  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  expect(done).toEqual([]);

  reading.resolve([]);
  await Promise.all([first, second]);

  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  expect(done).toEqual(['first', 'second']);
});

// T133
it.each([
  ['成功', () => Promise.resolve([])],
  ['失敗', () => Promise.reject(new Error('read failed'))],
] as const)(
  '1回目の同期が%sで終わったあと、もう一度 sync() を呼ぶと新しく読み取る',
  async (_label, firstRead) => {
    const { store, hk } = load();
    hk.queryCategorySamples.mockImplementationOnce(firstRead as never);

    await store.getState().sync();
    await store.getState().sync();

    expect(hk.queryCategorySamples).toHaveBeenCalledTimes(2);
  },
);

// T134
it('連携状態の取得中にもう一度 refreshAccess() を呼んでも、取得は1回だけで、2回目は1回目の完了を待つ', async () => {
  const { store, hk } = load();
  const status = deferred<number>();
  hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);

  const done: string[] = [];
  const first = store
    .getState()
    .refreshAccess()
    .then(() => done.push('first'));
  const second = store
    .getState()
    .refreshAccess()
    .then(() => done.push('second'));
  await flushPromises();

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(done).toEqual([]);

  status.resolve(2); // unnecessary
  await Promise.all([first, second]);

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(done).toEqual(['first', 'second']);
  expect(store.getState().accessStatus).toBe('ready');
});

// T135
it('ready なら、連携状態を1回取得したあとに1回読み取る', async () => {
  const { store, hk } = load();

  await store.getState().sync();

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  expect(hk.getRequestStatusForAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
    hk.queryCategorySamples.mock.invocationCallOrder[0],
  );
});

// T136
it('連携状態の取得が失敗したら checkFailed で読み取らず、再試行で ready になれば読み取る', async () => {
  const { store, hk } = load();
  hk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('status failed'));

  await store.getState().sync();

  expect(hk.queryCategorySamples).not.toHaveBeenCalled();
  expect(store.getState().accessStatus).toBe('checkFailed');

  await store.getState().sync();

  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  expect(store.getState().accessStatus).toBe('ready');
});

// T141
it('refreshAccess() で連携状態の取得関数が reject したら、連携状態が checkFailed になる', async () => {
  const { store, hk } = load();
  hk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('status failed'));

  await expect(store.getState().refreshAccess()).resolves.toBe('checkFailed');

  expect(store.getState().accessStatus).toBe('checkFailed');
});

// T138
it('同期が失敗したら版番号は上がらず、次の同期が成功したらエラーが消えて版番号が上がる', async () => {
  const { store, hk } = load();
  const readError = new Error('read failed');
  hk.queryCategorySamples.mockRejectedValueOnce(readError);

  await store.getState().sync();

  expect(store.getState().lastSyncError).toBe(readError);
  expect(store.getState().dataVersion).toBe(0);

  await store.getState().sync();

  expect(store.getState().lastSyncError).toBeNull();
  expect(store.getState().dataVersion).toBe(1);
});

// T186
it('読み取りが0件でも成功扱いで、版番号が上がる', async () => {
  const { store, hk } = load();
  hk.queryCategorySamples.mockResolvedValue([]);

  await store.getState().sync();

  expect(store.getState().lastSyncError).toBeNull();
  expect(store.getState().dataVersion).toBe(1);
});

// T137
it.each([true, false])(
  'iOS の notRequested で requestAuthorization が %s を返したら、連携状態を取り直して同期する',
  async (granted) => {
    const { store, hk } = load();
    hk.getRequestStatusForAuthorization.mockResolvedValueOnce(
      1 as never, // shouldRequest
    );
    await store.getState().refreshAccess();
    expect(store.getState().accessStatus).toBe('notRequested');
    hk.requestAuthorization.mockResolvedValueOnce(granted);

    await store.getState().requestAccess();

    expect(hk.requestAuthorization).toHaveBeenCalledTimes(1);
    // 要求のあとの取得が1回（要求の前の1回と合わせて2回）
    expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2);
    expect(hk.requestAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      hk.getRequestStatusForAuthorization.mock.invocationCallOrder[1],
    );
    expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
    expect(store.getState().accessStatus).toBe('ready');
  },
);

// T196
it('Android の notGranted で requestPermission が成功し許可されたら、取り直して ready になり読み取る', async () => {
  const { store, hc } = load('android');
  hc.getGrantedPermissions.mockResolvedValueOnce([]);
  await store.getState().refreshAccess();
  expect(store.getState().accessStatus).toBe('notGranted');

  await store.getState().requestAccess();

  expect(hc.requestPermission).toHaveBeenCalledTimes(1);
  expect(hc.getGrantedPermissions).toHaveBeenCalledTimes(2);
  expect(store.getState().accessStatus).toBe('ready');
  expect(hc.readRecords).toHaveBeenCalledTimes(1);
});

// T140
it('同期中に許可の要求が成功したら、実行中の同期の完了後に、連携状態の取得からもう一度同期する', async () => {
  const { store, hk } = load();
  const reading = deferred<never[]>();
  hk.queryCategorySamples.mockReturnValueOnce(reading.promise);

  const syncing = store.getState().sync();
  await flushPromises();
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);

  const requesting = store.getState().requestAccess();
  await flushPromises();
  // 要求は成功したが、実行中の同期が終わるまでは取り直さない
  expect(hk.requestAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);

  reading.resolve([]);
  await Promise.all([syncing, requesting]);

  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(2);
  // 要求のあとの取得はちょうど1回で、2回目の読み取りより前
  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2);
  const statusAfterRequest = hk.getRequestStatusForAuthorization.mock.invocationCallOrder[1];
  expect(statusAfterRequest).toBeGreaterThan(hk.requestAuthorization.mock.invocationCallOrder[0]);
  expect(statusAfterRequest).toBeLessThan(hk.queryCategorySamples.mock.invocationCallOrder[1]);
});

// T187
it('iOS で openSettings() を呼ぶと、設定を開くの失敗が真になり、error ログが出る', async () => {
  const { store } = load('ios');

  await store.getState().openSettings();

  expect(store.getState().openSettingsFailed).toBe(true);
  expect(logsNamed('sleepRecord.openSettings').map((l) => l.level)).toEqual(['error']);
});

// T139
it.each(NOT_READY_STATES)(
  '%s の %s では、sync() は連携状態の取得だけで読み取らない',
  async (os, status, arrange) => {
    const mocks = load(os);
    arrange(mocks);

    await mocks.store.getState().sync();

    expect(mocks.store.getState().accessStatus).toBe(status);
    const statusFn = os === 'ios' ? mocks.hk.isHealthDataAvailable : mocks.hc.getSdkStatus;
    expect(statusFn).toHaveBeenCalledTimes(1);
    expect(mocks.hk.queryCategorySamples).not.toHaveBeenCalled();
    expect(mocks.hc.readRecords).not.toHaveBeenCalled();
  },
);

// T142
it('1回の sync() の中では同じ requestId が窓口・同期サービス・ログに渡り、操作ごとに違う値になる', async () => {
  const { store, hk } = load();
  // 中身を差し替えない spyOn（本物の処理をそのまま動かし、渡った引数を見るだけ。設計書 3.3 で I4-13b だけに認める）
  const access =
    require('@/features/sleep-record/sleep-record-access.service') as typeof import('@/features/sleep-record/sleep-record-access.service');
  const syncService =
    require('@/features/sleep-record/sleep-record-sync.service') as typeof import('@/features/sleep-record/sleep-record-sync.service');
  const checkSpy = jest.spyOn(access, 'checkAccess');
  const syncSpy = jest.spyOn(syncService, 'syncSleep');
  // 表にないステージ値（99）の睡眠サンプル1件（fetchFromHealth の warn ログを出すため）
  const end = new Date('2026-11-25T06:00:00+09:00');
  hk.queryCategorySamples.mockResolvedValue([
    {
      uuid: 'u1',
      value: 99,
      startDate: new Date(end.getTime() - 60 * 60 * 1000),
      endDate: end,
      sourceRevision: { source: { name: 'SOXAI', bundleIdentifier: 'com.soxai' } },
    },
  ] as never);

  await store.getState().sync();
  await store.getState().sync();

  const ids = [0, 1].map((i) => {
    const id = checkSpy.mock.calls[i][0].requestId;
    expect(syncSpy.mock.calls[i][0].requestId).toBe(id);
    expect(logsNamed('sleepRecord.fetchFromHealth')[i].entry.requestId).toBe(id);
    expect(logsNamed('sleepRecord.sync')[i].entry.requestId).toBe(id);
    return id;
  });
  expect(ids[0]).not.toBe(ids[1]);

  await store.getState().requestAccess();

  const requestLog = logsNamed('sleepRecord.requestAccess');
  expect(requestLog.map((l) => l.level)).toEqual(['info']);
  expect(checkSpy).toHaveBeenCalledTimes(3);
  expect(checkSpy.mock.calls[2][0].requestId).not.toBe(requestLog[0].entry.requestId);
});

/** store の更新を記録する（連携状態と同期中の印の組） */
function recordUpdates(store: ReturnType<typeof load>['store']) {
  const updates: { accessStatus: unknown; syncing: boolean }[] = [];
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.accessStatus !== prev.accessStatus || state.syncing !== prev.syncing) {
      updates.push({ accessStatus: state.accessStatus, syncing: state.syncing });
    }
  });
  return { updates, unsubscribe };
}

// T199
it.each(['合流なし', '単独の refreshAccess() に合流'] as const)(
  'ready の sync()（%s）の途中に「ready・同期中でない」状態がない',
  async (pattern) => {
    const { store, hk } = load();
    expect(store.getState()).toMatchObject({ accessStatus: null, syncing: false });
    const status = deferred<number>();
    if (pattern !== '合流なし')
      hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);
    const refreshing =
      pattern === '合流なし' ? Promise.resolve() : store.getState().refreshAccess();
    const { updates, unsubscribe } = recordUpdates(store);

    const syncing = store.getState().sync();
    status.resolve(2); // unnecessary
    await Promise.all([refreshing, syncing]);
    unsubscribe();

    expect(updates.slice(0, -1)).not.toContainEqual({ accessStatus: 'ready', syncing: false });
    expect(updates.at(-1)).toEqual({ accessStatus: 'ready', syncing: false });
    expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
    expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
  },
);

// T204
it.each([
  ['notRequested（合流なし）', 'notRequested', false],
  ['notRequested（単独の refreshAccess() に合流）', 'notRequested', true],
  ['取得が reject（checkFailed）', 'checkFailed', false],
] as const)(
  '%s で終わる sync() は、連携状態と syncing: false を同じ1回の更新で入れる',
  async (_label, expected, join) => {
    const { store, hk } = load();
    const status = deferred<number>();
    if (expected === 'checkFailed') {
      hk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('status failed'));
    } else {
      hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);
    }
    const refreshing = join ? store.getState().refreshAccess() : Promise.resolve();
    const { updates, unsubscribe } = recordUpdates(store);

    const syncing = store.getState().sync();
    status.resolve(1); // shouldRequest
    await Promise.all([refreshing, syncing]);
    unsubscribe();

    expect(store.getState()).toMatchObject({ accessStatus: expected, syncing: false });
    // 連携状態が変わった更新では、すでに syncing: false になっている
    const statusUpdates = updates.filter((u) => u.accessStatus === expected);
    expect(statusUpdates[0]).toEqual({ accessStatus: expected, syncing: false });
    expect(hk.queryCategorySamples).not.toHaveBeenCalled();
  },
);

// T200
it('許可の要求中の印は、要求のあと連携状態を取り直し終えるまで立ち、その間の requestAccess() は要求を重ねずすぐ終わる', async () => {
  const { store, hk } = load();
  hk.getRequestStatusForAuthorization.mockResolvedValueOnce(1 as never); // shouldRequest
  await store.getState().refreshAccess();
  const status = deferred<number>();
  const reading = deferred<never[]>();
  hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);
  hk.queryCategorySamples.mockReturnValueOnce(reading.promise);

  const first = store.getState().requestAccess();
  await flushPromises();
  expect(store.getState().requestingAccess).toBe(true);
  let secondDone = false;
  await store
    .getState()
    .requestAccess()
    .then(() => (secondDone = true));
  expect(secondDone).toBe(true);
  expect(hk.requestAuthorization).toHaveBeenCalledTimes(1);

  status.resolve(2); // unnecessary
  await flushPromises();
  expect(store.getState()).toMatchObject({ requestingAccess: false, syncing: true });

  reading.resolve([]);
  await first;
  expect(store.getState()).toMatchObject({ accessStatus: 'ready', syncing: false });
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
});

// T205
it('許可の要求は成功したが取り直しが失敗したら、checkFailed になり要求中の印が下りる', async () => {
  const { store, hk } = load();
  hk.getRequestStatusForAuthorization.mockResolvedValueOnce(1 as never); // shouldRequest
  await store.getState().refreshAccess();
  hk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('status failed'));

  await expect(store.getState().requestAccess()).resolves.toBeUndefined();

  expect(store.getState()).toMatchObject({
    accessStatus: 'checkFailed',
    requestingAccess: false,
    requestAccessFailed: false,
    syncing: false,
  });
  expect(hk.requestAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.queryCategorySamples).not.toHaveBeenCalled();
  expect(logsNamed('sleepRecord.checkAccess').map((l) => l.level)).toEqual(['error']);
});

// T206
it('実行中の同期を待つ間と、新しい同期の取り直しの間も要求中の印は立ったままで、要求は重ならない', async () => {
  const { store, hk } = load();
  const firstRead = deferred<never[]>();
  hk.queryCategorySamples.mockReturnValueOnce(firstRead.promise);
  const syncing = store.getState().sync();
  await flushPromises();
  const status = deferred<number>();
  hk.getRequestStatusForAuthorization.mockReturnValueOnce(status.promise as never);

  const requesting = store.getState().requestAccess();
  await flushPromises();
  expect(store.getState().requestingAccess).toBe(true);

  firstRead.resolve([]);
  await syncing;
  await flushPromises();
  expect(store.getState().requestingAccess).toBe(true);
  await store.getState().requestAccess();
  expect(hk.requestAuthorization).toHaveBeenCalledTimes(1);

  status.resolve(2); // unnecessary
  await flushPromises();
  expect(store.getState().requestingAccess).toBe(false);
  await requesting;
});
