import {
  cycleMinutesOf,
  estimateCycleParams,
  onsetMinutesOf,
} from '@/features/smart-alarm/smart-alarm-estimate.service';
import type {
  SleepSession,
  Stage,
  StageInterval,
} from '@/features/sleep-record/sleep-record.types';

const MIN = 60 * 1000;
const SEC = 1000;

/** JST の日時（`2026-11-27T23:00` または `2026-11-27T23:00:30` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local}${local.length === 16 ? ':00' : ''}+09:00`).getTime();

const BED = jst('2026-11-27T23:00');
const WAKE = jst('2026-11-28T06:00');

/** ステージ区間を1つ作る */
const iv = (stage: Stage, startAt: number, endAt: number): StageInterval => ({
  stage,
  startAt,
  endAt,
});

/** 就寝 23:00・帰属日 11-28 の主睡眠を、渡したステージ区間で作る */
function session(stages: StageInterval[], opts: { hasStages?: boolean; id?: string } = {}) {
  return {
    id: opts.id ?? 's1',
    sourceId: 'com.soxai',
    startAt: BED,
    endAt: WAKE,
    wakeDate: '2026-11-28',
    asleepMinutes: 400,
    hasStages: opts.hasStages ?? true,
    stages,
  } satisfies SleepSession;
}

/** 覚醒で始まり、就寝から `latencyMs` 後に浅い睡眠になる睡眠（入眠時間がその長さになる） */
function withLatency(latencyMs: number, rem: StageInterval[] = []): StageInterval[] {
  const stages: StageInterval[] = [];
  if (latencyMs > 0) stages.push(iv('awake', BED, BED + latencyMs));
  stages.push(iv('light', BED + latencyMs, rem[0]?.startAt ?? WAKE));
  return [...stages, ...rem];
}

/** レム期の終わりの間隔が `intervalMinutes` の2つのレム期（長さ20分ずつ） */
function twoRemEpisodes(intervalMinutes: number): StageInterval[] {
  const firstEnd = jst('2026-11-28T01:00');
  const secondEnd = firstEnd + intervalMinutes * MIN;
  return [
    iv('rem', firstEnd - 20 * MIN, firstEnd),
    iv('light', firstEnd, secondEnd - 20 * MIN),
    iv('rem', secondEnd - 20 * MIN, secondEnd),
  ];
}

/** 日ごとに入眠時間・サイクル長を変えた `days` 日分の主睡眠（帰属日は 11-28 から1日ずつさかのぼる） */
function days(
  count: number,
  onsetMinutes: (i: number) => number,
  cycleMinutes: (i: number) => number | null,
) {
  return Array.from({ length: count }, (_, i) => {
    const cycle = cycleMinutes(i);
    const shift = -i * 24 * 60 * MIN;
    const stages = withLatency(onsetMinutes(i) * MIN, cycle === null ? [] : twoRemEpisodes(cycle));
    return {
      ...session(
        stages.map((s) => ({ ...s, startAt: s.startAt + shift, endAt: s.endAt + shift })),
        { id: `d${i}` },
      ),
      startAt: BED + shift,
      endAt: WAKE + shift,
    };
  });
}

describe('onsetMinutesOf（その日の入眠時間）', () => {
  // T010
  it('就寝から最初の覚醒以外の区間までの分', () => {
    expect(onsetMinutesOf(session(withLatency(12 * MIN)))).toBe(12);
  });

  // T011
  it('深い睡眠から始まれば 0分', () => {
    expect(onsetMinutesOf(session([iv('deep', BED, WAKE)]))).toBe(0);
  });

  // T012
  it('`unspecified` も覚醒以外の区間で、分は切り捨てる', () => {
    const stages = [
      iv('awake', BED, BED + 5 * MIN + 30 * SEC),
      iv('unspecified', BED + 5 * MIN + 30 * SEC, WAKE),
    ];
    expect(onsetMinutesOf(session(stages))).toBe(5);
  });

  // T013
  it.each([
    ['60分0秒ちょうど', 60 * MIN, 60],
    ['60分0.001秒', 60 * MIN + 1, null],
    ['60分59秒', 60 * MIN + 59 * SEC, null],
    ['59分59秒', 59 * MIN + 59 * SEC, 59],
  ])('切り捨て前で60分以下だけ使う：%s', (_label, latencyMs, expected) => {
    expect(onsetMinutesOf(session(withLatency(latencyMs)))).toBe(expected);
  });

  // T014
  it('覚醒以外の区間が1つもなければ値なし', () => {
    expect(onsetMinutesOf(session([iv('awake', BED, WAKE)]))).toBeNull();
  });

  // T015
  it('区間が開始の順に並んでいなくても、開始が最も早い覚醒以外の区間を使う', () => {
    const stages = [
      iv('light', BED + 20 * MIN, WAKE),
      iv('awake', BED, BED + 10 * MIN),
      iv('rem', BED + 10 * MIN, BED + 20 * MIN),
    ];
    expect(onsetMinutesOf(session(stages))).toBe(10);
  });
});

