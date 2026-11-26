import {
  buildSessions,
  countValidSegments,
} from '@/features/sleep-record/sleep-record-session.service';
import type { AndroidSegment, IosSegment, Stage } from '@/features/sleep-record/sleep-record.types';

const MIN = 60 * 1000;

/**
 * 時刻を UNIX ミリ秒にする（JST）。12時以降は 2026-11-24、12時より前は 2026-11-25 とみなす
 * （例：at('23:00') は 11-24 23:00、at('1:30:00.001') は 11-25 1:30:00.001）
 */
function at(time: string): number {
  const [h, m, s = '0'] = time.split(':');
  const hour = Number(h);
  const day = hour >= 12 ? '2026-11-24' : '2026-11-25';
  const [sec, ms = '0'] = s.split('.');
  const iso = `${day}T${String(hour).padStart(2, '0')}:${m.padStart(2, '0')}:${sec.padStart(2, '0')}.${ms.padEnd(3, '0')}+09:00`;
  return new Date(iso).getTime();
}

function ios(
  sampleId: string | undefined,
  stage: Stage,
  start: string | number,
  end: string | number,
  sourceId: string | undefined = 'com.soxai',
): IosSegment {
  return {
    os: 'ios',
    sampleId,
    sourceId,
    stage,
    startAt: typeof start === 'number' ? start : at(start),
    endAt: typeof end === 'number' ? end : at(end),
  };
}

function android(
  sessionId: string | undefined,
  stage: Stage,
  start: string | number,
  end: string | number,
  session: { start: string | number; end: string | number; sourceId?: string | undefined },
): AndroidSegment {
  const toMs = (v: string | number) => (typeof v === 'number' ? v : at(v));
  return {
    os: 'android',
    sessionId,
    sourceId: 'sourceId' in session ? session.sourceId : 'com.soxai',
    sessionStartAt: toMs(session.start),
    sessionEndAt: toMs(session.end),
    stage,
    startAt: toMs(start),
    endAt: toMs(end),
  };
}

/** Android の別々の SleepSession 1件（1区間だけ）を作る。重なり排除の項目で使う */
function sessionOf(
  id: string,
  stage: Stage,
  start: string | number,
  end: string | number,
  sourceId = 'com.soxai',
): AndroidSegment {
  return android(id, stage, start, end, { start, end, sourceId });
}

/** 入力の順に左右されないことを確かめるため、正順と逆順の両方で組み立てる */
function keptIdsBothOrders(segments: AndroidSegment[]): string[][] {
  return [buildSessions(segments), buildSessions([...segments].reverse())].map((r) =>
    r.map((s) => s.id).sort(),
  );
}

