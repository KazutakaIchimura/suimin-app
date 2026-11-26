import fs from 'node:fs';
import path from 'node:path';

import { createTestDb, type TestDb } from '../../helpers/test-db';

type Row = Record<string, string | number | null>;

const START = new Date('2026-11-24T23:00:00+09:00').getTime();
const END = new Date('2026-11-25T06:30:00+09:00').getTime();

const session = (overrides: Row = {}): Row => ({
  id: 's1',
  source_id: 'com.soxai',
  start_at: START,
  end_at: END,
  wake_date: '2026-11-25',
  asleep_minutes: 420,
  has_stages: 1,
  ...overrides,
});

const stage = (overrides: Row = {}): Row => ({
  session_id: 's1',
  stage: 'light',
  start_at: START,
  end_at: START + 60 * 60 * 1000,
  ...overrides,
});

/** 制約違反（SQLITE_CONSTRAINT_*）で失敗することを確かめる。テーブル・列の取り違えによる例外では通らない */
function expectConstraintError(fn: () => void) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toEqual(
    expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) }),
  );
}

describe('sleep-record のテーブル定義と制約', () => {
  let t: TestDb;

  const insert = (table: string, row: Row) => {
    const cols = Object.keys(row);
    t.sqlite
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(row));
  };
  const count = (table: string) =>
    (t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.destroy();
  });

  // T008
  it('正しい値の睡眠1件とステージ2件は入る', () => {
    insert('sleep_sessions', session());
    insert('sleep_stages', stage());
    insert('sleep_stages', stage({ stage: 'deep', start_at: START + 3600000, end_at: END }));

    expect(count('sleep_sessions')).toBe(1);
    expect(count('sleep_stages')).toBe(2);
  });

  // T009
  it('睡眠を消すと、そのステージ区間も消える（CASCADE）', () => {
    insert('sleep_sessions', session());
    insert('sleep_stages', stage());
    insert('sleep_stages', stage({ stage: 'deep', start_at: START + 3600000, end_at: END }));

    t.sqlite.prepare('DELETE FROM sleep_sessions WHERE id = ?').run('s1');

    expect(count('sleep_stages')).toBe(0);
  });

  // T010
  it.each([
    ['end_at = start_at', { end_at: START }],
    ['end_at < start_at', { end_at: START - 1 }],
  ])('sleep_sessions の %s は入らない', (_label, overrides) => {
    expectConstraintError(() => insert('sleep_sessions', session(overrides)));
    expect(count('sleep_sessions')).toBe(0);
  });

  // T011
  it.each([
    ['asleep_minutes = 0', { asleep_minutes: 0 }],
    ['has_stages = 2', { has_stages: 2 }],
    ["wake_date = '2026/11/25'", { wake_date: '2026/11/25' }],
  ])('sleep_sessions の %s は入らない', (_label, overrides) => {
    expectConstraintError(() => insert('sleep_sessions', session(overrides)));
    expect(count('sleep_sessions')).toBe(0);
  });

  it.each([
    ['asleep_minutes = 1', { asleep_minutes: 1 }],
    ['has_stages = 0', { has_stages: 0 }],
    ['has_stages = 1', { has_stages: 1 }],
    ["wake_date = '2026-11-25'", { wake_date: '2026-11-25' }],
  ])('sleep_sessions の %s は入る（境界の反対側）', (_label, overrides) => {
    insert('sleep_sessions', session(overrides));
    expect(count('sleep_sessions')).toBe(1);
  });

  // T012
  it.each(['id', 'source_id', 'start_at', 'end_at', 'wake_date', 'asleep_minutes', 'has_stages'])(
    'sleep_sessions の %s が NULL なら入らない',
    (column) => {
      expectConstraintError(() => insert('sleep_sessions', session({ [column]: null })));
      expect(count('sleep_sessions')).toBe(0);
    },
  );

  it('生成されたマイグレーションで sleep_sessions.id が PRIMARY KEY NOT NULL になっている', () => {
    const dir = path.resolve(__dirname, '../../../../drizzle');
    const sql = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(sql).toMatch(/CREATE TABLE `sleep_sessions` \(\s*`id` text PRIMARY KEY NOT NULL/);
  });

  // T013
  describe('sleep_stages', () => {
    beforeEach(() => {
      insert('sleep_sessions', session());
    });

    it.each([
      ["stage = 'inBed'", { stage: 'inBed' }],
      ['end_at = start_at', { end_at: START }],
      ['end_at < start_at', { end_at: START - 1 }],
      ['存在しない session_id', { session_id: 'missing' }],
      ['session_id が NULL', { session_id: null }],
      ['stage が NULL', { stage: null }],
      ['start_at が NULL', { start_at: null }],
      ['end_at が NULL', { end_at: null }],
    ])('%s は入らない', (_label, overrides) => {
      expectConstraintError(() => insert('sleep_stages', stage(overrides)));
      expect(count('sleep_stages')).toBe(0);
    });

    it.each(['awake', 'light', 'deep', 'rem', 'unspecified'])("stage = '%s' は入る", (value) => {
      insert('sleep_stages', stage({ stage: value }));
      expect(count('sleep_stages')).toBe(1);
    });
  });

  // T014
  describe('sleep_sync_state', () => {
    it.each([
      ['id = 2', { id: 2, last_synced_at: END }],
      ['last_synced_at が NULL', { id: 1, last_synced_at: null }],
    ])('%s は入らない', (_label, row) => {
      expectConstraintError(() => insert('sleep_sync_state', row));
      expect(count('sleep_sync_state')).toBe(0);
    });

    it('id = 1 は入り、2行目の id = 1 は入らない', () => {
      insert('sleep_sync_state', { id: 1, last_synced_at: END });
      expect(count('sleep_sync_state')).toBe(1);

      expectConstraintError(() => insert('sleep_sync_state', { id: 1, last_synced_at: END + 1 }));
      expect(count('sleep_sync_state')).toBe(1);
    });
  });
});
