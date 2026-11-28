import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';
import { seedE } from '../../helpers/seed-s';
import { createTestDb, type TestDb } from '../../helpers/test-db';

// 外部I/Oの境界（`@/lib/db`）だけをテスト用DBに差し替える
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

// eslint-disable-next-line import/first
import { loadCycleParams } from '@/features/smart-alarm/smart-alarm-params.service';

const NOW = new Date('2026-11-28T23:34:00+09:00');

let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  mockTestDb = createTestDb();
  ({ named: logsNamed } = captureLogs());
});

afterEach(() => {
  jest.restoreAllMocks();
  mockTestDb.destroy();
});

// T050
it('今日の29日前（10-30）は数え、30日前（10-29）は数えない', () => {
  seedE(mockTestDb.sqlite);

  expect(loadCycleParams({ now: NOW, requestId: 'req-1' })).toEqual({
    onsetMinutes: 8,
    onsetSource: { kind: 'estimated' },
    cycleMinutes: 90,
    cycleSource: { kind: 'standard', missingDays: 1 },
  });
});

// T051
it('今日の主睡眠も数える', () => {
  seedE(mockTestDb.sqlite, { withToday: true });

  expect(loadCycleParams({ now: NOW, requestId: 'req-1' })).toMatchObject({
    cycleMinutes: 95,
    cycleSource: { kind: 'estimated' },
  });
});

// T146
it('今日は日本時間の日付（UTC ではまだ前日の 0:30 でも、範囲は 10-31〜11-29）', () => {
  seedE(mockTestDb.sqlite);

  expect(
    loadCycleParams({ now: new Date('2026-11-29T00:30:00+09:00'), requestId: 'req-1' }),
  ).toMatchObject({
    onsetMinutes: 14,
    onsetSource: { kind: 'standard', missingDays: 1 },
  });
});

// T052
it('DB が失敗すると、DB のエラーを投げ、01 の窓口の error ログが1件出る', () => {
  seedE(mockTestDb.sqlite);
  mockTestDb.close();

  expect(() => loadCycleParams({ now: NOW, requestId: 'req-1' })).toThrow(
    'The database connection is not open',
  );
  expect(logsNamed('sleepRecord.loadMainSleeps').map((l) => l.level)).toEqual(['error']);
});