describe('buildSessions', () => {
  // T015
  it('セグメントが0件なら睡眠も0件', () => {
    expect(buildSessions([])).toEqual([]);
  });

  // T017
  it('iOS：同じ記録元で空きがちょうど30分のセグメントは1つの睡眠になる', () => {
    const result = buildSessions([
      ios('a', 'light', '23:00', '1:00'),
      ios('b', 'deep', '1:30', '6:00'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ startAt: at('23:00'), endAt: at('6:00') }));
  });

  // T018
  it('iOS：同じ記録元で空きが30分1ミリ秒なら別の睡眠になる', () => {
    const result = buildSessions([
      ios('a', 'light', '23:00', '1:00'),
      ios('b', 'deep', '1:30:00.001', '6:00'),
    ]);

    // 組み立て結果の並び順は仕様にないので、就寝順に並べて比べる
    const ranges = result.map((s) => [s.startAt, s.endAt]).sort((x, y) => x[0] - y[0]);
    expect(ranges).toEqual([
      [at('23:00'), at('1:00')],
      [at('1:30:00.001'), at('6:00')],
    ]);
  });

  // T019
  it.each([
    ['重なる', ios('b', 'deep', '1:00', '6:00')],
    ['含まれる', ios('b', 'deep', '1:00', '2:00')],
  ])('iOS：同じ記録元で時間が%sセグメントは1つの睡眠になる', (label, second) => {
    const first =
      label === '重なる' ? ios('a', 'light', '23:00', '3:00') : ios('a', 'light', '23:00', '6:00');

    const result = buildSessions([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ startAt: at('23:00'), endAt: at('6:00') }));
  });

  // T020
  it('iOS：空きは直前のセグメントではなく、それまでの最も遅い終了から測る', () => {
    const result = buildSessions([
      ios('a', 'light', '23:00', '3:00'),
      ios('c', 'deep', '1:00', '1:30'),
      ios('b', 'rem', '3:20', '6:00'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ startAt: at('23:00'), endAt: at('6:00') }));
  });

  // T021
  it('iOS：記録元が違うセグメントは、空きが30分以下でもまとめない', () => {
    const result = buildSessions([
      ios('a', 'light', '23:00', '1:00', 'a'),
      ios('b', 'light', '1:10', '6:00', 'b'),
    ]);

    expect(result.map((s) => s.sourceId).sort()).toEqual(['a', 'b']);
  });

  // T022
  it('iOS：未整列の入力でも、開始時刻順に並べてからまとめる', () => {
    const segments = [ios('a', 'light', '23:00', '1:00'), ios('b', 'deep', '1:30', '6:00')];

    const sorted = buildSessions(segments);
    const reversed = buildSessions([...segments].reverse());

    expect(reversed).toEqual(sorted);
    expect(reversed).toHaveLength(1);
  });

  // T016
  it('長さ0・前後が逆のセグメントは捨てられ、残りから睡眠が組み立てられる', () => {
    const result = buildSessions([
      ios('a', 'light', '23:00', '23:30'),
      ios('z', 'rem', '23:30', '23:30'),
      ios('y', 'rem', '2:00', '1:00'),
      ios('b', 'deep', '23:30', '1:00'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ startAt: at('23:00'), endAt: at('1:00') }));
    expect(result[0].stages).toEqual([
      { stage: 'light', startAt: at('23:00'), endAt: at('23:30') },
      { stage: 'deep', startAt: at('23:30'), endAt: at('1:00') },
    ]);
  });

  // T023
  it('Android：同じ SleepSession は空きがあっても1つの睡眠で、就寝・起床はステージの範囲になる', () => {
    const session = { start: '22:00', end: '7:00' };

    const result = buildSessions([
      android('hc-1', 'light', '23:00', '1:00', session),
      android('hc-1', 'deep', '3:00', '6:00', session),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({ startAt: at('23:00'), endAt: at('6:00'), asleepMinutes: 300 }),
    );
    expect(result[0].stages).toHaveLength(2);
  });

  // T024
  it('Android：ステージが全部長さ0以下の SleepSession は、セッション全体の unspecified 1件になる', () => {
    const session = { start: '23:00', end: '6:00' };

    const result = buildSessions([
      android('hc-1', 'light', '1:00', '1:00', session),
      android('hc-1', 'deep', '2:00', '1:00', session),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({ startAt: at('23:00'), endAt: at('6:00'), hasStages: false }),
    );
    expect(result[0].stages).toEqual([
      { stage: 'unspecified', startAt: at('23:00'), endAt: at('6:00') },
    ]);
  });

  // T025
  it('Android：ステージなしで SleepSession 自体が長さ0以下なら捨てられる', () => {
    const result = buildSessions([
      android('hc-1', 'unspecified', '6:00', '6:00', { start: '6:00', end: '6:00' }),
      android('hc-2', 'unspecified', '6:00', '5:00', { start: '6:00', end: '5:00' }),
    ]);

    expect(result).toEqual([]);
  });

  // T190
  it('Android：ステージの一部だけ長さ0なら、残りのステージだけで組み立て、セッション全体にはしない', () => {
    const session = { start: '23:00', end: '6:00' };

    const result = buildSessions([
      android('hc-1', 'light', '23:00', '1:00', session),
      android('hc-1', 'deep', '2:00', '2:00', session),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({ startAt: at('23:00'), endAt: at('1:00'), hasStages: true }),
    );
    expect(result[0].stages).toEqual([{ stage: 'light', startAt: at('23:00'), endAt: at('1:00') }]);
  });

  // T026
  it.each<[string, Stage[], boolean]>([
    ['awake＋unspecified', ['awake', 'unspecified'], false],
    ['unspecified＋rem', ['unspecified', 'rem'], true],
    ['light だけ', ['light'], true],
    ['deep だけ', ['deep'], true],
  ])('%s の睡眠の hasStages は %s', (_label, stages, expected) => {
    const segments = stages.map((stage, i) =>
      ios(`s${i}`, stage, at('23:00') + i * 60 * MIN, at('23:00') + (i + 1) * 60 * MIN),
    );

    const result = buildSessions(segments);

    expect(result).toHaveLength(1);
    expect(result[0].hasStages).toBe(expected);
  });

  // T027
  it('同じ睡眠内で unspecified と deep が重なる部分は deep になり、二重に数えない', () => {
    const result = buildSessions([
      ios('a', 'unspecified', '0:00', '2:00'),
      ios('b', 'deep', '1:00', '3:00'),
    ]);

    expect(result[0].stages).toEqual([
      { stage: 'unspecified', startAt: at('0:00'), endAt: at('1:00') },
      { stage: 'deep', startAt: at('1:00'), endAt: at('3:00') },
    ]);
    expect(result[0].asleepMinutes).toBe(180);
  });

  // T028
  it.each<[Stage, Stage]>([
    ['deep', 'rem'],
    ['rem', 'light'],
  ])('%s と %s が重なる部分は %s になる', (higher, lower) => {
    const result = buildSessions([
      ios('a', higher, '0:00', '2:00'),
      ios('b', lower, '1:00', '3:00'),
    ]);

    expect(result[0].stages).toEqual([
      { stage: higher, startAt: at('0:00'), endAt: at('2:00') },
      { stage: lower, startAt: at('2:00'), endAt: at('3:00') },
    ]);
    expect(result[0].asleepMinutes).toBe(180);
  });

  // T029
  it('light と awake が重なる部分は light になる', () => {
    const result = buildSessions([
      ios('a', 'light', '0:00', '2:00'),
      ios('b', 'awake', '1:00', '3:00'),
    ]);

    expect(result[0].stages).toEqual([
      { stage: 'light', startAt: at('0:00'), endAt: at('2:00') },
      { stage: 'awake', startAt: at('2:00'), endAt: at('3:00') },
    ]);
    expect(result[0].asleepMinutes).toBe(120);
  });

  it('unspecified と awake が重なる部分は awake になり、その分は睡眠時間に入らない', () => {
    const result = buildSessions([
      ios('a', 'unspecified', '0:00', '2:00'),
      ios('b', 'awake', '1:00', '3:00'),
    ]);

    expect(result[0].stages).toEqual([
      { stage: 'unspecified', startAt: at('0:00'), endAt: at('1:00') },
      { stage: 'awake', startAt: at('1:00'), endAt: at('3:00') },
    ]);
    expect(result[0].asleepMinutes).toBe(60);
  });

  // T030
  it('deep に完全に覆われた unspecified は区間として残らない', () => {
    const result = buildSessions([
      ios('a', 'deep', '0:00', '3:00'),
      ios('b', 'unspecified', '1:00', '2:00'),
    ]);

    expect(result[0].stages).toEqual([{ stage: 'deep', startAt: at('0:00'), endAt: at('3:00') }]);
  });

  // T031
  it('隣り合う同じステージの区間は1つにつなぎ、隣り合わないものはつながない', () => {
    const adjacent = buildSessions([
      ios('a', 'light', '0:00', '1:00'),
      ios('b', 'light', '1:00', '2:00'),
    ]);
    const split = buildSessions([
      ios('a', 'light', '0:00', '1:00'),
      ios('b', 'deep', '0:30', '0:40'),
      ios('c', 'light', '0:40', '2:00'),
    ]);

    expect(adjacent[0].stages).toEqual([
      { stage: 'light', startAt: at('0:00'), endAt: at('2:00') },
    ]);
    expect(split[0].stages).toEqual([
      { stage: 'light', startAt: at('0:00'), endAt: at('0:30') },
      { stage: 'deep', startAt: at('0:30'), endAt: at('0:40') },
      { stage: 'light', startAt: at('0:40'), endAt: at('2:00') },
    ]);
  });

  it('iOS でまとめた空きを挟む同じステージの区間はつながず、空きは睡眠時間に入らない', () => {
    const result = buildSessions([
      ios('a', 'light', '0:00', '1:00'),
      ios('b', 'light', '1:10', '2:00'),
    ]);

    expect(result[0].stages).toEqual([
      { stage: 'light', startAt: at('0:00'), endAt: at('1:00') },
      { stage: 'light', startAt: at('1:10'), endAt: at('2:00') },
    ]);
    expect(result[0].asleepMinutes).toBe(110);
  });

  // T032
  it('睡眠時間は覚醒を除いた合計を分に切り捨てる（7時間32分59秒 → 452分）', () => {
    const start = at('23:00');
    const lightEnd = start + (7 * 60 + 32) * MIN + 59 * 1000;

    const result = buildSessions([
      ios('a', 'light', start, lightEnd),
      ios('b', 'awake', lightEnd, lightEnd + 30 * MIN),
    ]);

    expect(result[0].asleepMinutes).toBe(452);
  });

  // T193
  it('先頭と末尾の覚醒も就寝・起床の範囲に入る', () => {
    const result = buildSessions([
      ios('a', 'awake', '23:00', '23:20'),
      ios('b', 'light', '23:20', '6:00'),
      ios('c', 'awake', '6:00', '6:10'),
    ]);

    expect(result[0]).toEqual(
      expect.objectContaining({ startAt: at('23:00'), endAt: at('6:10'), asleepMinutes: 400 }),
    );
  });

  // T033
  it.each<[string, Array<[Stage, number]>, number[]]>([
    ['覚醒だけ', [['awake', 60 * MIN]], []],
    [
      '覚醒以外が59秒',
      [
        ['light', 59 * 1000],
        ['awake', 60 * MIN],
      ],
      [],
    ],
    [
      '覚醒以外がちょうど60秒',
      [
        ['light', 60 * 1000],
        ['awake', 60 * MIN],
      ],
      [1],
    ],
  ])('%s の睡眠の睡眠時間（0分なら捨てる）', (_label, parts, expectedMinutes) => {
    let cursor = at('23:00');
    const segments = parts.map(([stage, length], i) => {
      const seg = ios(`s${i}`, stage, cursor, cursor + length);
      cursor += length;
      return seg;
    });

    expect(buildSessions(segments).map((s) => s.asleepMinutes)).toEqual(expectedMinutes);
  });

  // T034
  it('重なる睡眠は、短くてもステージありのほうを残す', () => {
    const result = buildSessions([
      sessionOf('x', 'unspecified', '23:00', '5:00', 'a'),
      sessionOf('y', 'light', '0:00', '5:00', 'b'),
    ]);

    expect(result.map((s) => s.id)).toEqual(['y']);
    expect(
      keptIdsBothOrders([
        sessionOf('x', 'unspecified', '23:00', '5:00', 'a'),
        sessionOf('y', 'light', '0:00', '5:00', 'b'),
      ]),
    ).toEqual([['y'], ['y']]);
  });

  // T035
  it('両方ステージありなら、睡眠時間が長いほうを残す（下位の基準より先に効く）', () => {
    // X：301分・記録元 com.b・就寝 23:10・id b、Y：300分・記録元 com.a・就寝 23:00・id a
    const result = buildSessions([
      sessionOf('b', 'light', '23:10', at('23:10') + 301 * MIN, 'com.b'),
      sessionOf('a', 'light', '23:00', at('23:00') + 300 * MIN, 'com.a'),
    ]);

    expect(result.map((s) => [s.id, s.asleepMinutes])).toEqual([['b', 301]]);
    expect(
      keptIdsBothOrders([
        sessionOf('b', 'light', '23:10', at('23:10') + 301 * MIN, 'com.b'),
        sessionOf('a', 'light', '23:00', at('23:00') + 300 * MIN, 'com.a'),
      ]),
    ).toEqual([['b'], ['b']]);
  });

  // T036
  it('両方ステージなしでも、睡眠時間が長いほうを残す', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('b', 'unspecified', '23:10', at('23:10') + 301 * MIN, 'com.b'),
        sessionOf('a', 'unspecified', '23:00', at('23:00') + 300 * MIN, 'com.a'),
      ]),
    ).toEqual([['b'], ['b']]);
  });

  // T037
  it('睡眠時間も同じなら、記録元IDの辞書順で先を残す（就寝・id より先に効く）', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('b', 'light', '23:10', at('23:10') + 300 * MIN, 'com.a'),
        sessionOf('a', 'light', '23:00', at('23:00') + 300 * MIN, 'com.b'),
      ]),
    ).toEqual([['b'], ['b']]);
  });

  // T038
  it('記録元も同じなら、就寝が早いほうを残す（id より先に効く）', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('b', 'light', '23:00', at('23:00') + 300 * MIN),
        sessionOf('a', 'light', '23:10', at('23:10') + 300 * MIN),
      ]),
    ).toEqual([['b'], ['b']]);
  });

  // T039
  it('就寝も同じなら、睡眠 id の辞書順で先を残す', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('b', 'light', '23:00', at('23:00') + 300 * MIN),
        sessionOf('a', 'light', '23:00', at('23:00') + 300 * MIN),
      ]),
    ).toEqual([['a'], ['a']]);
  });

  // T040
  it('Android：同じ記録元の重なる SleepSession も1つだけ残す', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('hc-1', 'light', '23:00', at('23:00') + 300 * MIN),
        sessionOf('hc-2', 'light', '23:10', at('23:10') + 301 * MIN),
      ]),
    ).toEqual([['hc-2'], ['hc-2']]);
  });

  // T189
  it('Android：同じ記録元で重ならず空きが10分の SleepSession は、まとめず2件のまま', () => {
    const result = buildSessions([
      sessionOf('hc-1', 'light', '23:00', '1:00'),
      sessionOf('hc-2', 'light', '1:10', '6:00'),
    ]);

    expect(result.map((s) => s.id).sort()).toEqual(['hc-1', 'hc-2']);
  });

  // T041
  it('3つ連なって重なり B が最優先なら、B だけ残る', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('A', 'unspecified', '22:00', '1:00', 'x'),
        sessionOf('B', 'light', '0:30', '3:30', 'y'),
        sessionOf('C', 'unspecified', '3:00', '6:00', 'z'),
      ]),
    ).toEqual([['B'], ['B']]);
  });

  // T042
  it('3つ連なって重なり、順位が A・C・B なら A と C が残る', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('A', 'light', '22:00', '1:00', 'x'),
        sessionOf('B', 'light', '0:30', '3:20', 'y'),
        sessionOf('C', 'light', '3:00', '5:59', 'z'),
      ]),
    ).toEqual([
      ['A', 'C'],
      ['A', 'C'],
    ]);
  });

  // T195
  it('3つ連なって重なり、順位が A・B・C なら A と C が残る（落ちた B とは比べない）', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('A', 'light', '22:00', '1:00', 'x'),
        sessionOf('B', 'light', '0:30', '3:29', 'y'),
        sessionOf('C', 'light', '3:00', '5:50', 'z'),
      ]),
    ).toEqual([
      ['A', 'C'],
      ['A', 'C'],
    ]);
  });

  // T043
  it('3つ連なる重なりの結果は、入力の順に左右されない', () => {
    const a = sessionOf('A', 'unspecified', '22:00', '1:00', 'x');
    const b = sessionOf('B', 'light', '0:30', '3:30', 'y');
    const c = sessionOf('C', 'unspecified', '3:00', '6:00', 'z');

    for (const order of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ]) {
      expect(buildSessions(order).map((s) => s.id)).toEqual(['B']);
    }
  });

  // T044
  it('記録元が違い、終了と開始が同時刻の睡眠は両方残す', () => {
    const result = buildSessions([
      sessionOf('A', 'light', '23:00', '3:00', 'x'),
      sessionOf('B', 'light', '3:00', '6:00', 'y'),
    ]);

    expect(result.map((s) => s.id).sort()).toEqual(['A', 'B']);
  });

  // T045
  it('1ミリ秒重なる睡眠は、片方（優先の A）だけ残す', () => {
    expect(
      keptIdsBothOrders([
        sessionOf('A', 'light', '23:00', at('3:00') + 1, 'x'),
        sessionOf('B', 'light', '3:00', '6:00', 'y'),
      ]),
    ).toEqual([['A'], ['A']]);
  });

  // T046
  it.each([
    [
      '23:30 就寝・6:30 起床',
      '2026-11-24T23:30:00.000+09:00',
      '2026-11-25T06:30:00.000+09:00',
      '2026-11-25',
    ],
    [
      '23:59:59.999 の起床',
      '2026-11-24T22:00:00.000+09:00',
      '2026-11-24T23:59:59.999+09:00',
      '2026-11-24',
    ],
    [
      '0:00 ちょうどの起床',
      '2026-11-24T22:00:00.000+09:00',
      '2026-11-25T00:00:00.000+09:00',
      '2026-11-25',
    ],
  ])('帰属日は起床時刻の日付（%s）', (_label, start, end, expected) => {
    const result = buildSessions([
      ios('a', 'light', new Date(start).getTime(), new Date(end).getTime()),
    ]);

    expect(result[0].wakeDate).toBe(expected);
  });

  // T047
  it.each<[string, string | undefined, string | undefined, string, string]>([
    ['記録元 undefined・UUID undefined', undefined, undefined, 'unknown', 'unknown'],
    ['記録元 空文字・UUID 空文字', '', '', 'unknown', 'unknown'],
    ['記録元あり・UUID undefined', 'com.soxai', undefined, 'com.soxai', 'com.soxai'],
    ['記録元 undefined・UUID あり', undefined, 'u1', 'unknown', 'u1'],
  ])('iOS：%s', (_label, sourceId, sampleId, expectedSource, expectedIdPrefix) => {
    // ios() は記録元を省くと既定値になるので、記録元は直接差し替える
    const segment: IosSegment = { ...ios(sampleId, 'light', '23:00', '6:00'), sourceId };
    const expectedId = sampleId ? sampleId : `${expectedIdPrefix}:${at('23:00')}:${at('6:00')}`;

    const first = buildSessions([segment]);
    const second = buildSessions([{ ...segment }]);

    expect(first[0]).toEqual(expect.objectContaining({ sourceId: expectedSource, id: expectedId }));
    expect(second[0].id).toBe(first[0].id);
  });

  // T048
  it.each<[string, string | undefined, string | undefined, string, string]>([
    ['id・記録元とも undefined', undefined, undefined, 'unknown', 'unknown:{S}:{E}'],
    ['id・記録元とも空文字', '', '', 'unknown', 'unknown:{S}:{E}'],
    ['記録元だけあり', undefined, 'com.soxai', 'com.soxai', 'com.soxai:{S}:{E}'],
    ['id だけあり', 'hc-1', undefined, 'unknown', 'hc-1'],
  ])('Android：%s', (_label, sessionId, sourceId, expectedSource, idTemplate) => {
    const session = { start: '22:00', end: '7:00', sourceId };
    const expectedId = idTemplate
      .replace('{S}', String(at('22:00')))
      .replace('{E}', String(at('7:00')));

    const result = buildSessions([android(sessionId, 'light', '23:00', '6:00', session)]);

    expect(result[0]).toEqual(
      expect.objectContaining({ sourceId: expectedSource, id: expectedId }),
    );
  });

  // T181
  it('iOS：先頭サンプルの UUID が空なら、睡眠の id はそのサンプルの時刻で付けた代わりの値になる', () => {
    const result = buildSessions([
      ios('', 'light', '23:00', '1:00'),
      ios('u9', 'deep', '1:00', '6:00'),
    ]);

    expect(result[0].id).toBe(`com.soxai:${at('23:00')}:${at('1:00')}`);
  });

  // T049
  it('iOS：まとめた睡眠の id は開始が最も早いサンプルの UUID（開始が同じなら辞書順で先）', () => {
    const result = buildSessions([
      ios('u2', 'light', '23:00', '0:30'),
      ios('u1', 'deep', '23:00', '0:20'),
      ios('u0', 'rem', '1:00', '6:00'),
    ]);

    expect(result[0]).toEqual(expect.objectContaining({ id: 'u1', sourceId: 'com.soxai' }));
  });

  // T050
  it('Android：睡眠の id は metadata.id、記録元は dataOrigin', () => {
    const result = buildSessions([
      android('hc-1', 'light', '23:00', '6:00', {
        start: '23:00',
        end: '6:00',
        sourceId: 'com.soxai',
      }),
    ]);

    expect(result[0]).toEqual(expect.objectContaining({ id: 'hc-1', sourceId: 'com.soxai' }));
  });
});

