// グラフの期間の計算（設計書 docs/features/02_sleep-chart.md の 3.1「期間」）。純粋関数。日付は `YYYY-MM-DD`
import type { Period, PeriodBounds, PeriodKind } from '@/features/sleep-record/sleep-record.types';

const DAY_MS = 24 * 60 * 60 * 1000;

// 暦の計算は UTC の日付として行う（端末のタイムゾーン・夏時間に左右されない）
function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS));
}

/** `date` を含む週（月曜〜日曜）・月（1日〜月末） */
export function periodOf(kind: PeriodKind, date: string): Period {
  const d = toUtc(date);
  if (kind === 'week') {
    // getUTCDay は日曜が 0。月曜からの日数にする
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    const start = addDays(date, -sinceMonday);
    return { kind, start, end: addDays(start, 6) };
  }
  const start = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  const end = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  return { kind, start, end };
}

/** 前（-1）・次（1）の週・月 */
export function shiftPeriod(period: Period, delta: 1 | -1): Period {
  if (period.kind === 'week') return periodOf('week', addDays(period.start, 7 * delta));
  const d = toUtc(period.start);
  return periodOf(
    'month',
    fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1))),
  );
}

/**
 * 切り替えられる範囲。前の端は、帰属日が今日以前の睡眠のうち最も古いものを含む期間、後ろの端は今日を含む期間。
 * 今日以前の睡眠がなければ（DB が空・今日より後の睡眠だけ）、今日を含む期間だけ
 */
export function periodBounds(kind: PeriodKind, wakeDates: string[], today: string): PeriodBounds {
  // `YYYY-MM-DD` は文字列の大小で日付の前後を比べられる
  const past = wakeDates.filter((d) => d <= today);
  const oldest = past.length > 0 ? past.reduce((a, b) => (a < b ? a : b)) : today;
  return { first: periodOf(kind, oldest), last: periodOf(kind, today) };
}

/** 前へ・後ろへ移れるか（範囲の端では移れない） */
export function canMove(period: Period, bounds: PeriodBounds): { prev: boolean; next: boolean } {
  return { prev: period.start > bounds.first.start, next: period.start < bounds.last.start };
}

/** 範囲の外の期間を、範囲の端の期間に収め直す */
export function clampPeriod(period: Period, bounds: PeriodBounds): Period {
  if (period.start < bounds.first.start) return bounds.first;
  if (period.start > bounds.last.start) return bounds.last;
  return period;
}

/**
 * 週と月を切り替える。表示中の期間の最初の日を含む反対の種類の期間にし、範囲の外なら範囲の端に寄せる
 */
export function togglePeriod(period: Period, wakeDates: string[], today: string): Period {
  const kind: PeriodKind = period.kind === 'week' ? 'month' : 'week';
  return clampPeriod(periodOf(kind, period.start), periodBounds(kind, wakeDates, today));
}

/** 端末のタイムゾーンでの、`now` の日付 `YYYY-MM-DD`（「今日」） */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
