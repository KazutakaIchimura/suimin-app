// グラフの日ごとの値と平均（設計書 docs/features/02_sleep-chart.md の 3.1「日ごとの値」「時刻の縦軸」「平均」）。純粋関数
import {
  CHART_AXIS_MINUTES,
  CHART_AXIS_START_HOUR,
  CHART_BAR_MAX_MINUTES,
  type ChartAverage,
  type ChartBand,
  type ChartDay,
  type ChartDayValue,
  type DaySummary,
  type Period,
} from '@/features/sleep-record/sleep-record.types';

const MINUTE_MS = 60 * 1000;

/**
 * 軸の分：帰属日 `wakeDate` の前日 18:00（端末のタイムゾーン）からの分。範囲の外は 0 未満・1440 より大きい値になる
 */
export function axisOffset(wakeDate: string, ms: number): number {
  const [y, m, d] = wakeDate.split('-').map(Number);
  const base = new Date(y, m - 1, d - 1, CHART_AXIS_START_HOUR, 0).getTime();
  return Math.floor((ms - base) / MINUTE_MS);
}

/** 帯を描く範囲 0〜1440 に切る。切ると長さが0になるなら `null`（描かない） */
function toBand(bedOffset: number, wakeOffset: number): ChartBand | null {
  const from = Math.max(0, bedOffset);
  const to = Math.min(CHART_AXIS_MINUTES, wakeOffset);
  return to > from ? { from, to } : null;
}

/** 期間の日の上限（最も長い月の日数） */
const MAX_PERIOD_DAYS = 31;

/**
 * 期間の日（最初の日〜最後の日）を順に並べる。期間の値が壊れていても止まるように、並べるのは31日まで
 * （最後の日に届かなければ31日で止め、最後の日が最初の日より前なら最初の日だけ）
 */
function datesOf(period: Period): string[] {
  const dates: string[] = [];
  let at = Date.parse(`${period.start}T00:00:00Z`);
  while (dates.length < MAX_PERIOD_DAYS) {
    const date = new Date(at).toISOString().slice(0, 10);
    dates.push(date);
    if (date >= period.end) break;
    at += 24 * 60 * MINUTE_MS;
  }
  return dates;
}

/**
 * 期間の日ごとの値。睡眠のない日と、今日より後の日（睡眠があっても）は値なし
 */
export function buildChartDays(summaries: DaySummary[], period: Period, today: string): ChartDay[] {
  const byDate = new Map(summaries.map((s) => [s.wakeDate, s]));
  return datesOf(period).map((wakeDate) => {
    const day = byDate.get(wakeDate);
    if (!day || wakeDate > today) return { wakeDate, value: null };
    const bedOffset = axisOffset(wakeDate, day.mainStartAt);
    const wakeOffset = axisOffset(wakeDate, day.mainEndAt);
    return {
      wakeDate,
      value: {
        asleepMinutes: day.totalAsleepMinutes,
        barMinutes: Math.min(day.totalAsleepMinutes, CHART_BAR_MAX_MINUTES),
        bedOffset,
        wakeOffset,
        band: toBand(bedOffset, wakeOffset),
      },
    };
  });
}

/** `Math.round` で四捨五入し、`-0` は `0` に正す */
function roundMinutes(x: number): number {
  return Math.round(x) || 0;
}

/**
 * 期間の平均。睡眠のある日（値のある日）だけで計算する。値のある日がなければ `null`。
 * 就寝・起床は軸の分（前日 18:00 から）で平均するので、0時の前後の就寝も正しく平均できる
 */
export function chartAverage(days: ChartDay[]): ChartAverage | null {
  const values = days.flatMap((d) => (d.value ? [d.value] : []));
  if (values.length === 0) return null;
  const mean = (pick: (v: ChartDayValue) => number) =>
    roundMinutes(values.reduce((sum, v) => sum + pick(v), 0) / values.length);
  return {
    asleepMinutes: mean((v) => v.asleepMinutes),
    bedOffset: mean((v) => v.bedOffset),
    wakeOffset: mean((v) => v.wakeOffset),
  };
}
