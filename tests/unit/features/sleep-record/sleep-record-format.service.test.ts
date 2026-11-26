import {
  formatDate,
  formatMinutes,
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
