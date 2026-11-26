// 睡眠記録の DB の読み書き（設計書 3.1「DB の入れ替え」・3.2）
import { and, asc, eq, gt, gte, inArray, lt, or } from 'drizzle-orm';

import {
  sleepSessions,
  sleepStages,
  sleepSyncState,
} from '@/features/sleep-record/sleep-record.schema';
import type {
  SleepSession,
  SleepSessionSummary,
  Stage,
} from '@/features/sleep-record/sleep-record.types';
import { getDb } from '@/lib/db';

/** 同期記録の行の id（1行だけ） */
const SYNC_STATE_ID = 1;

/**
 * 睡眠を入れ替える（1トランザクション。途中で失敗したら何も変えない）：
 * 1. 起床が範囲の開始以降・採用する睡眠と同じ id・採用する睡眠と時間が重なる DB の睡眠を消す（ステージは CASCADE で消える）
 * 2. 採用する睡眠とステージ区間を入れる
 * 3. 同期記録を今回の同期開始時刻にする
 */
export function replaceSessions(input: {
  rangeStartAt: number;
  syncStartedAt: number;
  sessions: SleepSession[];
}): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(sleepSessions).where(gte(sleepSessions.endAt, input.rangeStartAt)).run();
    for (const session of input.sessions) {
      tx.delete(sleepSessions)
        .where(
          or(
            eq(sleepSessions.id, session.id),
            // 終了と開始がちょうど同じなら重ならない
            and(lt(sleepSessions.startAt, session.endAt), gt(sleepSessions.endAt, session.startAt)),
          ),
        )
        .run();
    }
    for (const session of input.sessions) {
      tx.insert(sleepSessions)
        .values({
          id: session.id,
          sourceId: session.sourceId,
          startAt: session.startAt,
          endAt: session.endAt,
          wakeDate: session.wakeDate,
          asleepMinutes: session.asleepMinutes,
          hasStages: session.hasStages ? 1 : 0,
        })
        .run();
      if (session.stages.length > 0) {
        tx.insert(sleepStages)
          .values(session.stages.map((s) => ({ sessionId: session.id, ...s })))
          .run();
      }
    }
    tx.insert(sleepSyncState)
      .values({ id: SYNC_STATE_ID, lastSyncedAt: input.syncStartedAt })
      .onConflictDoUpdate({ target: sleepSyncState.id, set: { lastSyncedAt: input.syncStartedAt } })
      .run();
  });
}

/** 前回成功した同期の開始時刻。同期記録がなければ `null` */
export function readLastSyncedAt(): number | null {
  const row = getDb()
    .select({ lastSyncedAt: sleepSyncState.lastSyncedAt })
    .from(sleepSyncState)
    .where(eq(sleepSyncState.id, SYNC_STATE_ID))
    .get();
  return row?.lastSyncedAt ?? null;
}

/** すべての睡眠（ステージ区間を除く。一覧用） */
export function listSessions(): SleepSessionSummary[] {
  return getDb().select().from(sleepSessions).all().map(toSummary);
}

/** 帰属日を指定した睡眠とステージ区間（区間は開始の早い順） */
export function findSessionsByWakeDate(wakeDate: string): SleepSession[] {
  const db = getDb();
  const rows = db.select().from(sleepSessions).where(eq(sleepSessions.wakeDate, wakeDate)).all();
  if (rows.length === 0) return [];
  const stages = db
    .select()
    .from(sleepStages)
    .where(
      inArray(
        sleepStages.sessionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(sleepStages.startAt))
    .all();
  return rows.map((row) => ({
    ...toSummary(row),
    stages: stages
      .filter((st) => st.sessionId === row.id)
      .map((st) => ({ stage: st.stage as Stage, startAt: st.startAt, endAt: st.endAt })),
  }));
}

/** 睡眠が1件でもあるか */
export function hasAnySession(): boolean {
  return getDb().select({ id: sleepSessions.id }).from(sleepSessions).limit(1).get() !== undefined;
}

function toSummary(row: typeof sleepSessions.$inferSelect): SleepSessionSummary {
  return { ...row, hasStages: row.hasStages === 1 };
}
