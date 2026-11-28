import {
  effectiveBedtime,
  nowCandidates,
  resolveBedtime,
  resolveWakeTime,
  wakeCandidates,
} from '@/features/smart-alarm/smart-alarm-candidate.service';
import type { AlarmCandidate, CycleParams } from '@/features/smart-alarm/smart-alarm.types';

/** JST の日時（`2026-11-27T23:00` または `2026-11-27T23:00:40` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local}${local.length === 16 ? ':00' : ''}+09:00`).getTime();

const STANDARD: CycleParams = {
  onsetMinutes: 14,
  onsetSource: { kind: 'standard', missingDays: 14 },
  cycleMinutes: 90,
  cycleSource: { kind: 'standard', missingDays: 14 },
};

/** 候補を [JST の時刻, 種類] の形にして比べやすくする */
const summary = (list: AlarmCandidate[]) =>
  list.map((c) => [
    new Date(c.at).toISOString(),
    c.kind === 'cycle' ? c.cycles : 'desired',
    c.minutesFromBase,
  ]);
const iso = (local: string) => new Date(jst(local)).toISOString();

describe('nowCandidates（今から寝る）', () => {
  // T030
  it('今を分に切り捨て、4・5・6サイクル目の区切りを早い順に出す（秒は 0、基準からの分つき）', () => {
    expect(summary(nowCandidates(jst('2026-11-27T23:00:40'), STANDARD))).toEqual([
      [iso('2026-11-28T05:14'), 4, 374],
      [iso('2026-11-28T06:44'), 5, 464],
      [iso('2026-11-28T08:14'), 6, 554],
    ]);
  });

  // T031
  it('実績の値（入眠 8・サイクル 95）でも計算が合う', () => {
    const params = { ...STANDARD, onsetMinutes: 8, cycleMinutes: 95 };
    expect(summary(nowCandidates(jst('2026-11-27T22:00'), params)).map((c) => c[0])).toEqual([
      iso('2026-11-28T04:28'),
      iso('2026-11-28T06:03'),
      iso('2026-11-28T07:38'),
    ]);
  });
});

describe('resolveBedtime・resolveWakeTime（日付を決める）', () => {
  // T032
  it.each([
    [22, 30, '2026-11-27T22:30'],
    [22, 0, '2026-11-28T22:00'],
    [23, 15, '2026-11-27T23:15'],
  ])('今 22:30:40 に就寝予定 %i:%i → %s', (hour, minute, expected) => {
    expect(resolveBedtime(jst('2026-11-27T22:30:40'), hour, minute)).toBe(jst(expected));
  });

  // T033
  it.each([
    [7, 0, '2026-11-28T07:00'],
    [22, 30, '2026-11-28T22:30'],
    [23, 0, '2026-11-27T23:00'],
  ])('就寝予定 22:30 に起きたい時刻 %i:%i → %s', (hour, minute, expected) => {
    expect(resolveWakeTime(jst('2026-11-27T22:30'), hour, minute)).toBe(jst(expected));
  });
});

describe('effectiveBedtime（選んだ就寝予定時刻の扱い）', () => {
  // T038
  it.each([
    ['2026-11-27T22:00:59', '2026-11-27T22:00'],
    ['2026-11-27T22:01:00', '2026-11-27T22:01'],
    ['2026-11-27T21:50:00', '2026-11-27T22:00'],
  ])('選んだ 22:00 に今 %s → %s', (now, expected) => {
    expect(effectiveBedtime(jst(now), jst('2026-11-27T22:00'))).toBe(jst(expected));
  });

  it('選んでいなければ今を分に切り捨てた時刻', () => {
    expect(effectiveBedtime(jst('2026-11-27T22:30:40'), null)).toBe(jst('2026-11-27T22:30'));
  });
});

describe('wakeCandidates（起床時刻を指定）', () => {
  const bed = jst('2026-11-27T22:30');

  // T034
  it('希望時刻より前の区切りの遅い順に2つと希望時刻を、早い順に出す', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T07:00'), STANDARD))).toEqual([
      [iso('2026-11-28T04:44'), 4, 374],
      [iso('2026-11-28T06:14'), 5, 464],
      [iso('2026-11-28T07:00'), 'desired', 510],
    ]);
  });

  // T035
  it('区切りが希望時刻と同じ分ならまとめ、その前から2つ出す', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T06:14'), STANDARD))).toEqual([
      [iso('2026-11-28T03:14'), 3, 284],
      [iso('2026-11-28T04:44'), 4, 374],
      [iso('2026-11-28T06:14'), 'desired', 464],
    ]);
  });

  // T036
  it('区切りが1つだけなら、1サイクル目と希望時刻', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T00:30'), STANDARD))).toEqual([
      [iso('2026-11-28T00:14'), 1, 104],
      [iso('2026-11-28T00:30'), 'desired', 120],
    ]);
  });

  // T037
  it('区切りがなければ希望時刻だけ', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T00:10'), STANDARD))).toEqual([
      [iso('2026-11-28T00:10'), 'desired', 100],
    ]);
  });

  // T039
  it('区切りが希望時刻の1分前ならまとめない', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T06:15'), STANDARD))).toEqual([
      [iso('2026-11-28T04:44'), 4, 374],
      [iso('2026-11-28T06:14'), 5, 464],
      [iso('2026-11-28T06:15'), 'desired', 465],
    ]);
  });

  // T057
  it('1サイクル目の区切りが希望時刻と同じ分なら、希望時刻だけ', () => {
    expect(summary(wakeCandidates(bed, jst('2026-11-28T00:14'), STANDARD))).toEqual([
      [iso('2026-11-28T00:14'), 'desired', 104],
    ]);
  });
});
