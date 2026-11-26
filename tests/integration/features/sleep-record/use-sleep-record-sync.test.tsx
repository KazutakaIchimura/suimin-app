import type * as HealthKit from '@kingstinct/react-native-healthkit';
import type { AppStateStatus } from 'react-native';
import type * as HealthConnect from 'react-native-health-connect';

import type { HealthOs } from '@/features/sleep-record/sleep-record.types';

import { NOT_READY_STATES } from '../../helpers/access-states';
import { flushPromises } from '../../helpers/deferred';
import { createTestDb, type TestDb } from '../../helpers/test-db';

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`Platform.OS`・`AppState`
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

/**
 * フックと store を読み込み直す（前のテストの状態・実行中の Promise を持ち越さない）。
 * React も読み込み直されるので、RNTL も同じ登録から読む。`AppState` の変化は `emit` で流し込む
 */
let cleanup: (() => Promise<void>) | undefined;

function load(os: HealthOs = 'ios') {
  jest.resetModules();
  const { Platform, AppState } = require('react-native') as typeof import('react-native');
  jest.replaceProperty(Platform, 'OS', os);
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener as (state: AppStateStatus) => void);
    return { remove: jest.fn() };
  });
  (
    require('../../helpers/reset-health-mocks') as typeof import('../../helpers/reset-health-mocks')
  ).resetHealthMocks();
  // 入口（index）は読み込むと後片付けのフックを登録するため、テストの中では pure を読む（後片付けは afterEach で行う）
  const rntl =
    require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
  cleanup = rntl.cleanup;
  const { useSleepRecordSync } =
    require('@/features/sleep-record/use-sleep-record-sync') as typeof import('@/features/sleep-record/use-sleep-record-sync');
  const hk = jest.mocked(require('@kingstinct/react-native-healthkit') as typeof HealthKit);
  const hc = jest.mocked(require('react-native-health-connect') as typeof HealthConnect);
  const render = () => rntl.renderHook(() => useSleepRecordSync());
  const emit = async (state: AppStateStatus) => {
    await rntl.act(async () => {
      for (const listener of listeners) listener(state);
      await flushPromises();
    });
  };
  const store = (
    require('@/features/sleep-record/sleep-record.store') as typeof import('@/features/sleep-record/sleep-record.store')
  ).useSleepRecordStore;
  return { hk, hc, store, render, emit };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-11-25T12:00:00+09:00'));
  mockTestDb = createTestDb();
  // 共通ログの出力はこのファイルでは見ない（出力先の console だけ黙らせる）
  for (const level of ['info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockTestDb.destroy();
});

// T143
it('描画すると、連携状態の取得と読み取りがそれぞれ1回走る', async () => {
  const { hk, render } = load();

  await render();
  await flushPromises();

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
});

// T144
it('初回の同期が終わったあと background → active になると、連携状態の取得と読み取りがもう1回ずつ走る', async () => {
  const { hk, render, emit } = load();
  await render();
  await flushPromises();

  await emit('background');
  await emit('active');

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(2);
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(2);
});

// T145
it('active → inactive → active では、追加の取得・読み取りは走らない', async () => {
  const { hk, render, emit } = load();
  await render();
  await flushPromises();

  await emit('inactive');
  await emit('active');

  expect(hk.getRequestStatusForAuthorization).toHaveBeenCalledTimes(1);
  expect(hk.queryCategorySamples).toHaveBeenCalledTimes(1);
});

// T146
it.each(NOT_READY_STATES)(
  '%s の %s では、起動時も前面復帰時も読み取らない',
  async (os, status, arrange) => {
    const mocks = load(os);
    arrange(mocks);

    await mocks.render();
    await flushPromises();
    await mocks.emit('background');
    await mocks.emit('active');

    // どちらの契機でも連携状態は取得している（取得関数が2回）
    const statusFn = os === 'ios' ? mocks.hk.isHealthDataAvailable : mocks.hc.getSdkStatus;
    expect(statusFn).toHaveBeenCalledTimes(2);
    expect(mocks.store.getState().accessStatus).toBe(status);
    expect(mocks.hk.queryCategorySamples).not.toHaveBeenCalled();
    expect(mocks.hc.readRecords).not.toHaveBeenCalled();
  },
);
