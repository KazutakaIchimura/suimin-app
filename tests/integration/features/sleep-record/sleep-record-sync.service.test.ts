import {
  CategoryValueSleepAnalysis,
  queryCategorySamples,
} from '@kingstinct/react-native-healthkit';
import { readRecords, SleepStageType } from 'react-native-health-connect';

import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';
import { createTestDb, type TestDb } from '../../helpers/test-db';
import { resetHealthMocks } from '../../helpers/reset-health-mocks';

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリと、`@/lib/db`（テスト用DB）
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

// eslint-disable-next-line import/first
import { syncSleep } from '@/features/sleep-record/sleep-record-sync.service';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const D = 24 * HOUR;
const NOW = new Date('2026-11-25T12:00:00+09:00').getTime();
/** 同期の所要時間（getNow が開始の次に返す時刻との差） */
const ELAPSED = 1234;

/** 1回の同期で、開始に `startAt`、終了に `startAt + 1234ms` を返す getNow */
function clockFrom(startAt: number) {
  let calls = 0;
  return () => new Date(calls++ === 0 ? startAt : startAt + ELAPSED);
}

/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

/** HealthKit の睡眠サンプル1件 */
function sample(
  uuid: string,
  value: number,
  startAt: number,
  endAt: number,
  bundleIdentifier = 'com.soxai',
) {
  return {
    uuid,
    value,
    startDate: new Date(startAt),
    endDate: new Date(endAt),
    sourceRevision: { source: { name: 'source', bundleIdentifier } },
  };
}

const iosSamples = (samples: ReturnType<typeof sample>[]) =>
  jest.mocked(queryCategorySamples).mockResolvedValue(samples as never);

