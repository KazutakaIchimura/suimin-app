// 画面用の読み取りの窓口（設計書 3.3）。DB の睡眠から日ごとの要約一覧・1日の詳細を作る。失敗はログを出して投げ直す
import {
  buildDayDetail,
  buildDaySummaries,
} from '@/features/sleep-record/sleep-record-day.service';
import {
  findSessionsByWakeDate,
  listSessions,
} from '@/features/sleep-record/sleep-record.repository';
import type { DayDetail, DaySummary } from '@/features/sleep-record/sleep-record.types';
import { logger } from '@/lib/logger';

/** `run` が失敗したら `name` の error ログを出し、同じエラーを投げ直す（日付などの健康データはログに出さない） */
function logFailure<T>(name: string, requestId: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    logger.error(name, { requestId, err });
    throw err;
  }
}

/** 日ごとの要約一覧（帰属日の新しい順） */
export function loadDaySummaries(input: { requestId: string }): DaySummary[] {
  return logFailure('sleepRecord.loadList', input.requestId, () =>
    buildDaySummaries(listSessions()),
  );
}

/** 帰属日 `wakeDate` の詳細 */
export function loadDayDetail(input: { wakeDate: string; requestId: string }): DayDetail {
  return logFailure('sleepRecord.loadDetail', input.requestId, () =>
    buildDayDetail(findSessionsByWakeDate(input.wakeDate), input.wakeDate),
  );
}
