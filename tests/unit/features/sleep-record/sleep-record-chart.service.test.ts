import {
  axisOffset,
  buildChartDays,
  chartAverage,
} from '@/features/sleep-record/sleep-record-chart.service';
import { formatAxisClock, formatTime } from '@/features/sleep-record/sleep-record-format.service';
import type { DaySummary, Period } from '@/features/sleep-record/sleep-record.types';

/** JST の日時（`2026-11-24T23:00`、秒を含むときは `2026-11-24T23:14:59` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local.length === 16 ? `${local}:00` : local}+09:00`).getTime();

const TODAY = '2026-11-25';
const WEEK: Period = { kind: 'week', start: '2026-11-23', end: '2026-11-29' };

/** 日ごとの要約1件（主睡眠の就寝・起床は JST の日時で渡す） */
function summary(wakeDate: string, minutes: number, bed: string, wake: string): DaySummary {
  return {
    wakeDate,
    totalAsleepMinutes: minutes,
    mainStartAt: jst(bed),
    mainEndAt: jst(wake),
    napCount: 0,
  };
}

/** 前日 17:00〜当日 6:00 の要約（13時間の枠なので、睡眠時間 721分も入る） */
function night(wakeDate: string, minutes: number): DaySummary {
  const prev = new Date(
    Date.parse(`${wakeDate}T00:00:00+09:00`) - 24 * 3600 * 1000 + 9 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  return summary(wakeDate, minutes, `${prev}T17:00`, `${wakeDate}T06:00`);
}

const valueOf = (days: ReturnType<typeof buildChartDays>, date: string) =>
  days.find((d) => d.wakeDate === date)?.value;

describe('buildChartDays', () => {
  // T011
  it('週の7日が順に並び、睡眠のある過去の日だけ値が入る（期間の外・未来の日は入らない）', () => {
    const summaries = [
      summary('2026-11-27', 400, '2026-11-26T23:00', '2026-11-27T06:00'),
      summary('2026-11-25', 462, '2026-11-24T23:14', '2026-11-25T06:46'),
      summary('2026-11-17', 420, '2026-11-17T00:30', '2026-11-17T07:30'),
      summary('2026-11-24', 420, '2026-11-23T23:00', '2026-11-24T06:00'),
    ];

    const days = buildChartDays(summaries, WEEK, TODAY);

    expect(days.map((d) => d.wakeDate)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
    ]);
    expect(valueOf(days, '2026-11-24')).toEqual({
      asleepMinutes: 420,
      barMinutes: 420,
      bedOffset: 300,
      wakeOffset: 720,
      band: { from: 300, to: 720 },
    });
    expect(valueOf(days, '2026-11-25')).toEqual({
      asleepMinutes: 462,
      barMinutes: 462,
      bedOffset: 314,
      wakeOffset: 766,
      band: { from: 314, to: 766 },
    });
    for (const date of ['2026-11-23', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']) {
      expect(valueOf(days, date)).toBeNull();
    }
  });

  // T045
  it('期間の最初と最後の日に値が入り、前の日・次の日は入らない', () => {
    const summaries = ['2026-11-15', '2026-11-16', '2026-11-22', '2026-11-23'].map((d) =>
      night(d, 420),
    );

    const days = buildChartDays(
      summaries,
      { kind: 'week', start: '2026-11-16', end: '2026-11-22' },
      TODAY,
    );

    expect(days.map((d) => [d.wakeDate, d.value !== null])).toEqual([
      ['2026-11-16', true],
      ['2026-11-17', false],
      ['2026-11-18', false],
      ['2026-11-19', false],
      ['2026-11-20', false],
      ['2026-11-21', false],
      ['2026-11-22', true],
    ]);
  });

  // T012
  it.each([
    ['2026年11月', { kind: 'month', start: '2026-11-01', end: '2026-11-30' }, 30],
    ['2028年2月', { kind: 'month', start: '2028-02-01', end: '2028-02-29' }, 29],
    ['2026年2月', { kind: 'month', start: '2026-02-01', end: '2026-02-28' }, 28],
    ['2026年10月', { kind: 'month', start: '2026-10-01', end: '2026-10-31' }, 31],
  ] as const)('%s は日が順に並ぶ', (_label, period, count) => {
    const days = buildChartDays([], period, '2028-12-31');

    expect(days).toHaveLength(count);
    expect(days[0].wakeDate).toBe(period.start);
    expect(days.at(-1)?.wakeDate).toBe(period.end);
  });

  // T050
  it.each([
    ['①形は正しいが32日ある', '2026-12-02', 31, '2026-12-01'],
    ['②最後の日が日付の形でない', 'abc', 31, '2026-12-01'],
    ['③最後の日が最初の日より前', '2026-10-01', 1, '2026-11-01'],
  ])('期間の値が壊れていても止まる：%s', (_label, end, count, last) => {
    const days = buildChartDays([], { kind: 'month', start: '2026-11-01', end }, TODAY);

    expect(days).toHaveLength(count);
    expect(days[0].wakeDate).toBe('2026-11-01');
    expect(days.at(-1)?.wakeDate).toBe(last);
    expect(days.every((d) => d.value === null)).toBe(true);
  });

  // T013
  it('棒は 0〜720分で切り、睡眠時間は切らない', () => {
    const days = buildChartDays(
      [night('2026-11-23', 1), night('2026-11-24', 720), night('2026-11-25', 721)],
      WEEK,
      TODAY,
    );

    expect(['2026-11-23', '2026-11-24', '2026-11-25'].map((d) => valueOf(days, d))).toEqual([
      expect.objectContaining({ asleepMinutes: 1, barMinutes: 1 }),
      expect.objectContaining({ asleepMinutes: 720, barMinutes: 720 }),
      expect.objectContaining({ asleepMinutes: 721, barMinutes: 720 }),
    ]);
  });
});

describe('軸の分と帯', () => {
  /** 帰属日 2026-11-25 の主睡眠1件の値 */
  const valueFor = (bed: string, wake: string) =>
    valueOf(buildChartDays([summary('2026-11-25', 60, bed, wake)], WEEK, TODAY), '2026-11-25');

  // T014
  it.each([
    [
      '前日 18:00〜当日 18:00',
      '2026-11-24T18:00',
      '2026-11-25T18:00',
      0,
      1440,
      { from: 0, to: 1440 },
    ],
    ['23:14〜6:46', '2026-11-24T23:14', '2026-11-25T06:46', 314, 766, { from: 314, to: 766 }],
    [
      '秒を含む 23:14:59〜6:46:30（秒以下は切り捨て）',
      '2026-11-24T23:14:59',
      '2026-11-25T06:46:30',
      314,
      766,
      { from: 314, to: 766 },
    ],
  ])('%s', (_label, bed, wake, bedOffset, wakeOffset, band) => {
    expect(valueFor(bed, wake)).toMatchObject({ bedOffset, wakeOffset, band });
    expect(axisOffset('2026-11-25', jst(bed))).toBe(bedOffset);
    // 軸の時刻と 01 の時刻の表示がそろう（秒を含む就寝 23:14:59 はどちらも「23:14」）
    expect(formatAxisClock(bedOffset)).toBe(formatTime(jst(bed)));
  });

  // T053
  it.each([
    [
      '月初（前日は前の月の末日）',
      '2026-12-31',
      { kind: 'month', start: '2026-12-01', end: '2026-12-31' },
      summary('2026-12-01', 420, '2026-11-30T23:00', '2026-12-01T06:00'),
      { bedOffset: 300, wakeOffset: 720, band: { from: 300, to: 720 } },
    ],
    [
      '年初（前日は前の年の末日。就寝が前日 18:00 より前）',
      '2027-01-01',
      { kind: 'month', start: '2027-01-01', end: '2027-01-31' },
      summary('2027-01-01', 420, '2026-12-31T17:00', '2027-01-01T06:00'),
      { bedOffset: -60, wakeOffset: 720, band: { from: 0, to: 720 } },
    ],
  ] as const)('%s', (_label, today, period, day, expected) => {
    const days = buildChartDays([day], period, today);

    expect(days[0].value).toMatchObject(expected);
    expect(days.slice(1).every((d) => d.value === null)).toBe(true);
  });

  // T015
  it.each([
    ['①就寝が範囲の前', '2026-11-24T16:00', '2026-11-25T06:00', -120, 720, { from: 0, to: 720 }],
    ['②起床が範囲の後', '2026-11-25T10:00', '2026-11-25T19:00', 960, 1500, { from: 960, to: 1440 }],
    ['③どちらも範囲の後', '2026-11-25T19:00', '2026-11-25T23:00', 1500, 1740, null],
    ['④どちらも範囲の前', '2026-11-24T12:00', '2026-11-24T17:00', -360, -60, null],
    ['⑤起床ちょうど 0', '2026-11-24T16:00', '2026-11-24T18:00', -120, 0, null],
    ['⑥就寝ちょうど 1440', '2026-11-25T18:00', '2026-11-25T20:00', 1440, 1560, null],
    ['⑦起床が 0 の1分後', '2026-11-24T16:00', '2026-11-24T18:01', -120, 1, { from: 0, to: 1 }],
    ['⑧両端がはみ出す', '2026-11-24T16:00', '2026-11-25T19:00', -120, 1500, { from: 0, to: 1440 }],
    [
      '⑨秒を含む範囲の外（秒以下は切り捨て）',
      '2026-11-24T17:59:30',
      '2026-11-25T18:00:30',
      -1,
      1440,
      { from: 0, to: 1440 },
    ],
    ['⑩秒を含む、どちらも 0 以下', '2026-11-24T17:59:30', '2026-11-24T18:00:30', -1, 0, null],
  ])('%s', (_label, bed, wake, bedOffset, wakeOffset, band) => {
    expect(valueFor(bed, wake)).toMatchObject({ bedOffset, wakeOffset, band });
  });
});

describe('chartAverage', () => {
  /** 軸の分を直接指定した、帰属日 2026-11-24 と 2026-11-25 の2日 */
  const twoDays = (a: Partial<DayValues>, b: Partial<DayValues>) =>
    chartAverage([
      { wakeDate: '2026-11-24', value: { ...base, ...a } },
      { wakeDate: '2026-11-25', value: { ...base, ...b } },
      { wakeDate: '2026-11-26', value: null },
    ]);
  type DayValues = {
    asleepMinutes: number;
    barMinutes: number;
    bedOffset: number;
    wakeOffset: number;
    band: null;
  };
  const base: DayValues = {
    asleepMinutes: 420,
    barMinutes: 420,
    bedOffset: 300,
    wakeOffset: 720,
    band: null,
  };

  // T016
  it('睡眠のある過去の日だけで平均する（値なしの日・未来の日は入らない）', () => {
    const summaries = [
      summary('2026-11-27', 400, '2026-11-26T23:00', '2026-11-27T06:00'),
      summary('2026-11-25', 462, '2026-11-24T23:14', '2026-11-25T06:46'),
      summary('2026-11-24', 420, '2026-11-23T23:00', '2026-11-24T06:00'),
    ];

    expect(chartAverage(buildChartDays(summaries, WEEK, TODAY))).toEqual({
      asleepMinutes: 441,
      bedOffset: 307,
      wakeOffset: 743,
    });
  });

  // T046
  it('明日の睡眠は平均に入らない', () => {
    const summaries = [
      summary('2026-11-25', 462, '2026-11-24T23:14', '2026-11-25T06:46'),
      summary('2026-11-26', 400, '2026-11-25T23:00', '2026-11-26T05:40'),
    ];
    const days = buildChartDays(summaries, WEEK, TODAY);

    expect(valueOf(days, '2026-11-25')).not.toBeNull();
    expect(valueOf(days, '2026-11-26')).toBeNull();
    expect(chartAverage(days)?.asleepMinutes).toBe(462);
  });

  // T017
  it.each([
    [
      '睡眠 420分と425分（422.5 → 423）',
      { asleepMinutes: 420 },
      { asleepMinutes: 425 },
      'asleepMinutes',
      423,
    ],
    ['就寝 -1 と 0（-0.5 → 0）', { bedOffset: -1 }, { bedOffset: 0 }, 'bedOffset', 0],
    [
      '就寝 23:00 と 1:00（300 と 420 → 0:00）',
      { bedOffset: 300 },
      { bedOffset: 420 },
      'bedOffset',
      360,
    ],
    [
      '就寝 -120 と 300（範囲の外も切らない）',
      { bedOffset: -120 },
      { bedOffset: 300 },
      'bedOffset',
      90,
    ],
    [
      '起床 1500 と 700（範囲の外も切らない）',
      { wakeOffset: 1500 },
      { wakeOffset: 700 },
      'wakeOffset',
      1100,
    ],
  ] as const)('%s', (_label, a, b, key, expected) => {
    const average = twoDays(a, b);

    // toBe は -0 と 0 を区別する（-0 は 0 に正す）
    expect(average?.[key]).toBe(expected);
  });

  // T048
  it('就寝は秒以下を切り捨ててから平均する', () => {
    const summaries = [
      summary('2026-11-24', 420, '2026-11-23T23:14:59', '2026-11-24T06:00'),
      summary('2026-11-25', 420, '2026-11-24T23:14:59', '2026-11-25T06:00'),
    ];

    // 切り捨てずに平均すると 314.98 → 315 になる
    expect(chartAverage(buildChartDays(summaries, WEEK, TODAY))?.bedOffset).toBe(314);
  });

  // T018
  it.each([
    ['期間に要約なし', []],
    [
      '期間の睡眠が未来の日だけ',
      [summary('2026-11-27', 400, '2026-11-26T23:00', '2026-11-27T06:00')],
    ],
  ])('%s なら平均なし', (_label, summaries) => {
    expect(chartAverage(buildChartDays(summaries, WEEK, TODAY))).toBeNull();
  });
});
