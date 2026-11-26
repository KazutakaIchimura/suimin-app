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
