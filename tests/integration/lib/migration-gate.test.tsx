import { render, screen } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Text } from 'react-native';

// 外部I/Oの境界だけを差し替える：
// - `@/lib/db` → マイグレーションを適用していない空の better-sqlite3 DB（T209 だけ、例外を投げる getDb）
// - `@/drizzle/migrations` → 中身は本物のまま、読み出しを止めておけるもの（DB への入力データ。アプリのロジックは差し替えない）
let mockSqlite: Database.Database;
let mockDb: ReturnType<typeof drizzle>;
// T209 だけ、呼ばれるたびに例外を投げる（DB を開けない場合）。ほかは空の DB を返す
const mockGetDb = jest.fn(() => mockDb);
jest.mock('@/lib/db', () => ({ getDb: () => mockGetDb() }));
let mockMigrations: { journal: { entries: unknown }; migrations: Record<string, string> };
jest.mock('@/drizzle/migrations', () => ({
  __esModule: true,
  get default() {
    return mockMigrations;
  },
}));

// eslint-disable-next-line import/first
import { MigrationGate } from '@/lib/migration-gate';

import { captureLogs, type CapturedLog } from '../helpers/capture-logs';

const actual = jest.requireActual('@/drizzle/migrations').default as {
  journal: { entries: unknown[] };
  migrations: Record<string, string>;
};

/** 本物のマイグレーション。`release()` を呼ぶまで、drizzle がマイグレーション一覧を読み終えない */
function heldMigrations() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockMigrations = {
    migrations: actual.migrations,
    journal: {
      ...actual.journal,
      entries: (async function* () {
        await released;
        yield* actual.journal.entries;
      })(),
    },
  };
  return release;
}

let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  mockGetDb.mockReset().mockImplementation(() => mockDb);
  ({ named: logsNamed } = captureLogs());
  mockSqlite = new Database(':memory:');
  mockDb = drizzle(mockSqlite);
  mockMigrations = actual;
});

afterEach(() => {
  jest.restoreAllMocks();
  mockSqlite.close();
});

const tableNames = () =>
  (
    mockSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);

// T130
it('マイグレーションの適用が終わるまで子要素を出さず、終わったら出す', async () => {
  const release = heldMigrations();

  await render(
    <MigrationGate>
      <Text>child</Text>
    </MigrationGate>,
  );
  // 適用が終わる前は子要素を出さない
  expect(screen.queryByText('child')).toBeNull();
  expect(screen.queryByText('データベースの準備に失敗しました')).toBeNull();
  expect(tableNames()).not.toContain('sleep_sessions');

  release();

  expect(await screen.findByText('child')).toBeOnTheScreen();
  expect(screen.queryByText('データベースの準備に失敗しました')).toBeNull();
  expect(tableNames()).toEqual(
    expect.arrayContaining(['sleep_sessions', 'sleep_stages', 'sleep_sync_state']),
  );
  expect(logsNamed('app.migrate')).toEqual([]);
});

// T131
it('マイグレーションが失敗したら、失敗の表示を出して子要素を出さず、error ログを出す', async () => {
  mockMigrations = {
    journal: { entries: [{ idx: 0, when: 1, tag: '0000_broken', breakpoints: true }] },
    migrations: { m0000: 'CREATE TABL broken (a);' },
  };

  await render(
    <MigrationGate>
      <Text>child</Text>
    </MigrationGate>,
  );

  expect(await screen.findByText('データベースの準備に失敗しました')).toBeOnTheScreen();
  expect(screen.queryByText('child')).toBeNull();
  expect(logsNamed('app.migrate').map((l) => [l.level, l.entry])).toEqual([
    [
      'error',
      {
        name: 'app.migrate',
        err: expect.objectContaining({
          type: 'DrizzleError',
          message: "Failed to run the query 'CREATE TABL broken (a);'",
        }),
      },
    ],
  ]);
});

// T209
it('DB を開けなかったら、落ちずに失敗の表示と error ログを出し、描画し直しても開き直さない', async () => {
  const openError = new Error('open failed');
  mockGetDb.mockImplementation(() => {
    throw openError;
  });
  // 描画し直しを省かれないよう、描画のたびに新しい要素を作る
  const element = () => (
    <MigrationGate>
      <Text>child</Text>
    </MigrationGate>
  );

  const rendered = await render(element());

  expect(await screen.findByText('データベースの準備に失敗しました')).toBeOnTheScreen();
  expect(screen.queryByText('child')).toBeNull();
  const expectedLogs = [
    [
      'error',
      {
        name: 'app.migrate',
        err: { type: 'Error', message: 'open failed', stack: openError.stack },
      },
    ],
  ];
  expect(logsNamed('app.migrate').map((l) => [l.level, l.entry])).toEqual(expectedLogs);

  await rendered.rerender(element());

  expect(screen.getByText('データベースの準備に失敗しました')).toBeOnTheScreen();
  expect(mockGetDb).toHaveBeenCalledTimes(1);
  expect(logsNamed('app.migrate').map((l) => [l.level, l.entry])).toEqual(expectedLogs);
});
