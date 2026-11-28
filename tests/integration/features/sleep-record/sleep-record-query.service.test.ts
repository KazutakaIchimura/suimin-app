import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';
import { seedS } from '../../helpers/seed-s';
import { createTestDb, type TestDb } from '../../helpers/test-db';

// 外部I/Oの境界（`@/lib/db`）だけをテスト用DBに差し替える
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

// eslint-disable-next-line import/first
import {
  loadDayDetail,
  loadDaySummaries,
  loadMainSleeps,
} from '@/features/sleep-record/sleep-record-query.service';

const MIN = 60 * 1000;

/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  mockTestDb = createTestDb();
  ({ named: logsNamed } = captureLogs());
});

afterEach(() => {
  jest.restoreAllMocks();
  mockTestDb.destroy();
});

// T128
it('DB の睡眠から、日ごとの要約一覧と1日の詳細を作って返す', () => {
  seedS(mockTestDb.sqlite);

  expect(loadDaySummaries({ requestId: 'req-1' })).toEqual([
    {
      wakeDate: '2026-11-25',
      totalAsleepMinutes: 462,
      mainStartAt: jst('2026-11-24T23:14'),
      mainEndAt: jst('2026-11-25T06:46'),
      napCount: 1,
    },
    {
      wakeDate: '2026-11-24',
      totalAsleepMinutes: 420,
      mainStartAt: jst('2026-11-23T23:00'),
      mainEndAt: jst('2026-11-24T06:00'),
      napCount: 0,
    },
  ]);

  const detail = loadDayDetail({ wakeDate: '2026-11-25', requestId: 'req-1' });
  if (detail.kind !== 'found') throw new Error(`データありの詳細ではない: ${detail.kind}`);
  expect(detail.main).toMatchObject({
    id: 's-main-25',
    startAt: jst('2026-11-24T23:14'),
    endAt: jst('2026-11-25T06:46'),
    asleepMinutes: 432,
  });
  expect(detail.breakdown).toEqual([
    { stage: 'deep', minutes: 90, percent: 20 },
    { stage: 'light', minutes: 280, percent: 62 },
    { stage: 'rem', minutes: 62, percent: 14 },
    { stage: 'awake', minutes: 20, percent: 4 },
  ]);
  expect(detail.naps.map((n) => [n.startAt, n.endAt, n.asleepMinutes])).toEqual([
    [jst('2026-11-25T13:00'), jst('2026-11-25T13:30'), 30],
  ]);
});

// T129
// DB のエラーは失敗のたびに新しく作られ、テストで同じ参照を先に持てない。
// そのため「同じもの（toBe）」は、包み直されていない better-sqlite3 の TypeError であることで確かめる（T106 と同じ）
describe.each([
  ['一覧', 'sleepRecord.loadList', () => loadDaySummaries({ requestId: 'req-1' })],
  [
    '詳細',
    'sleepRecord.loadDetail',
    () => loadDayDetail({ wakeDate: '2026-11-25', requestId: 'req-1' }),
  ],
] as const)('%sの読み取りで DB が失敗したとき', (_label, logName, load) => {
  it('DB のエラーがそのまま届き、requestId 付き・日付なしの error ログが出る', () => {
    seedS(mockTestDb.sqlite);
    mockTestDb.close();

    let thrown: unknown;
    try {
      load();
    } catch (err) {
      thrown = err;
    }

    // ネイティブ側で作られたエラーは Jest の環境の TypeError と別物なので、instanceof ではなく名前で確かめる
    expect(thrown).toMatchObject({
      name: 'TypeError',
      message: 'The database connection is not open',
    });
    const lines = logsNamed(logName);
    expect(lines.map((l) => [l.level, l.entry])).toEqual([
      [
        'error',
        {
          name: logName,
          requestId: 'req-1',
          err: expect.objectContaining({
            type: 'TypeError',
            message: 'The database connection is not open',
          }),
        },
      ],
    ]);
    expect(lines[0].line).not.toContain('2026-11-25');
  });
});

// ---- 03 スマートアラームの推定の元データ（設計書 docs/features/03_smart-alarm.md の I7） ----

