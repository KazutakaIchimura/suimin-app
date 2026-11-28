// 使う値と時刻から、アラームの候補を作る。就寝予定時刻・希望時刻の日付を決める
// （設計書 docs/features/03_smart-alarm.md の 3.1「候補の計算」）。純粋関数。時刻は端末のタイムゾーンで扱う
import type { AlarmCandidate, CycleParams } from '@/features/smart-alarm/smart-alarm.types';

const MINUTE_MS = 60 * 1000;

/** 今から寝るで出すサイクル数 */
const NOW_CYCLES = [4, 5, 6] as const;
/** 起床時刻を指定で、希望時刻より前に出す区切りの最大数 */
const MAX_BOUNDARIES_BEFORE_DESIRED = 2;

/** 分に切り捨てた時刻 */
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** 基準から n サイクル目の区切り（秒以下は切り捨て） */
const boundaryAt = (base: number, params: CycleParams, cycles: number) =>
  floorToMinute(base + (params.onsetMinutes + params.cycleMinutes * cycles) * MINUTE_MS);

/** 基準（分に切り捨て）から候補までの分 */
const minutesBetween = (base: number, at: number) =>
  Math.round((at - floorToMinute(base)) / MINUTE_MS);

/** 今から寝る：4・5・6サイクル目の区切り（早い順） */
export function nowCandidates(now: number, params: CycleParams): AlarmCandidate[] {
  const base = floorToMinute(now);
  return NOW_CYCLES.map((cycles) => {
    const at = boundaryAt(base, params, cycles);
    return { kind: 'cycle', cycles, at, minutesFromBase: minutesBetween(base, at) };
  });
}

/** `from` 以降（`inclusive` が偽なら `from` より後）で最も近い、その時と分の時刻 */
function nextTimeOfDay(from: number, hour: number, minute: number, inclusive: boolean): number {
  const date = new Date(from);
  date.setHours(hour, minute, 0, 0);
  if (inclusive ? date.getTime() < from : date.getTime() <= from) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

/** 就寝予定時刻：今（分に切り捨て）以降で最も近い、その時と分の時刻 */
export function resolveBedtime(now: number, hour: number, minute: number): number {
  return nextTimeOfDay(floorToMinute(now), hour, minute, true);
}

/** 希望時刻：就寝予定時刻より後で最も近い、その時と分の時刻（同じ時と分なら24時間後） */
export function resolveWakeTime(bedtime: number, hour: number, minute: number): number {
  return nextTimeOfDay(bedtime, hour, minute, false);
}

/**
 * 使う就寝予定時刻：選んだ時刻（`chosen`）が今（分に切り捨て）より前になったら、今に戻る。
 * 選んでいなければ今（分に切り捨て）
 */
export function effectiveBedtime(now: number, chosen: number | null): number {
  const current = floorToMinute(now);
  return chosen !== null && chosen >= current ? chosen : current;
}

/**
 * 起床時刻を指定：希望時刻と、希望時刻より前の区切りのうち遅い順に最大2つを、早い順に。
 * 区切りが希望時刻と同じ分なら、希望時刻にまとめる
 */
export function wakeCandidates(
  bedtime: number,
  wake: number,
  params: CycleParams,
): AlarmCandidate[] {
  const base = floorToMinute(bedtime);
  const desiredAt = floorToMinute(wake);
  const boundaries: AlarmCandidate[] = [];
  for (let cycles = 1; boundaryAt(base, params, cycles) < desiredAt; cycles += 1) {
    const at = boundaryAt(base, params, cycles);
    boundaries.push({ kind: 'cycle', cycles, at, minutesFromBase: minutesBetween(base, at) });
  }
  return [
    ...boundaries.slice(-MAX_BOUNDARIES_BEFORE_DESIRED),
    { kind: 'desired', at: desiredAt, minutesFromBase: minutesBetween(base, desiredAt) },
  ];
}
