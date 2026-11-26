// 連携状態の取得・許可の要求・設定を開く、の窓口（設計書 3.1「連携状態と案内」・3.3）。失敗はログを出して投げ直す
import { getHealthRepository } from '@/features/sleep-record/sleep-record-health.repository';
import type { CheckedAccessStatus, HealthOs } from '@/features/sleep-record/sleep-record.types';
import { logger } from '@/lib/logger';

type Request = { os: HealthOs; requestId: string };

/** `run` が失敗したら `name` の error ログを出し、同じエラーを投げ直す */
async function logFailure<T>(name: string, requestId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.error(name, { requestId, err });
    throw err;
  }
}

/** 連携状態を取得する（失敗は store が `checkFailed` にする） */
export function checkAccess(input: Request): Promise<CheckedAccessStatus> {
  return logFailure('sleepRecord.checkAccess', input.requestId, () =>
    getHealthRepository(input.os).getAccessStatus(),
  );
}

/** 許可を求める。例外なく終われば成功とする（要求後の連携状態は、続く `sync()` の中で取得する） */
export async function requestAccess(input: Request): Promise<void> {
  await logFailure('sleepRecord.requestAccess', input.requestId, () =>
    getHealthRepository(input.os).requestAccess(),
  );
  logger.info('sleepRecord.requestAccess', { requestId: input.requestId });
}

/** 設定を開く（Android だけ。iOS ではリポジトリが例外を投げる） */
export function openSettings(input: Request): Promise<void> {
  return logFailure('sleepRecord.openSettings', input.requestId, () =>
    getHealthRepository(input.os).openSettings(),
  );
}
