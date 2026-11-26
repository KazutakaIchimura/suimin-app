// 睡眠記録が所有するテーブル定義（設計書 3.2）。変更したら `npx drizzle-kit generate` でマイグレーションを作る
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 睡眠1回分 */
export const sleepSessions = sqliteTable(
  'sleep_sessions',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    wakeDate: text('wake_date').notNull(),
    asleepMinutes: integer('asleep_minutes').notNull(),
    hasStages: integer('has_stages').notNull(),
  },
  (t) => [
    check('sleep_sessions_end_after_start', sql`${t.endAt} > ${t.startAt}`),
    check(
      'sleep_sessions_wake_date_format',
      sql`${t.wakeDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('sleep_sessions_asleep_positive', sql`${t.asleepMinutes} > 0`),
    check('sleep_sessions_has_stages_bool', sql`${t.hasStages} IN (0, 1)`),
    index('sleep_sessions_wake_date_idx').on(t.wakeDate),
    index('sleep_sessions_end_at_idx').on(t.endAt),
  ],
);

/** 睡眠内のステージ区間 */
export const sleepStages = sqliteTable(
  'sleep_stages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sleepSessions.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
  },
  (t) => [
    check(
      'sleep_stages_stage_values',
      sql`${t.stage} IN ('awake', 'light', 'deep', 'rem', 'unspecified')`,
    ),
    check('sleep_stages_end_after_start', sql`${t.endAt} > ${t.startAt}`),
    index('sleep_stages_session_id_idx').on(t.sessionId),
  ],
);

/** 同期記録（1行だけ） */
export const sleepSyncState = sqliteTable(
  'sleep_sync_state',
  {
    id: integer('id').primaryKey(),
    lastSyncedAt: integer('last_synced_at').notNull(),
  },
  (t) => [check('sleep_sync_state_single_row', sql`${t.id} = 1`)],
);
