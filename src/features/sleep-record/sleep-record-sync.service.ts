// 同期の実行：範囲の計算 → ヘルスケアの読み取り → 組み立て → DB の入れ替え（設計書 3.1「同期（取り込み）のルール」・3.5）
import { getHealthRepository } from '@/features/sleep-record/sleep-record-health.repository';
import {
  buildSessions,
  countValidSegments,
} from '@/features/sleep-record/sleep-record-session.service';
import {
  computeSyncRange,
  healthReadStartAt,
  isAdopted,
} from '@/features/sleep-record/sleep-record-sync-range.service';
import { readLastSyncedAt, replaceSessions } from '@/features/sleep-record/sleep-record.repository';
import type { HealthOs } from '@/features/sleep-record/sleep-record.types';
import { logger } from '@/lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ヘルスケアの睡眠を取り込み、DB を入れ替える。失敗したらログを出して投げ直す（DB と同期記録は変えない）。
 * 開始時刻とログの `ms` は `getNow` で測る
 */
export async function syncSleep(input: {
  os: HealthOs;
  requestId: string;
  getNow: () => Date;
}): Promise<void> {
  const { requestId } = input;
  try {
    const startedAt = input.getNow().getTime();
    const range = computeSyncRange(startedAt, readLastSyncedAt());
    const { segments, unknownStageCount } = await getHealthRepository(input.os).readSegments({
      startAt: healthReadStartAt(range.startAt),
      endAt: range.endAt,
    });
    if (unknownStageCount > 0) {
      // 値そのものは出さず、件数だけ
      logger.warn('sleepRecord.fetchFromHealth', { requestId, unknownCount: unknownStageCount });
    }

    // 有効なセグメント（3.1「セグメントの件数」。inBed はリポジトリが読み捨て済み）が0件なら、DB も同期記録も変えない
    // （iOS は許可を取り消されても0件を返すため、貯めた履歴を消さない）
    const segmentCount = countValidSegments(segments);
    let savedCount = 0;
    if (segmentCount > 0) {
      const sessions = buildSessions(segments).filter((s) => isAdopted(s, range.startAt));
      replaceSessions({ rangeStartAt: range.startAt, syncStartedAt: startedAt, sessions });
      savedCount = sessions.length;
    }

    logger.info('sleepRecord.sync', {
      requestId,
      rangeDays: toRangeDays(startedAt - range.startAt),
      segmentCount,
      savedCount,
      replaced: segmentCount > 0,
      ms: input.getNow().getTime() - startedAt,
    });
  } catch (err) {
    logger.error('sleepRecord.sync', { requestId, err });
    throw err;
  }
}

/** 取り込み範囲の日数。小数第1位で四捨五入（.05 は切り上げ。×10 を先にして浮動小数の誤差を避ける） */
function toRangeDays(ms: number): number {
  return Math.round((ms * 10) / DAY_MS) / 10;
}