describe('countValidSegments', () => {
  /** ステージがすべて長さ0の、23:00〜6:00 の SleepSession A（セッション自体の長さは引数で変える） */
  const zeroStagesA = (session: { start: string; end: string }) => [
    android('A', 'light', '23:30', '23:30', session),
    android('A', 'deep', '1:00', '1:00', session),
  ];
  /** 正の長さのステージが3件の SleepSession B */
  const sessionB = () => {
    const session = { start: '22:00', end: '1:00' };
    return [
      android('B', 'light', '22:00', '23:00', session),
      android('B', 'deep', '23:00', '0:00', session),
      android('B', 'rem', '0:00', '1:00', session),
    ];
  };

  // T208
  it.each([
    ['ステージがすべて長さ0の7時間のセッション A ＋ B', { start: '23:00', end: '6:00' }, 4],
    ['A のセッション自体も長さ0 ＋ B', { start: '23:00', end: '23:00' }, 3],
    ['A のセッションの前後が逆 ＋ B', { start: '6:00', end: '23:00' }, 3],
  ])('Android：%s', (_label, sessionA, expected) => {
    expect(countValidSegments([...zeroStagesA(sessionA), ...sessionB()])).toBe(expected);
  });

  // T208
  it('iOS：長さ0のサンプル1件と正のサンプル2件は2件', () => {
    expect(
      countValidSegments([
        ios('u1', 'light', '23:00', '23:00'),
        ios('u2', 'light', '23:00', '0:00'),
        ios('u3', 'deep', '0:00', '1:00'),
      ]),
    ).toBe(2);
  });
});
