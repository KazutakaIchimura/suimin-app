// HealthKit（iOS）の読み取り（設計書 3.1「ステージの共通化」・3.3）
import {
  AuthorizationRequestStatus,
  CategoryValueSleepAnalysis,
  getRequestStatusForAuthorization,
  isHealthDataAvailable,
  queryCategorySamples,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';

import type {
  CheckedAccessStatus,
  HealthReadResult,
  IosSegment,
  Stage,
} from '@/features/sleep-record/sleep-record.types';

const SLEEP_ANALYSIS = 'HKCategoryTypeIdentifierSleepAnalysis';

/** 許可の要求・確認で求める種類（睡眠の読み取りだけ。書き込みは求めない） */
const READ_ONLY_SLEEP = { toRead: [SLEEP_ANALYSIS] } as const;

/** HealthKit の値 → アプリ内のステージ。`null` は読み捨て（`inBed`） */
const STAGE_BY_VALUE = new Map<number, Stage | null>([
  [CategoryValueSleepAnalysis.inBed, null],
  [CategoryValueSleepAnalysis.asleepUnspecified, 'unspecified'],
  [CategoryValueSleepAnalysis.awake, 'awake'],
  [CategoryValueSleepAnalysis.asleepCore, 'light'],
  [CategoryValueSleepAnalysis.asleepDeep, 'deep'],
  [CategoryValueSleepAnalysis.asleepREM, 'rem'],
]);

/** 読み取り期間と重なる睡眠サンプルを全件読み、共通のセグメントにする（表にない値は `unspecified` にして数える） */
export async function readSegments(period: {
  startAt: number;
  endAt: number;
}): Promise<HealthReadResult> {
  const samples = await queryCategorySamples(SLEEP_ANALYSIS, {
    limit: 0,
    filter: { date: { startDate: new Date(period.startAt), endDate: new Date(period.endAt) } },
  });
  const segments: IosSegment[] = [];
  let unknownStageCount = 0;
  for (const sample of samples) {
    const value = Number(sample.value);
    const known = STAGE_BY_VALUE.has(value);
    const stage = known ? STAGE_BY_VALUE.get(value) : 'unspecified';
    if (!known) unknownStageCount += 1;
    if (!stage) continue;
    segments.push({
      os: 'ios',
      sampleId: sample.uuid,
      sourceId: sample.sourceRevision?.source?.bundleIdentifier,
      stage,
      startAt: sample.startDate.getTime(),
      endAt: sample.endDate.getTime(),
    });
  }
  return { segments, unknownStageCount };
}

/**
 * 連携状態。HealthKit がない端末は `unavailable`、まだ許可を求めていなければ `notRequested`、
 * それ以外は `ready`（拒否されたかは判別できない）
 */
export async function getAccessStatus(): Promise<CheckedAccessStatus> {
  if (!isHealthDataAvailable()) return 'unavailable';
  const status = await getRequestStatusForAuthorization(READ_ONLY_SLEEP);
  return status === AuthorizationRequestStatus.shouldRequest ? 'notRequested' : 'ready';
}

/**
 * 睡眠の読み取りの許可を求める。戻り値（許可の真偽）は判定に使わない
 * （false でも拒否とは限らないため。要求のあとは連携状態を取り直して判断する）
 */
export async function requestAccess(): Promise<void> {
  await requestAuthorization(READ_ONLY_SLEEP);
}

/** iOS では設定を開く案内を出さないため、呼ばれたら例外にする（3.1。store が「設定を開けませんでした」にする） */
export async function openSettings(): Promise<void> {
  throw new Error('openSettings is not supported on iOS');
}
