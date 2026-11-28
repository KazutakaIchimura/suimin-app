// 使う値の窓口：推定の元データを 01 の読み取りの窓口で読み、推定の純粋関数で使う値にする
// （設計書 docs/features/03_smart-alarm.md の 3.1「入眠時間とサイクル長の推定」・3.3）。
// 失敗は 01 の窓口が `sleepRecord.loadMainSleeps` のログを出して投げ、受け口層が標準値と失敗の印にする
import { localDate } from '@/features/sleep-record/sleep-record-period.service';
import { loadMainSleeps } from '@/features/sleep-record/sleep-record-query.service';
import { estimateCycleParams } from '@/features/smart-alarm/smart-alarm-estimate.service';
import { ESTIMATE_RANGE_DAYS, type CycleParams } from '@/features/smart-alarm/smart-alarm.types';

/** 今日の29日前〜今日の主睡眠から、使う値を決める（今は引数で受ける） */
export function loadCycleParams(input: { now: Date; requestId: string }): CycleParams {
  const from = new Date(input.now);
  from.setDate(from.getDate() - (ESTIMATE_RANGE_DAYS - 1));
  const sessions = loadMainSleeps({
    fromWakeDate: localDate(from),
    toWakeDate: localDate(input.now),
    requestId: input.requestId,
  });
  return estimateCycleParams(sessions);
}