/** 睡眠1件を、テスト対象を通さず SQL で DB に入れる（ステージは就寝から隙間なく [ステージ, 分]） */
function insertSleep(
  id: string,
  start: string,
  wakeDate: string,
  stages: ['awake' | 'light' | 'deep' | 'rem' | 'unspecified', number][],
  hasStages = true,
): void {
  let at = jst(start);
  const list = stages.map(([stage, minutes]) => {
    const interval = { stage, startAt: at, endAt: at + minutes * MIN };
    at = interval.endAt;
    return interval;
  });
  const asleep = stages.filter(([st]) => st !== 'awake').reduce((sum, [, m]) => sum + m, 0);
  mockTestDb.sqlite
    .prepare(
      'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'com.soxai', list[0].startAt, at, wakeDate, asleep, hasStages ? 1 : 0);
  const insertStage = mockTestDb.sqlite.prepare(
    'INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, ?, ?, ?)',
  );
  for (const st of list) insertStage.run(id, st.stage, st.startAt, st.endAt);
}

describe('loadMainSleeps', () => {
  // T004
  it('帰属日が範囲の両端を含む主睡眠を、ステージ区間つきで古い順に返す（範囲の外・昼寝は入らない）', () => {
    insertSleep('m-09', '2026-11-08T23:00', '2026-11-09', [['light', 420]]);
    insertSleep('m-10', '2026-11-09T23:00', '2026-11-10', [
      ['awake', 10],
      ['deep', 60],
      ['rem', 30],
    ]);
    insertSleep('n-10', '2026-11-10T13:00', '2026-11-10', [['light', 30]]);
    insertSleep('m-20', '2026-11-19T23:30', '2026-11-20', [['light', 400]]);
    insertSleep('m-21', '2026-11-20T23:00', '2026-11-21', [['light', 420]]);

    const result = loadMainSleeps({
      fromWakeDate: '2026-11-10',
      toWakeDate: '2026-11-20',
      requestId: 'req-1',
    });

    expect(result.map((s) => s.id)).toEqual(['m-10', 'm-20']);
    expect(result[0].stages).toEqual([
      { stage: 'awake', startAt: jst('2026-11-09T23:00'), endAt: jst('2026-11-09T23:10') },
      { stage: 'deep', startAt: jst('2026-11-09T23:10'), endAt: jst('2026-11-10T00:10') },
      { stage: 'rem', startAt: jst('2026-11-10T00:10'), endAt: jst('2026-11-10T00:40') },
    ]);
  });

  // T005
  it('範囲に睡眠が1件もなければ空の配列を返す', () => {
    insertSleep('m-01', '2026-10-31T23:00', '2026-11-01', [['light', 420]]);

    expect(
      loadMainSleeps({ fromWakeDate: '2026-11-10', toWakeDate: '2026-11-20', requestId: 'req-1' }),
    ).toEqual([]);
  });

  // T007
  it('ステージなしの主睡眠もそのまま返し、ステージつきの昼寝に差し替えない', () => {
    insertSleep('m-15', '2026-11-14T23:00', '2026-11-15', [['unspecified', 420]], false);
    insertSleep('n-15', '2026-11-15T13:00', '2026-11-15', [['light', 30]]);
    insertSleep('m-16', '2026-11-15T23:00', '2026-11-16', [['light', 420]]);

    const result = loadMainSleeps({
      fromWakeDate: '2026-11-10',
      toWakeDate: '2026-11-20',
      requestId: 'req-1',
    });

    expect(result.map((s) => [s.id, s.hasStages])).toEqual([
      ['m-15', false],
      ['m-16', true],
    ]);
  });

  // T006
  it('DB が失敗すると、DB のエラーがそのまま届き、requestId 付き・日付なしの error ログが出る', () => {
    insertSleep('m-15', '2026-11-14T23:00', '2026-11-15', [['light', 420]]);
    mockTestDb.close();

    let thrown: unknown;
    try {
      loadMainSleeps({ fromWakeDate: '2026-11-10', toWakeDate: '2026-11-20', requestId: 'req-1' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      name: 'TypeError',
      message: 'The database connection is not open',
    });
    const lines = logsNamed('sleepRecord.loadMainSleeps');
    expect(lines.map((l) => [l.level, l.entry])).toEqual([
      [
        'error',
        {
          name: 'sleepRecord.loadMainSleeps',
          requestId: 'req-1',
          err: expect.objectContaining({
            type: 'TypeError',
            message: 'The database connection is not open',
          }),
        },
      ],
    ]);
    expect(lines[0].line).not.toContain('2026-11');
  });
});
