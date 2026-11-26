// 表示用の整形（設計書 3.4）。純粋関数

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
