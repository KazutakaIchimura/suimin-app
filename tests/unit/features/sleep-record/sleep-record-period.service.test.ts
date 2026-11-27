import {
  canMove,
  clampPeriod,
  localDate,
  periodBounds,
  periodOf,
  shiftPeriod,
  togglePeriod,
} from '@/features/sleep-record/sleep-record-period.service';
import type { Period } from '@/features/sleep-record/sleep-record.types';

const week = (start: string, end: string): Period => ({ kind: 'week', start, end });
const month = (start: string, end: string): Period => ({ kind: 'month', start, end });

describe('periodOf', () => {
  // T002
  it.each([
    ['2026-11-25（水）', '2026-11-25', week('2026-11-23', '2026-11-29')],
    ['2026-11-23（月）', '2026-11-23', week('2026-11-23', '2026-11-29')],
    ['2026-11-29（日）', '2026-11-29', week('2026-11-23', '2026-11-29')],
    ['2026-11-01（日。月をまたぐ週）', '2026-11-01', week('2026-10-26', '2026-11-01')],
    ['2027-01-01（金。年をまたぐ週）', '2027-01-01', week('2026-12-28', '2027-01-03')],
  ])('%s を含む週は月曜〜日曜', (_label, date, expected) => {
    expect(periodOf('week', date)).toEqual(expected);
  });

  // T003
  it.each([
    ['30日の月', '2026-11-25', month('2026-11-01', '2026-11-30')],
    ['31日の月', '2026-12-31', month('2026-12-01', '2026-12-31')],
    ['うるう年の2月', '2028-02-10', month('2028-02-01', '2028-02-29')],
    ['うるう年でない2月', '2026-02-10', month('2026-02-01', '2026-02-28')],
  ])('%s：%s を含む月は1日〜月末', (_label, date, expected) => {
    expect(periodOf('month', date)).toEqual(expected);
  });
});

describe('shiftPeriod', () => {
  // T004
  it.each([
    ['週の次', week('2026-11-23', '2026-11-29'), 1, week('2026-11-30', '2026-12-06')],
    ['週の前', week('2026-11-23', '2026-11-29'), -1, week('2026-11-16', '2026-11-22')],
    ['年をまたぐ週の次', week('2026-12-28', '2027-01-03'), 1, week('2027-01-04', '2027-01-10')],
    ['12月の次', month('2026-12-01', '2026-12-31'), 1, month('2027-01-01', '2027-01-31')],
    ['1月の前', month('2026-01-01', '2026-01-31'), -1, month('2025-12-01', '2025-12-31')],
  ] as const)('%s', (_label, period, delta, expected) => {
    expect(shiftPeriod(period, delta)).toEqual(expected);
  });
});

const TODAY = '2026-11-25';

describe('periodBounds・canMove', () => {
  // T005
  it('範囲は今日以前の最も古い睡眠の週・月から今日の週・月まで', () => {
    const dates = ['2026-10-30', '2026-11-17', '2026-11-25'];

    expect(periodBounds('week', dates, TODAY)).toEqual({
      first: week('2026-10-26', '2026-11-01'),
      last: week('2026-11-23', '2026-11-29'),
    });
    expect(periodBounds('month', dates, TODAY)).toEqual({
      first: month('2026-10-01', '2026-10-31'),
      last: month('2026-11-01', '2026-11-30'),
    });
    const weeks = periodBounds('week', dates, TODAY);
    expect(canMove(week('2026-10-26', '2026-11-01'), weeks)).toEqual({ prev: false, next: true });
    expect(canMove(week('2026-11-23', '2026-11-29'), weeks)).toEqual({ prev: true, next: false });
    expect(canMove(week('2026-11-16', '2026-11-22'), weeks)).toEqual({ prev: true, next: true });
    const months = periodBounds('month', dates, TODAY);
    expect(canMove(month('2026-10-01', '2026-10-31'), months)).toEqual({ prev: false, next: true });
    expect(canMove(month('2026-11-01', '2026-11-30'), months)).toEqual({ prev: true, next: false });
  });

  // T006
  it.each([
    ['帰属日なし', []],
    ['今日より後の帰属日だけ', ['2026-11-27']],
    ['今日より後の来週の帰属日だけ', ['2026-12-02']],
  ])('%s なら、範囲は今日の週・月だけで前へも後ろへも移れない', (_label, dates) => {
    const weeks = periodBounds('week', dates, TODAY);
    const months = periodBounds('month', dates, TODAY);

    expect(weeks).toEqual({
      first: week('2026-11-23', '2026-11-29'),
      last: week('2026-11-23', '2026-11-29'),
    });
    expect(months).toEqual({
      first: month('2026-11-01', '2026-11-30'),
      last: month('2026-11-01', '2026-11-30'),
    });
    expect(canMove(weeks.first, weeks)).toEqual({ prev: false, next: false });
    expect(canMove(months.first, months)).toEqual({ prev: false, next: false });
  });

  // T044
  it('今日より後の来週・来月の睡眠があっても、後ろの端は今日の週・月', () => {
    const dates = ['2026-10-30', '2026-12-02'];

    const weeks = periodBounds('week', dates, TODAY);
    const months = periodBounds('month', dates, TODAY);

    expect(weeks).toEqual({
      first: week('2026-10-26', '2026-11-01'),
      last: week('2026-11-23', '2026-11-29'),
    });
    expect(months).toEqual({
      first: month('2026-10-01', '2026-10-31'),
      last: month('2026-11-01', '2026-11-30'),
    });
    expect(canMove(week('2026-11-23', '2026-11-29'), weeks).next).toBe(false);
    expect(canMove(month('2026-11-01', '2026-11-30'), months).next).toBe(false);
  });

  // T007
  it('前の端は今日以前の睡眠から選ぶ（今日より後の帰属日は使わない）', () => {
    expect(periodBounds('week', ['2026-11-27', '2026-11-20'], TODAY).first).toEqual(
      week('2026-11-16', '2026-11-22'),
    );
  });
});

