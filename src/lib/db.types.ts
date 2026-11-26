// `@/lib/db` が返す DB の型。テストで better-sqlite3 の DB に差し替えても合うよう、同期型の共通の型にする
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type * as sleepRecordSchema from '@/features/sleep-record/sleep-record.schema';

export type AppSchema = typeof sleepRecordSchema;

export type AppDb = BaseSQLiteDatabase<'sync', unknown, AppSchema>;