describe('cycleMinutesOf（その日のサイクル長）', () => {
  // T016
  it('レム期の終わりの間隔の中央値（奇数個）', () => {
    const ends = ['01:00', '02:30', '04:10', '05:30'].map((t) => jst(`2026-11-28T${t}`));
    const stages = ends.map((end) => iv('rem', end - 20 * MIN, end));
    expect(cycleMinutesOf(session(stages))).toBe(90);
  });

  /** T017・T018・T028 のステージ区間（2つ目のレムの開始だけを変える） */
  function mergeCase(secondRemStart: string) {
    return [
      iv('rem', jst('2026-11-28T00:30'), jst('2026-11-28T01:00')),
      iv('awake', jst('2026-11-28T01:00'), jst(secondRemStart)),
      iv('rem', jst(secondRemStart), jst('2026-11-28T02:10')),
      iv('light', jst('2026-11-28T02:10'), jst('2026-11-28T03:25')),
      iv('rem', jst('2026-11-28T03:25'), jst('2026-11-28T03:45')),
    ];
  }

  // T017
  it('空きが29分59秒のレムは同じレム期につなぐ', () => {
    expect(cycleMinutesOf(session(mergeCase('2026-11-28T01:29:59')))).toBe(95);
  });

  // T018
  it('空きが30分ちょうどなら別のレム期にする', () => {
    expect(cycleMinutesOf(session(mergeCase('2026-11-28T01:30:00')))).toBe(83);
  });

  // T028
  it('レムの区間が開始の順に並んでいなくても、並べ直してからつなぐ', () => {
    const [rem1, awake, rem2, light, rem3] = mergeCase('2026-11-28T01:29:59');
    expect(cycleMinutesOf(session([rem3, light, rem1, awake, rem2]))).toBe(95);
  });

  // T019
  it.each([
    ['60分', 60 * MIN, 60],
    ['150分', 150 * MIN, 150],
    ['59分', 59 * MIN, null],
    ['59分59秒（切り捨てて59分）', 59 * MIN + 59 * SEC, null],
    ['151分', 151 * MIN, null],
    ['150分59秒（切り捨てて150分）', 150 * MIN + 59 * SEC, 150],
  ])('間隔は60分以上150分以下だけ残す：%s', (_label, intervalMs, expected) => {
    const firstEnd = jst('2026-11-28T01:00');
    const secondEnd = firstEnd + intervalMs;
    const stages = [
      iv('rem', firstEnd - 20 * MIN, firstEnd),
      iv('rem', secondEnd - 20 * MIN, secondEnd),
    ];
    expect(cycleMinutesOf(session(stages))).toBe(expected);
  });

  // T020
  it.each([
    ['レムが1区間だけ', [iv('rem', jst('2026-11-28T01:00'), jst('2026-11-28T01:30'))]],
    ['レムがない', [iv('light', BED, WAKE)]],
  ])('%sなら値なし', (_label, stages) => {
    expect(cycleMinutesOf(session(stages))).toBeNull();
  });

  // T008
  it.each([
    [[50, 90, 200], 90],
    [[90, 100, 155], 95],
  ])('範囲の外の間隔（%p）を除いてから中央値を取る', (intervals, expected) => {
    let end = jst('2026-11-28T00:30');
    const ends = [end, ...intervals.map((m) => (end += m * MIN))];
    const stages = ends.map((e) => iv('rem', e - 20 * MIN, e));
    expect(cycleMinutesOf(session(stages))).toBe(expected);
  });

  // T021
  it('間隔が偶数個なら真ん中2つの平均を四捨五入する（90 と 95 → 93）', () => {
    const ends = ['01:00', '02:30', '04:05'].map((t) => jst(`2026-11-28T${t}`));
    const stages = ends.map((end) => iv('rem', end - 20 * MIN, end));
    expect(cycleMinutesOf(session(stages))).toBe(93);
  });
});