describe('syncSleep', () => {
  const sessionRows = () =>
    mockTestDb.sqlite.prepare('SELECT * FROM sleep_sessions ORDER BY start_at').all() as Record<
      string,
      unknown
    >[];
  const stageRows = (sessionId: string) =>
    mockTestDb.sqlite
      .prepare(
        'SELECT stage, start_at, end_at FROM sleep_stages WHERE session_id = ? ORDER BY start_at',
      )
      .all(sessionId);
  const syncStateRows = () => mockTestDb.sqlite.prepare('SELECT * FROM sleep_sync_state').all();

  /** 前提の同期記録を、テスト対象を通さず SQL で入れる */
  const seedSyncState = (lastSyncedAt: number) =>
    mockTestDb.sqlite
      .prepare('INSERT INTO sleep_sync_state (id, last_synced_at) VALUES (1, ?)')
      .run(lastSyncedAt);
  /** 前提の睡眠（`light` 1区間）を SQL で入れる */
  const seedSession = (id: string, startAt: number, endAt: number) => {
    mockTestDb.sqlite
      .prepare(
        'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, 1)',
      )
      .run(
        id,
        'com.soxai',
        startAt,
        endAt,
        new Date(endAt + 9 * HOUR).toISOString().slice(0, 10),
        Math.floor((endAt - startAt) / MIN),
      );
    mockTestDb.sqlite
      .prepare(
        "INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, 'light', ?, ?)",
      )
      .run(id, startAt, endAt);
  };
  /** 起床 wakeAt の6時間の睡眠になるサンプル1件 */
  const nightEndingAt = (uuid: string, wakeAt: number) =>
    sample(uuid, CategoryValueSleepAnalysis.asleepCore, wakeAt - 6 * HOUR, wakeAt);
  const readPeriod = (call = 0) => {
    const options = jest.mocked(queryCategorySamples).mock.calls[call][1] as {
      filter: { date: { startDate: Date; endDate: Date } };
    };
    return {
      startAt: options.filter.date.startDate.getTime(),
      endAt: options.filter.date.endDate.getTime(),
    };
  };

  /** 共通ログ関数が console に出した1行の JSON（出力の境界で受け取る） */
  let logs: CapturedLog[];
  let logsNamed: (name: string) => CapturedLog[];

  beforeEach(() => {
    mockTestDb = createTestDb();
    resetHealthMocks();
    ({ logs, named: logsNamed } = captureLogs());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockTestDb.destroy();
  });

  // T096
  it('初回同期で90日分（読み取りは91日前から）を取り込み、睡眠とステージ区間と同期記録を書く', async () => {
    iosSamples([
      sample(
        'u1',
        CategoryValueSleepAnalysis.asleepCore,
        jst('2026-11-24T23:00'),
        jst('2026-11-25T01:00'),
      ),
      sample(
        'u2',
        CategoryValueSleepAnalysis.asleepDeep,
        jst('2026-11-25T01:00'),
        jst('2026-11-25T02:00'),
      ),
      sample(
        'u3',
        CategoryValueSleepAnalysis.awake,
        jst('2026-11-25T02:00'),
        jst('2026-11-25T02:10'),
      ),
      sample(
        'u4',
        CategoryValueSleepAnalysis.asleepREM,
        jst('2026-11-25T02:10'),
        jst('2026-11-25T06:30'),
      ),
      sample(
        'n23',
        CategoryValueSleepAnalysis.asleepCore,
        jst('2026-11-22T23:00'),
        jst('2026-11-23T06:00'),
      ),
      sample(
        'n22',
        CategoryValueSleepAnalysis.asleepCore,
        jst('2026-11-21T23:00'),
        jst('2026-11-22T06:00'),
      ),
    ]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(queryCategorySamples).toHaveBeenCalledWith('HKCategoryTypeIdentifierSleepAnalysis', {
      limit: 0,
      filter: { date: { startDate: new Date(NOW - 91 * D), endDate: new Date(NOW) } },
    });
    expect(sessionRows().map((r) => r.id)).toEqual(['n22', 'n23', 'u1']);
    expect(sessionRows()[2]).toEqual({
      id: 'u1',
      source_id: 'com.soxai',
      start_at: 1795528800000,
      end_at: 1795555800000,
      wake_date: '2026-11-25',
      asleep_minutes: 440,
      has_stages: 1,
    });
    expect(stageRows('u1')).toEqual([
      { stage: 'light', start_at: jst('2026-11-24T23:00'), end_at: jst('2026-11-25T01:00') },
      { stage: 'deep', start_at: jst('2026-11-25T01:00'), end_at: jst('2026-11-25T02:00') },
      { stage: 'awake', start_at: jst('2026-11-25T02:00'), end_at: jst('2026-11-25T02:10') },
      { stage: 'rem', start_at: jst('2026-11-25T02:10'), end_at: jst('2026-11-25T06:30') },
    ]);
    expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW }]);
  });

  // T097
  it('2回目の同期で、削除・修正された直近の睡眠が反映され、範囲外の古い睡眠は残る', async () => {
    const [a, b, c, d] = [NOW - 1 * D, NOW - 2 * D, NOW - 3 * D, NOW - 10 * D];
    iosSamples([
      nightEndingAt('A', a),
      nightEndingAt('B', b),
      nightEndingAt('C', c),
      nightEndingAt('D', d),
    ]);
    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    // 2回目（範囲の開始は now − 6D）：A は消え、B は起床が30分遅れ、C はそのまま、D は返さない
    const movedB = sample('B', CategoryValueSleepAnalysis.asleepCore, b - 6 * HOUR, b + 30 * MIN);
    iosSamples([movedB, nightEndingAt('C', c)]);
    await syncSleep({ os: 'ios', requestId: 'req-2', getNow: clockFrom(NOW + D) });

    expect(sessionRows().map((r) => [r.id, r.end_at])).toEqual([
      ['D', d],
      ['C', c],
      ['B', b + 30 * MIN],
    ]);
    expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW + D }]);
  });

  // T098
  it('2回目以降は min(前回, now − 7D) − 24時間 〜 now を読む', async () => {
    seedSyncState(NOW - 20 * D);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(readPeriod()).toEqual({ startAt: NOW - 21 * D, endAt: NOW });
  });

  // T107
  it('範囲の開始より前に寝て開始より後に起きた睡眠は、元の就寝時刻のまま1件で保存される', async () => {
    seedSyncState(NOW - 3 * D);
    const R = NOW - 7 * D;
    iosSamples([
      sample('before', CategoryValueSleepAnalysis.asleepCore, R - 2 * HOUR, R),
      sample('after', CategoryValueSleepAnalysis.asleepDeep, R, R + 6 * HOUR),
    ]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(sessionRows().map((r) => [r.start_at, r.end_at])).toEqual([
      [R - 2 * HOUR, R + 6 * HOUR],
    ]);
  });

  // T108
  it('初回同期でヘルスケアから0件なら同期記録は書かれず、次の同期も90日分を読む', async () => {
    iosSamples([]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });
    await syncSleep({ os: 'ios', requestId: 'req-2', getNow: clockFrom(NOW + D) });

    expect(syncStateRows()).toEqual([]);
    expect(readPeriod(1)).toEqual({ startAt: NOW + D - 91 * D, endAt: NOW + D });
  });

  /** ログの文字列に、睡眠データそのもの（時刻・ステージ名・帰属日）が含まれないことを確かめる */
  const expectNoSleepData = (line: string, times: number[], wakeDates: string[]) => {
    for (const t of times) {
      expect(line).not.toContain(String(t));
      expect(line).not.toContain(new Date(t).toISOString());
    }
    for (const word of ['awake', 'light', 'deep', 'rem', 'unspecified', ...wakeDates]) {
      expect(line).not.toContain(word);
    }
  };

  // T103
  it('成功ログは件数・日数・ms だけで、睡眠の時刻・ステージ・帰属日を含まない', async () => {
    // 3晩 × 4サンプル = 12件で睡眠3件
    const nights = [jst('2026-11-24T23:00'), jst('2026-11-23T23:00'), jst('2026-11-22T23:00')];
    const values = [
      CategoryValueSleepAnalysis.asleepCore,
      CategoryValueSleepAnalysis.asleepDeep,
      CategoryValueSleepAnalysis.awake,
      CategoryValueSleepAnalysis.asleepREM,
    ];
    const samples = nights.flatMap((night, n) =>
      values.map((v, i) => sample(`n${n}-${i}`, v, night + i * HOUR, night + (i + 1) * HOUR)),
    );
    iosSamples(samples);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    const sync = logsNamed('sleepRecord.sync');
    expect(sync).toHaveLength(1);
    expect(sync[0].level).toBe('info');
    expect(sync[0].entry).toEqual({
      name: 'sleepRecord.sync',
      requestId: 'req-1',
      rangeDays: 90,
      segmentCount: 12,
      savedCount: 3,
      replaced: true,
      ms: ELAPSED,
    });
    expectNoSleepData(
      sync[0].line,
      samples.flatMap((x) => [x.startDate.getTime(), x.endDate.getTime()]),
      ['2026-11-25', '2026-11-24', '2026-11-23'],
    );
  });

  // T182
  it.each([
    ['7日と5時間', 7.2, 7 * D + 5 * HOUR],
    ['7日と3時間（7.125日）', 7.1, 7 * D + 3 * HOUR],
    ['7日と1.2時間（7.05日。.05 は切り上げ）', 7.1, 7 * D + 1.2 * HOUR],
  ])('前回の同期開始が %s 前なら rangeDays は %s', async (_label, expected, ago) => {
    seedSyncState(NOW - ago);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(logsNamed('sleepRecord.sync')[0].entry.rangeDays).toBe(expected);
  });

  // T105
  it('DB に睡眠がある状態でヘルスケアから0件なら、DB と同期記録は変わらず、入れ替えなしのログが出る', async () => {
    seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
    seedSyncState(NOW - 3 * D);
    iosSamples([]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(sessionRows().map((r) => r.id)).toEqual(['kept']);
    expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW - 3 * D }]);
    expect(logsNamed('sleepRecord.sync').map((l) => [l.level, l.entry])).toEqual([
      [
        'info',
        {
          name: 'sleepRecord.sync',
          requestId: 'req-1',
          rangeDays: 7,
          segmentCount: 0,
          savedCount: 0,
          replaced: false,
          ms: ELAPSED,
        },
      ],
    ]);
  });

  // T109
  it.each([
    [
      '範囲の開始より前に起床する睡眠だけ',
      () => [
        sample(
          'early',
          CategoryValueSleepAnalysis.asleepCore,
          NOW - 7 * D - 7 * HOUR,
          NOW - 7 * D - HOUR,
        ),
      ],
    ],
    [
      'awake だけ',
      () => [sample('awake', CategoryValueSleepAnalysis.awake, NOW - D - 2 * HOUR, NOW - D)],
    ],
  ])(
    'セグメントはあるが採用する睡眠が0件（%s）なら、範囲内の睡眠が消え、同期記録が更新される',
    async (_label, make) => {
      seedSession('inRange', NOW - D - 6 * HOUR, NOW - D);
      seedSyncState(NOW - 3 * D);
      iosSamples(make());

      await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

      expect(sessionRows()).toEqual([]);
      expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW }]);
      expect(logsNamed('sleepRecord.sync')[0].entry).toMatchObject({
        replaced: true,
        savedCount: 0,
      });
    },
  );

  // T110
  it.each([
    ['inBed だけ', CategoryValueSleepAnalysis.inBed, 6 * HOUR],
    ['長さ0だけ', CategoryValueSleepAnalysis.asleepCore, 0],
  ])(
    'ヘルスケアから%sが返ったら0件として扱い、DB と同期記録は変わらない',
    async (_label, value, length) => {
      seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
      seedSyncState(NOW - 3 * D);
      iosSamples([sample('x', value, NOW - D - 6 * HOUR, NOW - D - 6 * HOUR + length)]);

      await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

      expect(sessionRows().map((r) => r.id)).toEqual(['kept']);
      expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW - 3 * D }]);
      expect(logsNamed('sleepRecord.sync')[0].entry).toMatchObject({
        segmentCount: 0,
        savedCount: 0,
        replaced: false,
      });
    },
  );

  /** Android の SleepSession 1件（時刻は UNIX ミリ秒） */
  const hcRecord = (
    id: string,
    startAt: number,
    endAt: number,
    stages: [number, number, number][],
  ) => {
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      metadata: { id, dataOrigin: 'com.soxai' },
      startTime: iso(startAt),
      endTime: iso(endAt),
      stages: stages.map(([stage, start, end]) => ({
        stage,
        startTime: iso(start),
        endTime: iso(end),
      })),
    };
  };
  /** ステージがすべて長さ0の SleepSession A（就寝 NOW − 1D − 7時間・起床は引数） */
  const zeroStagesA = (startAt: number, endAt: number) =>
    hcRecord('A', startAt, endAt, [
      [SleepStageType.LIGHT, NOW - D - 6 * HOUR, NOW - D - 6 * HOUR],
      [SleepStageType.DEEP, NOW - D - 3 * HOUR, NOW - D - 3 * HOUR],
    ]);

  // T198
  it('Android でステージがすべて長さ0の SleepSession は、全体を1件と数えて取り込み、入れ替える', async () => {
    seedSession('old-1', NOW - D - 6 * HOUR, NOW - D);
    seedSyncState(NOW - 3 * D);
    const bStart = NOW - 2 * D - 3 * HOUR;
    jest.mocked(readRecords).mockResolvedValue({
      records: [
        zeroStagesA(NOW - D - 7 * HOUR, NOW - D),
        hcRecord('B', bStart, NOW - 2 * D, [
          [SleepStageType.LIGHT, bStart, bStart + HOUR],
          [SleepStageType.DEEP, bStart + HOUR, bStart + 2 * HOUR],
          [SleepStageType.REM, bStart + 2 * HOUR, NOW - 2 * D],
        ]),
      ],
    } as never);

    await syncSleep({ os: 'android', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(sessionRows().map((r) => r.id)).toEqual(['B', 'A']);
    expect(sessionRows()[1]).toMatchObject({
      start_at: NOW - D - 7 * HOUR,
      end_at: NOW - D,
      has_stages: 0,
    });
    expect(stageRows('A')).toEqual([
      { stage: 'unspecified', start_at: NOW - D - 7 * HOUR, end_at: NOW - D },
    ]);
    expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW }]);
    expect(logsNamed('sleepRecord.sync')[0].entry).toMatchObject({
      segmentCount: 4,
      savedCount: 2,
      replaced: true,
    });
  });

  // T203
  it.each([
    ['長さ0', NOW - D, NOW - D],
    ['前後が逆', NOW - D, NOW - D - 7 * HOUR],
  ])(
    'Android で SleepSession 自体も%sなら0件として扱い、DB と同期記録は変わらない',
    async (_label, startAt, endAt) => {
      seedSession('old-1', NOW - D - 6 * HOUR, NOW - D);
      seedSyncState(NOW - 3 * D);
      jest
        .mocked(readRecords)
        .mockResolvedValue({ records: [zeroStagesA(startAt, endAt)] } as never);

      await syncSleep({ os: 'android', requestId: 'req-1', getNow: clockFrom(NOW) });

      expect(sessionRows().map((r) => r.id)).toEqual(['old-1']);
      expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: NOW - 3 * D }]);
      expect(logsNamed('sleepRecord.sync')[0].entry).toMatchObject({
        segmentCount: 0,
        savedCount: 0,
        replaced: false,
      });
    },
  );

  // T111
  it('表にないステージ値があれば、件数だけの warn ログが出る', async () => {
    iosSamples([
      sample('k1', 99, jst('2026-11-24T23:00'), jst('2026-11-25T01:00')),
      sample('k2', 99, jst('2026-11-25T01:00'), jst('2026-11-25T06:00')),
    ]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    const fetch = logsNamed('sleepRecord.fetchFromHealth');
    expect(fetch.map((l) => [l.level, l.entry])).toEqual([
      ['warn', { name: 'sleepRecord.fetchFromHealth', requestId: 'req-1', unknownCount: 2 }],
    ]);
    expect(fetch[0].line).not.toContain('99');
  });

  // T112
  it('表にないステージ値がなければ fetchFromHealth のログは出ない', async () => {
    iosSamples([nightEndingAt('ok', NOW - D)]);

    await syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(logsNamed('sleepRecord.fetchFromHealth')).toEqual([]);
  });

  /** DB の状態（睡眠・ステージ・同期記録）。失敗したときに変わらないことを確かめる */
  const snapshot = () => ({
    sessions: sessionRows(),
    stages: mockTestDb.sqlite.prepare('SELECT * FROM sleep_stages ORDER BY id').all(),
    syncState: syncStateRows(),
  });
  /** error ログが1件だけで、requestId と整形された err を持つことを確かめる */
  const expectSyncErrorLog = (message: string) => {
    const errors = logsNamed('sleepRecord.sync');
    expect(errors.map((l) => l.level)).toEqual(['error']);
    expect(errors[0].entry).toEqual({
      name: 'sleepRecord.sync',
      requestId: 'req-1',
      err: expect.objectContaining({ message }),
    });
    return errors[0];
  };

  // T099
  it('ヘルスケアの読み取りが失敗したら、同じエラーが届き、DB と同期記録は変わらず、error ログが出る', async () => {
    seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
    seedSyncState(NOW - 3 * D);
    const before = snapshot();
    const error = new Error('healthkit failed');
    jest.mocked(queryCategorySamples).mockRejectedValue(error);

    await expect(syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) })).rejects.toBe(
      error,
    );

    expect(snapshot()).toEqual(before);
    expectSyncErrorLog('healthkit failed');
  });

  // T100
  it.each([
    ['2ページ目', true],
    ['1ページ目', false],
  ])(
    'Android で%sの読み取りが失敗したら、途中まで読んだ分で入れ替えない',
    async (_label, firstPageOk) => {
      seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
      seedSyncState(NOW - 3 * D);
      const before = snapshot();
      const error = new Error('health connect failed');
      if (firstPageOk) {
        jest
          .mocked(readRecords)
          .mockResolvedValueOnce({
            records: [
              {
                metadata: { id: 'hc-1', dataOrigin: 'com.soxai' },
                startTime: new Date(NOW - 2 * D).toISOString(),
                endTime: new Date(NOW - 2 * D + 6 * HOUR).toISOString(),
              },
            ],
            pageToken: 'p2',
          } as never)
          .mockRejectedValueOnce(error);
      } else {
        jest.mocked(readRecords).mockRejectedValueOnce(error);
      }

      await expect(
        syncSleep({ os: 'android', requestId: 'req-1', getNow: clockFrom(NOW) }),
      ).rejects.toBe(error);

      expect(readRecords).toHaveBeenCalledTimes(firstPageOk ? 2 : 1);
      expect(snapshot()).toEqual(before);
      expectSyncErrorLog('health connect failed');
    },
  );

  /** sleep_stages への挿入を必ず失敗させる（睡眠の削除と挿入が済んだあとに失敗する） */
  const failStageInsert = () =>
    mockTestDb.sqlite.exec(
      "CREATE TRIGGER fail_stage_insert BEFORE INSERT ON sleep_stages BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
  const newNight = () =>
    sample(
      'new',
      CategoryValueSleepAnalysis.asleepDeep,
      jst('2026-11-24T23:14'),
      jst('2026-11-25T06:46'),
    );

  // T106
  it('DB の入れ替えが失敗したら、DB のエラーが包まれずに届き、DB と同期記録は変わらず、error ログが出る', async () => {
    seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
    seedSyncState(NOW - 3 * D);
    const before = snapshot();
    failStageInsert();
    iosSamples([newNight()]);

    const result = syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) });

    // DB のエラーは失敗のたびに作られ、テストで同じ参照を持てないため、包み直されていない本体であることで確かめる。
    // better-sqlite3 のエラーは、先に走ったテストファイルの読み込みしだいで別の実行環境のものになり
    // instanceof が偽になりうるため、名前・コード・メッセージで確かめる
    await expect(result).rejects.toMatchObject({
      name: 'SqliteError',
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      message: 'test failure',
    });
    expect(snapshot()).toEqual(before);
    expectSyncErrorLog('test failure');
  });

  // T104
  it('DB のエラーのログに、入力した睡眠の時刻・ステージ・帰属日が含まれない', async () => {
    seedSession('kept', NOW - D - 6 * HOUR, NOW - D);
    seedSyncState(NOW - 3 * D);
    failStageInsert();
    const night = newNight();
    iosSamples([night]);

    await expect(
      syncSleep({ os: 'ios', requestId: 'req-1', getNow: clockFrom(NOW) }),
    ).rejects.toThrow();

    const log = expectSyncErrorLog('test failure');
    expectNoSleepData(
      log.line,
      [night.startDate.getTime(), night.endDate.getTime()],
      ['2026-11-25'],
    );
  });

  // T101
  it('Android で同期すると、SleepSession がそれぞれ1つの睡眠として保存される', async () => {
    jest.mocked(readRecords).mockResolvedValue({
      records: [
        {
          metadata: { id: 'hc-1', dataOrigin: 'com.soxai' },
          startTime: '2026-11-24T14:00:00.000Z',
          endTime: '2026-11-24T21:30:00.000Z',
          stages: [
            {
              stage: SleepStageType.LIGHT,
              startTime: '2026-11-24T14:00:00.000Z',
              endTime: '2026-11-24T21:30:00.000Z',
            },
          ],
        },
        {
          metadata: { id: 'hc-2', dataOrigin: 'com.soxai' },
          startTime: '2026-11-23T14:00:00.000Z',
          endTime: '2026-11-23T21:00:00.000Z',
        },
      ],
    } as never);

    await syncSleep({ os: 'android', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(sessionRows().map((r) => r.id)).toEqual(['hc-2', 'hc-1']);
    expect(sessionRows()[1]).toEqual({
      id: 'hc-1',
      source_id: 'com.soxai',
      start_at: 1795528800000,
      end_at: 1795555800000,
      wake_date: '2026-11-25',
      asleep_minutes: 450,
      has_stages: 1,
    });
  });

  // T102
  it('Android で metadata の id・dataOrigin がない SleepSession も、代わりの値で保存される', async () => {
    const start = '2026-11-24T14:00:00.000Z';
    const end = '2026-11-24T21:00:00.000Z';
    jest.mocked(readRecords).mockResolvedValue({
      records: [{ startTime: start, endTime: end }],
    } as never);

    await syncSleep({ os: 'android', requestId: 'req-1', getNow: clockFrom(NOW) });

    expect(sessionRows().map((r) => [r.id, r.source_id])).toEqual([
      [`unknown:${Date.parse(start)}:${Date.parse(end)}`, 'unknown'],
    ]);
  });
});
