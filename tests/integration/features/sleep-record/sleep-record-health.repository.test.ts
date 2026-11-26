import {
  AuthorizationRequestStatus,
  CategoryValueSleepAnalysis,
  getRequestStatusForAuthorization,
  isHealthDataAvailable,
  queryCategorySamples,
} from '@kingstinct/react-native-healthkit';
import {
  getGrantedPermissions,
  getSdkStatus,
  readRecords,
  SdkAvailabilityStatus,
  SleepStageType,
} from 'react-native-health-connect';

import { getHealthRepository } from '@/features/sleep-record/sleep-record-health.repository';

import { resetHealthMocks } from '../../helpers/reset-health-mocks';

jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);

const S = new Date('2026-11-17T12:00:00+09:00').getTime();
const E = new Date('2026-11-25T12:00:00+09:00').getTime();
const HOUR = 60 * 60 * 1000;

/** HealthKit の睡眠サンプル1件。i 番目は S から i 時間後の1時間 */
function sample(uuid: string, value: number, i: number) {
  return {
    uuid,
    value,
    startDate: new Date(S + i * HOUR),
    endDate: new Date(S + (i + 1) * HOUR),
    sourceRevision: { source: { name: 'SOXAI', bundleIdentifier: 'com.soxai' } },
  };
}

beforeEach(() => {
  resetHealthMocks();
});

describe('iOS（HealthKit）', () => {
  const repo = getHealthRepository('ios');

  // T077
  it('睡眠サンプルを表どおりのステージにし、inBed は捨て、表にない値は unspecified にして件数を返す', async () => {
    const values = [
      CategoryValueSleepAnalysis.awake,
      CategoryValueSleepAnalysis.asleepCore,
      CategoryValueSleepAnalysis.asleepDeep,
      CategoryValueSleepAnalysis.asleepREM,
      CategoryValueSleepAnalysis.asleepUnspecified,
      CategoryValueSleepAnalysis.inBed,
      99,
    ];
    jest
      .mocked(queryCategorySamples)
      .mockResolvedValue(values.map((v, i) => sample(`u${i}`, v, i)) as never);

    const result = await repo.readSegments({ startAt: S, endAt: E });

    expect(result.segments).toEqual([
      {
        os: 'ios',
        sampleId: 'u0',
        sourceId: 'com.soxai',
        stage: 'awake',
        startAt: S,
        endAt: S + HOUR,
      },
      {
        os: 'ios',
        sampleId: 'u1',
        sourceId: 'com.soxai',
        stage: 'light',
        startAt: S + HOUR,
        endAt: S + 2 * HOUR,
      },
      {
        os: 'ios',
        sampleId: 'u2',
        sourceId: 'com.soxai',
        stage: 'deep',
        startAt: S + 2 * HOUR,
        endAt: S + 3 * HOUR,
      },
      {
        os: 'ios',
        sampleId: 'u3',
        sourceId: 'com.soxai',
        stage: 'rem',
        startAt: S + 3 * HOUR,
        endAt: S + 4 * HOUR,
      },
      {
        os: 'ios',
        sampleId: 'u4',
        sourceId: 'com.soxai',
        stage: 'unspecified',
        startAt: S + 4 * HOUR,
        endAt: S + 5 * HOUR,
      },
      {
        os: 'ios',
        sampleId: 'u6',
        sourceId: 'com.soxai',
        stage: 'unspecified',
        startAt: S + 6 * HOUR,
        endAt: S + 7 * HOUR,
      },
    ]);
    expect(result.unknownStageCount).toBe(1);
  });

  // T078
  it('queryCategorySamples に睡眠の種類・全件取得・読み取り期間が渡る', async () => {
    await repo.readSegments({ startAt: S, endAt: E });

    expect(queryCategorySamples).toHaveBeenCalledTimes(1);
    expect(queryCategorySamples).toHaveBeenCalledWith('HKCategoryTypeIdentifierSleepAnalysis', {
      limit: 0,
      filter: { date: { startDate: new Date(S), endDate: new Date(E) } },
    });
  });

  // T079
  it('isHealthDataAvailable が false なら unavailable', async () => {
    jest.mocked(isHealthDataAvailable).mockReturnValue(false);

    await expect(repo.getAccessStatus()).resolves.toBe('unavailable');
  });

  // T080
  it.each([
    ['shouldRequest', 'notRequested', AuthorizationRequestStatus.shouldRequest],
    ['unnecessary', 'ready', AuthorizationRequestStatus.unnecessary],
    ['unknown', 'ready', AuthorizationRequestStatus.unknown],
  ])('getRequestStatusForAuthorization が %s なら %s', async (_label, expected, status) => {
    jest.mocked(getRequestStatusForAuthorization).mockResolvedValue(status);

    await expect(repo.getAccessStatus()).resolves.toBe(expected);
    // 許可の要求と同じく、睡眠の読み取りだけ（toShare なし）
    expect(getRequestStatusForAuthorization).toHaveBeenCalledWith({
      toRead: ['HKCategoryTypeIdentifierSleepAnalysis'],
    });
  });
});

