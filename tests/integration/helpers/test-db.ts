// 中間テスト用の DB（設計書 3.3・testing.md）。
// better-sqlite3 の一時ファイルに drizzle/ の実際のマイグレーションを適用し、本物の SQL を通す。
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as sleepRecordSchema from '@/features/sleep-record/sleep-record.schema';

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../drizzle');

export type TestDb = {
  /** 生の SQL を通すための接続（制約の確認など） */
  sqlite: Database.Database;
  /** Drizzle の DB（`@/lib/db` の差し替え先） */
  db: ReturnType<typeof drizzle>;
  /** 接続を閉じる（読み取りの失敗を起こすため）。ファイルは残す */
  close: () => void;
  /** 同じファイルを開き直す */
  reopen: () => void;
  /** 閉じてファイルを消す（afterEach） */
  destroy: () => void;
};

function open(file: string) {
  const sqlite = new Database(file);
  // DB 接続（src/lib/db.ts）と同じく外部キーを効かせる
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db: drizzle(sqlite, { schema: { ...sleepRecordSchema } }) };
}

export function createTestDb(options: { migrate?: boolean } = {}): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suimin-test-db-'));
  const file = path.join(dir, 'test.db');
  const handle = open(file);
  if (options.migrate !== false) {
    migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  const testDb: TestDb = {
    ...handle,
    close: () => {
      if (testDb.sqlite.open) testDb.sqlite.close();
    },
    reopen: () => {
      testDb.close();
      const next = open(file);
      testDb.sqlite = next.sqlite;
      testDb.db = next.db;
    },
    destroy: () => {
      testDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return testDb;
}
