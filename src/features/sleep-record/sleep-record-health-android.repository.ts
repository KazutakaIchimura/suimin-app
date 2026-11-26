// ヘルスコネクト（Android）の読み取り（設計書 3.1「ステージの共通化」・3.3）
import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  openHealthConnectSettings,
  readRecords,
  requestPermission,
  SdkAvailabilityStatus,
  SleepStageType,
  type ReadRecordsOptions,
} from 'react-native-health-connect';

import type {
  AndroidSegment,
  CheckedAccessStatus,
  HealthReadResult,
  Stage,
} from '@/features/sleep-record/sleep-record.types';

/** ヘルスコネクトのステージ → アプリ内のステージ */
const STAGE_BY_TYPE = new Map<number, Stage>([
  [SleepStageType.AWAKE, 'awake'],
  [SleepStageType.OUT_OF_BED, 'awake'],
  [SleepStageType.LIGHT, 'light'],
  [SleepStageType.DEEP, 'deep'],
  [SleepStageType.REM, 'rem'],
  [SleepStageType.SLEEPING, 'unspecified'],
  [SleepStageType.UNKNOWN, 'unspecified'],
]);

/**
 * 読み取り期間と重なる SleepSession を全ページ読み、共通のセグメントにする。
 * ステージのない SleepSession はセッション全体を1件の `unspecified` にする。表にない値は `unspecified` にして数える
 */
export async function readSegments(period: {
  startAt: number;
  endAt: number;
}): Promise<HealthReadResult> {
  const timeRangeFilter = {
    operator: 'between',
    startTime: new Date(period.startAt).toISOString(),
    endTime: new Date(period.endAt).toISOString(),
  } as const;
  const segments: AndroidSegment[] = [];
  let unknownStageCount = 0;
  let pageToken: string | undefined;
  do {
    const options: ReadRecordsOptions = pageToken
      ? { timeRangeFilter, pageToken }
      : { timeRangeFilter };
    const page = await readRecords('SleepSession', options);
    for (const record of page.records) {
      const session = {
        os: 'android' as const,
        sessionId: record.metadata?.id,
        sourceId: record.metadata?.dataOrigin,
        sessionStartAt: Date.parse(record.startTime),
        sessionEndAt: Date.parse(record.endTime),
      };
      const stages = record.stages ?? [];
      if (stages.length === 0) {
        segments.push({
          ...session,
          stage: 'unspecified',
          startAt: session.sessionStartAt,
          endAt: session.sessionEndAt,
        });
        continue;
      }
      for (const s of stages) {
        const stage = STAGE_BY_TYPE.get(s.stage);
        if (!stage) unknownStageCount += 1;
        segments.push({
          ...session,
          stage: stage ?? 'unspecified',
          startAt: Date.parse(s.startTime),
          endAt: Date.parse(s.endTime),
        });
      }
    }
    // pageToken がない・空文字なら打ち切る
    pageToken = page.pageToken || undefined;
  } while (pageToken);
  return { segments, unknownStageCount };
}

/**
 * 連携状態。SDK がなければ `unavailable`、更新が要れば `updateRequired`、
 * 初期化のあと睡眠の読み取りが許可済みなら `ready`、未許可なら `notGranted`。
 * 表にない SDK の状態・初期化の失敗（false）は例外にする（store が `checkFailed` にする）
 */
export async function getAccessStatus(): Promise<CheckedAccessStatus> {
  const sdkStatus = await getSdkStatus();
  if (sdkStatus === SdkAvailabilityStatus.SDK_UNAVAILABLE) return 'unavailable';
  if (sdkStatus === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
    return 'updateRequired';
  }
  if (sdkStatus !== SdkAvailabilityStatus.SDK_AVAILABLE) {
    throw new Error(`Unknown Health Connect SDK status: ${sdkStatus}`);
  }
  if (!(await initialize())) throw new Error('Health Connect initialize returned false');
  const granted = await getGrantedPermissions();
  const canReadSleep = granted.some(
    (p) => 'recordType' in p && p.accessType === 'read' && p.recordType === 'SleepSession',
  );
  return canReadSleep ? 'ready' : 'notGranted';
}

/** 睡眠の読み取りの許可を求める。返る許可の一覧は判定に使わない（要求のあとは連携状態を取り直して判断する） */
export async function requestAccess(): Promise<void> {
  await requestPermission([{ accessType: 'read', recordType: 'SleepSession' }]);
}

/** ヘルスコネクトの設定を開く（2回拒否して OS の許可画面が出なくなった人が、ここから許可できるように） */
export async function openSettings(): Promise<void> {
  openHealthConnectSettings();
}