describe('Android（ヘルスコネクト）', () => {
  const repo = getHealthRepository('android');
  const sIso = new Date(S).toISOString();
  const eIso = new Date(E).toISOString();

  /** SleepSession の1件。stages を渡さなければステージなし */
  const record = (
    id: string,
    startTime: string,
    endTime: string,
    stages?: { stage: number; startTime: string; endTime: string }[],
  ) => ({ metadata: { id, dataOrigin: 'com.soxai' }, startTime, endTime, stages });

  // T081
  it('ステージを表どおりにし、ステージなしの SleepSession は全体を unspecified 1件にし、表にない値は数える', async () => {
    const values = [
      SleepStageType.AWAKE,
      SleepStageType.OUT_OF_BED,
      SleepStageType.LIGHT,
      SleepStageType.DEEP,
      SleepStageType.REM,
      SleepStageType.SLEEPING,
      SleepStageType.UNKNOWN,
      99,
    ];
    const base = Date.parse('2026-11-24T14:00:00.000Z');
    const iso = (i: number) => new Date(base + i * HOUR).toISOString();
    jest.mocked(readRecords).mockResolvedValue({
      records: [
        record(
          'hc-1',
          iso(0),
          iso(8),
          values.map((stage, i) => ({ stage, startTime: iso(i), endTime: iso(i + 1) })),
        ),
        record('hc-2', '2026-11-25T05:00:00.000Z', '2026-11-25T06:00:00.000Z'),
      ],
    } as never);

    const result = await repo.readSegments({ startAt: S, endAt: E });

    const session = { sessionStartAt: base, sessionEndAt: base + 8 * HOUR };
    const stages = [
      'awake',
      'awake',
      'light',
      'deep',
      'rem',
      'unspecified',
      'unspecified',
      'unspecified',
    ];
    expect(result.segments).toEqual([
      ...stages.map((stage, i) => ({
        os: 'android',
        sessionId: 'hc-1',
        sourceId: 'com.soxai',
        ...session,
        stage,
        startAt: base + i * HOUR,
        endAt: base + (i + 1) * HOUR,
      })),
      {
        os: 'android',
        sessionId: 'hc-2',
        sourceId: 'com.soxai',
        sessionStartAt: Date.parse('2026-11-25T05:00:00.000Z'),
        sessionEndAt: Date.parse('2026-11-25T06:00:00.000Z'),
        stage: 'unspecified',
        startAt: Date.parse('2026-11-25T05:00:00.000Z'),
        endAt: Date.parse('2026-11-25T06:00:00.000Z'),
      },
    ]);
    // 先頭のセグメントは JST 23:00 開始
    expect(result.segments[0]).toMatchObject({ startAt: 1795528800000, endAt: 1795532400000 });
    expect(result.unknownStageCount).toBe(1);
  });

  // T082
  it('pageToken があれば次のページも読み、undefined なら打ち切る', async () => {
    jest
      .mocked(readRecords)
      .mockResolvedValueOnce({
        records: [record('p1', '2026-11-24T14:00:00.000Z', '2026-11-24T15:00:00.000Z')],
        pageToken: 'p2',
      } as never)
      .mockResolvedValueOnce({
        records: [record('p2', '2026-11-25T14:00:00.000Z', '2026-11-25T15:00:00.000Z')],
        pageToken: undefined,
      } as never);

    const result = await repo.readSegments({ startAt: S, endAt: E });

    expect(readRecords).toHaveBeenCalledTimes(2);
    expect(jest.mocked(readRecords).mock.calls[0]).toEqual([
      'SleepSession',
      { timeRangeFilter: { operator: 'between', startTime: sIso, endTime: eIso } },
    ]);
    expect(jest.mocked(readRecords).mock.calls[1]).toEqual([
      'SleepSession',
      { timeRangeFilter: { operator: 'between', startTime: sIso, endTime: eIso }, pageToken: 'p2' },
    ]);
    expect(result.segments.map((seg) => seg.os === 'android' && seg.sessionId)).toEqual([
      'p1',
      'p2',
    ]);
  });

  // T082
  it('pageToken が空文字なら1回で打ち切る', async () => {
    jest.mocked(readRecords).mockResolvedValueOnce({
      records: [record('p1', '2026-11-24T14:00:00.000Z', '2026-11-24T15:00:00.000Z')],
      pageToken: '',
    } as never);

    const result = await repo.readSegments({ startAt: S, endAt: E });

    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(readRecords).toHaveBeenCalledWith('SleepSession', {
      timeRangeFilter: { operator: 'between', startTime: sIso, endTime: eIso },
    });
    expect(result.segments).toHaveLength(1);
  });

  // T083
  it.each([
    ['SDK_UNAVAILABLE', 'unavailable', SdkAvailabilityStatus.SDK_UNAVAILABLE],
    [
      'SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED',
      'updateRequired',
      SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED,
    ],
  ])('getSdkStatus が %s なら %s', async (_label, expected, status) => {
    jest.mocked(getSdkStatus).mockResolvedValue(status);

    await expect(repo.getAccessStatus()).resolves.toBe(expected);
  });

  // T084
  it.each([
    ['睡眠の読み取り', 'ready', [{ accessType: 'read', recordType: 'SleepSession' }]],
    ['睡眠の書き込みだけ', 'notGranted', [{ accessType: 'write', recordType: 'SleepSession' }]],
    ['心拍の読み取りだけ', 'notGranted', [{ accessType: 'read', recordType: 'HeartRate' }]],
    ['許可なし', 'notGranted', []],
  ])('SDK_AVAILABLE で許可が「%s」なら %s', async (_label, expected, granted) => {
    jest.mocked(getGrantedPermissions).mockResolvedValue(granted as never);

    await expect(repo.getAccessStatus()).resolves.toBe(expected);
  });

  // T085
  it('getSdkStatus が表にない値なら例外を投げる', async () => {
    jest.mocked(getSdkStatus).mockResolvedValue(99);

    await expect(repo.getAccessStatus()).rejects.toThrow();
  });
});

describe('OS の切り替え', () => {
  // T086
  it.each([
    ['ios', queryCategorySamples, readRecords],
    ['android', readRecords, queryCategorySamples],
  ] as const)('%s では、その OS の読み取り関数だけが呼ばれる', async (os, called, notCalled) => {
    await getHealthRepository(os).readSegments({ startAt: S, endAt: E });

    expect(called).toHaveBeenCalledTimes(1);
    expect(notCalled).not.toHaveBeenCalled();
  });
});
