// DB 接続。初回の呼び出しで端末内の SQLite を開き、以後は同じ接続を使い回す
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import type { AppDb } from '@/lib/db.types';
import * as sleepRecordSchema from '@/features/sleep-record/sleep-record.schema';

const DATABASE_NAME = 'suimin.db';

let instance: AppDb | undefined;

export function getDb(): AppDb {
  if (!instance) {
    const client = openDatabaseSync(DATABASE_NAME);
    // expo-sqlite の SQLite は外部キーが既定で無効なので、接続ごとに有効にする
    client.execSync('PRAGMA foreign_keys = ON');
    instance = drizzle(client, { schema: { ...sleepRecordSchema } });
  }
  return instance;
}
