import { axisOffset } from '@/features/sleep-record/sleep-record-chart.service';
import {
  formatAxisClock,
  formatChartDate,
  formatDate,
  formatDayLabel,
  formatMinutes,
  formatPeriodTitle,
  formatTime,
} from '@/features/sleep-record/sleep-record-format.service';

describe('formatMinutes', () => {
  // T066
  it.each([
    [452, '7時間32分'],
    [60, '1時間0分'],
    [59, '59分'],
    [45, '45分'],
    [0, '0分'],
  ])('%i 分は「%s」', (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });
});

describe('formatTime', () => {
  // T067（TZ は jest の globalSetup で Asia/Tokyo に固定）
  it.each([
    ['2026-11-24T23:14:00+09:00', '23:14'],
    ['2026-11-25T00:05:00+09:00', '0:05'],
    ['2026-11-25T09:00:00+09:00', '9:00'],
  ])('%s は「%s」', (iso, expected) => {
    expect(formatTime(new Date(iso).getTime())).toBe(expected);
  });
});

describe('formatDate', () => {
  // 現在日は端末のタイムゾーン（JST）の0時ちょうど。UTC ではまだ前日なので、UTC で年を見る誤りも検出する
  const today = (date: string) => new Date(`${date}T00:00:00+09:00`);

  // T068
  it.each([
    ['2026-11-25', '11月25日（水）'],
    ['2025-11-25', '2025年11月25日（火）'],
  ])('現在日 2026-11-25 で %s は「%s」', (wakeDate, expected) => {
    expect(formatDate(wakeDate, today('2026-11-25'))).toBe(expected);
  });

  // T069
  it.each([
    ['2026-12-31', '2026-12-31', '12月31日（木）'],
    ['2026-12-31', '2027-01-01', '2027年1月1日（金）'],
    ['2027-01-01', '2026-12-31', '2026年12月31日（木）'],
    ['2027-01-01', '2027-01-01', '1月1日（金）'],
  ])('現在日 %s で %s は「%s」', (date, wakeDate, expected) => {
    expect(formatDate(wakeDate, today(date))).toBe(expected);
  });
});

/** JST の現在日 */
const nowOn = (date: string) => new Date(`${date}T12:00:00+09:00`);
/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jstAt = (local: string) =>
  new Date(`${local.length === 16 ? `${local}:00` : local}+09:00`).getTime();

describe('formatPeriodTitle', () => {
  // T019
  it.each([
    ['今年の週', '2026-11-23', '2026-11-29', '2026-11-25', '11月23日（月）〜11月29日（日）'],
    [
      '前の年から今年にまたがる週',
      '2025-12-29',
      '2026-01-04',
      '2026-11-25',
      '2025年12月29日（月）〜1月4日（日）',
    ],
    [
      '両端とも今年でない週',
      '2025-12-29',
      '2026-01-04',
      '2027-01-05',
      '2025年12月29日（月）〜2026年1月4日（日）',
    ],
    [
      '今年から翌年にまたがる週',
      '2026-12-28',
      '2027-01-03',
      '2026-11-25',
      '12月28日（月）〜2027年1月3日（日）',
    ],
  ])('%s', (_label, start, end, today, expected) => {
    expect(formatPeriodTitle({ kind: 'week', start, end }, nowOn(today))).toBe(expected);
  });

  // T020
  it('月は「2026年11月」', () => {
    expect(
      formatPeriodTitle(
        { kind: 'month', start: '2026-11-01', end: '2026-11-30' },
        nowOn('2026-11-25'),
      ),
    ).toBe('2026年11月');
  });
});

describe('formatAxisClock', () => {
  // T021
  it.each([
    [0, '18:00'],
    [360, '0:00'],
    [766, '6:46'],
    [314, '23:14'],
    [390, '0:30'],
    [-120, '16:00'],
    [-61, '16:59'],
    [1440, '18:00'],
    [1441, '18:01'],
    [1500, '19:00'],
    [1100, '12:20'],
  ])('軸の分 %i は「%s」', (offset, expected) => {
    expect(formatAxisClock(offset)).toBe(expected);
  });
});

describe('formatDayLabel', () => {
  /** 帰属日の値（就寝・起床は JST の日時から軸の分にする） */
  const value = (wakeDate: string, minutes: number, bed: string, wake: string) => ({
    asleepMinutes: minutes,
    barMinutes: Math.min(minutes, 720),
    bedOffset: axisOffset(wakeDate, jstAt(bed)),
    wakeOffset: axisOffset(wakeDate, jstAt(wake)),
    band: null,
  });

  // T022
  it.each([
    [
      '睡眠のある日',
      '2026-11-25',
      value('2026-11-25', 462, '2026-11-24T23:14', '2026-11-25T06:46'),
      '11月25日（水） 睡眠 7時間42分 就寝 23:14 起床 6:46',
    ],
    ['睡眠のない日', '2026-11-26', null, '11月26日（木） 睡眠データなし'],
    [
      '縦軸の範囲の外で帯なしの日',
      '2026-11-25',
      value('2026-11-25', 240, '2026-11-25T19:00', '2026-11-25T23:00'),
      '11月25日（水） 睡眠 4時間0分 就寝 19:00 起床 23:00',
    ],
    [
      '秒を含む日（秒以下は切り捨て。01 の詳細の「23:14〜6:46」とそろう）',
      '2026-11-25',
      value('2026-11-25', 432, '2026-11-24T23:14:59', '2026-11-25T06:46:30'),
      '11月25日（水） 睡眠 7時間12分 就寝 23:14 起床 6:46',
    ],
  ])('%s', (_label, wakeDate, dayValue, expected) => {
    expect(formatDayLabel(wakeDate, dayValue, nowOn('2026-11-25'))).toBe(expected);
  });

  // T023
  it('今年以外の日は年を付ける', () => {
    expect(formatDayLabel('2026-11-25', null, nowOn('2027-01-05'))).toBe(
      '2026年11月25日（水） 睡眠データなし',
    );
  });
});

describe('formatChartDate', () => {
  // T024
  it.each([
    ['week', '2026-11-25', '25（水）'],
    ['month', '2026-11-25', '25'],
    ['month', '2026-11-01', '1'],
    ['week', '2026-11-29', '29（日）'],
  ] as const)('%s 表示の %s は「%s」', (kind, wakeDate, expected) => {
    expect(formatChartDate(wakeDate, kind)).toBe(expected);
  });
});
