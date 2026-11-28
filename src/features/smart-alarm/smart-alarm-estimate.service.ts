// 主睡眠の一覧から、入眠時間とサイクル長の使う値を決める（設計書 docs/features/03_smart-alarm.md の 3.1「入眠時間とサイクル長の推定」）。純粋関数
import type { SleepSession, StageInterval } from '@/features/sleep-record/sleep-record.types';
import {
  CYCLE_MAX_MINUTES,
  CYCLE_MIN_MINUTES,
  MAX_ONSET_MS,
  REM_MERGE_GAP_MS,
  REQUIRED_DAYS,
  STANDARD_CYCLE_MINUTES,
  STANDARD_ONSET_MINUTES,
  type CycleParams,
  type ParamSource,
} from '@/features/smart-alarm/smart-alarm.types';

const MINUTE_MS = 60 * 1000;

/** 開始の早い順に並べ直した区間 */
const byStart = (stages: StageInterval[]) => [...stages].sort((a, b) => a.startAt - b.startAt);

/**
 * その日の入眠時間（分、切り捨て）：就寝から、開始が最も早い覚醒以外の区間の開始まで。
 * 切り捨て前で60分を超える日・覚醒以外の区間がない日は値なし（`null`）
 */
export function onsetMinutesOf(session: SleepSession): number | null {
  const first = byStart(session.stages).find((s) => s.stage !== 'awake');
  if (first === undefined) return null;
  const latencyMs = first.startAt - session.startAt;
  if (latencyMs > MAX_ONSET_MS) return null;
  return Math.floor(latencyMs / MINUTE_MS);
}

/**
 * その日のサイクル長（分）：レム期（空きが30分未満のレムをつないだもの）の終わりどうしの間隔（分、切り捨て）のうち、
 * 60〜150分のものの中央値。残る間隔がなければ値なし（`null`）
 */
export function cycleMinutesOf(session: SleepSession): number | null {
  const episodeEnds: number[] = [];
  for (const rem of byStart(session.stages).filter((s) => s.stage === 'rem')) {
    const last = episodeEnds.length - 1;
    if (last >= 0 && rem.startAt - episodeEnds[last] < REM_MERGE_GAP_MS) {
      episodeEnds[last] = Math.max(episodeEnds[last], rem.endAt);
    } else {
      episodeEnds.push(rem.endAt);
    }
  }
  const intervals = episodeEnds
    .slice(1)
    .map((end, i) => Math.floor((end - episodeEnds[i]) / MINUTE_MS))
    .filter((m) => m >= CYCLE_MIN_MINUTES && m <= CYCLE_MAX_MINUTES);
  return median(intervals);
}

/**
 * 使う値：ステージありの主睡眠のうち、その日の値がある日が14日以上なら中央値（実績）、足りなければ標準値。
 * 入眠時間とサイクル長は別々に決める
 */
export function estimateCycleParams(sessions: SleepSession[]): CycleParams {
  const staged = sessions.filter((s) => s.hasStages);
  const onset = decide(staged.map(onsetMinutesOf), STANDARD_ONSET_MINUTES);
  const cycle = decide(staged.map(cycleMinutesOf), STANDARD_CYCLE_MINUTES);
  return {
    onsetMinutes: onset.value,
    onsetSource: onset.source,
    cycleMinutes: cycle.value,
    cycleSource: cycle.source,
  };
}

/** 標準値だけの使う値（推定の元データを読めなかったときに使う） */
export function standardCycleParams(): CycleParams {
  return estimateCycleParams([]);
}

/** 日ごとの値（値なしは `null`）から、使う値と出どころを決める */
function decide(
  dailyValues: (number | null)[],
  standard: number,
): { value: number; source: ParamSource } {
  const values = dailyValues.filter((v): v is number => v !== null);
  if (values.length >= REQUIRED_DAYS) {
    return { value: median(values) as number, source: { kind: 'estimated' } };
  }
  return {
    value: standard,
    source: { kind: 'standard', missingDays: REQUIRED_DAYS - values.length },
  };
}

/** 中央値。偶数個なら真ん中2つの平均を `Math.round` で四捨五入する。空なら `null` */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