describe('estimateCycleParams（使う値）', () => {
  // T022
  it('14日あれば実績の中央値（偶数個は真ん中2つの平均を四捨五入）、値のある日がなければ標準値', () => {
    expect(
      estimateCycleParams(
        days(
          14,
          (i) => i + 1,
          () => null,
        ),
      ),
    ).toEqual({
      onsetMinutes: 8,
      onsetSource: { kind: 'estimated' },
      cycleMinutes: 90,
      cycleSource: { kind: 'standard', missingDays: 14 },
    });
  });

  // T023
  it('15日（奇数個）なら真ん中の値', () => {
    const result = estimateCycleParams(
      days(
        15,
        (i) => i + 1,
        () => null,
      ),
    );
    expect([result.onsetMinutes, result.onsetSource]).toEqual([8, { kind: 'estimated' }]);
  });

  // T024
  it('13日なら標準値で、足りない日数は 1', () => {
    expect(
      estimateCycleParams(
        days(
          13,
          () => 10,
          () => 95,
        ),
      ),
    ).toEqual({
      onsetMinutes: 14,
      onsetSource: { kind: 'standard', missingDays: 1 },
      cycleMinutes: 90,
      cycleSource: { kind: 'standard', missingDays: 1 },
    });
  });

  // T025
  it('睡眠0件なら両方とも標準値で、足りない日数は 14', () => {
    expect(estimateCycleParams([])).toEqual({
      onsetMinutes: 14,
      onsetSource: { kind: 'standard', missingDays: 14 },
      cycleMinutes: 90,
      cycleSource: { kind: 'standard', missingDays: 14 },
    });
  });

  // T026
  it('入眠時間とサイクル長は別々に決まる', () => {
    const result = estimateCycleParams(
      days(
        14,
        () => 10,
        (i) => (i < 13 ? 95 : null),
      ),
    );
    expect(result).toEqual({
      onsetMinutes: 10,
      onsetSource: { kind: 'estimated' },
      cycleMinutes: 90,
      cycleSource: { kind: 'standard', missingDays: 1 },
    });
  });

  // T027
  it('ステージなしの主睡眠は数えない（数えれば値が出るステージを持っていても）', () => {
    const list = days(
      14,
      () => 10,
      () => 95,
    );
    list[5] = { ...list[5], hasStages: false };
    expect(estimateCycleParams(list)).toEqual({
      onsetMinutes: 14,
      onsetSource: { kind: 'standard', missingDays: 1 },
      cycleMinutes: 90,
      cycleSource: { kind: 'standard', missingDays: 1 },
    });
  });

  // T029
  it('入眠が61分の日は数えない', () => {
    const result = estimateCycleParams(
      days(
        14,
        (i) => (i === 0 ? 61 : 10),
        () => 95,
      ),
    );
    expect(result).toEqual({
      onsetMinutes: 14,
      onsetSource: { kind: 'standard', missingDays: 1 },
      cycleMinutes: 95,
      cycleSource: { kind: 'estimated' },
    });
  });

  // T054
  it('入眠 0分の日も数える', () => {
    const result = estimateCycleParams(
      days(
        14,
        () => 0,
        () => null,
      ),
    );
    expect([result.onsetMinutes, result.onsetSource]).toEqual([0, { kind: 'estimated' }]);
  });

  // T055
  it('13日が入眠 0分・1日が 61分なら標準値で、足りない日数は 1', () => {
    const result = estimateCycleParams(
      days(
        14,
        (i) => (i === 0 ? 61 : 0),
        () => null,
      ),
    );
    expect([result.onsetMinutes, result.onsetSource]).toEqual([
      14,
      { kind: 'standard', missingDays: 1 },
    ]);
  });

  // T056
  it('サイクル長が 90分7日・95分7日なら、真ん中2つの平均 92.5 を四捨五入して 93', () => {
    const result = estimateCycleParams(
      days(
        14,
        () => 10,
        (i) => (i < 7 ? 90 : 95),
      ),
    );
    expect([result.cycleMinutes, result.cycleSource]).toEqual([93, { kind: 'estimated' }]);
  });
});