describe('clampPeriod', () => {
  // T008
  const dates = ['2026-11-20', '2026-12-02'];
  it.each([
    ['前の端より前の週', week('2026-11-09', '2026-11-15'), week('2026-11-16', '2026-11-22')],
    ['未来の睡眠のある週', week('2026-11-30', '2026-12-06'), week('2026-11-23', '2026-11-29')],
    ['範囲の中の週', week('2026-11-16', '2026-11-22'), week('2026-11-16', '2026-11-22')],
    ['前の端より前の月', month('2026-10-01', '2026-10-31'), month('2026-11-01', '2026-11-30')],
    ['後ろの端より後の月', month('2026-12-01', '2026-12-31'), month('2026-11-01', '2026-11-30')],
    ['範囲の中の月', month('2026-11-01', '2026-11-30'), month('2026-11-01', '2026-11-30')],
  ])('%s は範囲に収め直す', (_label, period, expected) => {
    expect(clampPeriod(period, periodBounds(period.kind, dates, TODAY))).toEqual(expected);
  });
});

describe('togglePeriod', () => {
  // T009
  it.each([
    ['週 → 月', week('2026-11-23', '2026-11-29'), month('2026-11-01', '2026-11-30')],
    [
      '月 → 週（11月1日を含む週）',
      month('2026-11-01', '2026-11-30'),
      week('2026-10-26', '2026-11-01'),
    ],
  ])('%s は、表示中の期間の最初の日を含む期間になる', (_label, period, expected) => {
    expect(togglePeriod(period, ['2026-10-30', '2026-11-25'], TODAY)).toEqual(expected);
  });

  // T010
  it.each([
    [
      '最も古い睡眠が月の途中のときの 月 → 週',
      ['2026-11-20'],
      month('2026-11-01', '2026-11-30'),
      week('2026-11-16', '2026-11-22'),
    ],
    [
      '最も古い睡眠が日曜のときの 週 → 月',
      ['2026-11-01'],
      week('2026-10-26', '2026-11-01'),
      month('2026-11-01', '2026-11-30'),
    ],
  ])('%s は、範囲の外にならず範囲の端に寄せる', (_label, dates, period, expected) => {
    expect(togglePeriod(period, dates, TODAY)).toEqual(expected);
  });
});

describe('localDate', () => {
  // T052
  it.each([
    ['日本時間の 0:00', '2026-11-25T00:00:00+09:00', '2026-11-25'],
    ['日本時間の 23:59:59', '2026-11-24T23:59:59+09:00', '2026-11-24'],
    ['UTC では前日の 8:59:59', '2026-11-25T08:59:59+09:00', '2026-11-25'],
    ['月・日は0埋め', '2026-01-05T12:00:00+09:00', '2026-01-05'],
  ])('%s', (_label, at, expected) => {
    expect(localDate(new Date(at))).toBe(expected);
  });
});
