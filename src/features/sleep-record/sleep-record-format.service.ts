// 表示用の整形（01 の設計書 3.4、02 の設計書 3.1「表示」）。純粋関数
import {
  CHART_AXIS_START_HOUR,
  type ChartDayValue,
  type Period,
  type PeriodKind,
} from '@/features/sleep-record/sleep-record.types';

const DAY_MINUTES = 24 * 60;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 分を「7時間32分」「45分」にする（1時間以上なら分が0でも「1時間0分」） */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}時間${rest}分` : `${rest}分`;
}

/** UNIX ミリ秒を端末のタイムゾーンの「23:14」「0:05」にする（時は0埋めなし、分は2桁） */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 帰属日 `YYYY-MM-DD` を「11月25日（水）」にする。現在日（`now` の端末のタイムゾーンでの年）以外の年なら「2025年11月25日（火）」 */
export function formatDate(wakeDate: string, now: Date): string {
  const [year, month, day] = wakeDate.split('-').map(Number);
  // 曜日は暦の上の日付で決まるため、タイムゾーンの影響を受けない UTC で求める
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const monthDay = `${month}月${day}日（${weekday}）`;
  return year === now.getFullYear() ? monthDay : `${year}年${monthDay}`;
}

/** 期間の見出し：週「11月23日（月）〜11月29日（日）」（両端とも今年以外は年を付ける）、月「2026年11月」（設計書 02 の 3.1） */
export function formatPeriodTitle(period: Period, now: Date): string {
  if (period.kind === 'week') {
    return `${formatDate(period.start, now)}〜${formatDate(period.end, now)}`;
  }
  const [year, month] = period.start.split('-').map(Number);
  return `${year}年${month}月`;
}

/** 軸の分（帰属日の前日 18:00 からの分）を時刻「23:30」にする。0 未満・1440 より大きい値も時刻になる */
export function formatAxisClock(offset: number): string {
  const minutesOfDay =
    (((CHART_AXIS_START_HOUR * 60 + offset) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${Math.floor(minutesOfDay / 60)}:${String(minutesOfDay % 60).padStart(2, '0')}`;
}

/**
 * 日ごとのボタンの読み上げの説明：「11月25日（水） 睡眠 7時間42分 就寝 23:14 起床 6:46」、
 * 睡眠のない日・未来の日は「11月26日（木） 睡眠データなし」
 */
export function formatDayLabel(wakeDate: string, value: ChartDayValue | null, now: Date): string {
  const date = formatDate(wakeDate, now);
  if (value === null) return `${date} 睡眠データなし`;
  return `${date} 睡眠 ${formatMinutes(value.asleepMinutes)} 就寝 ${formatAxisClock(value.bedOffset)} 起床 ${formatAxisClock(value.wakeOffset)}`;
}

/** グラフの日付の文字：週は「25（水）」、月は「25」 */
export function formatChartDate(wakeDate: string, kind: PeriodKind): string {
  const [year, month, day] = wakeDate.split('-').map(Number);
  if (kind === 'month') return String(day);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${day}（${weekday}）`;
}
