import {
  buildDayDetail,
  buildDaySummaries,
  pickMainSessions,
} from '@/features/sleep-record/sleep-record-day.service';
import type {
  DayDetail,
  SleepSession,
  Stage,
  StageInterval,
} from '@/features/sleep-record/sleep-record.types';

const MIN = 60 * 1000;

/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

/**
 * 睡眠1件を作る。区間を渡さなければ、就寝から睡眠時間ぶんの `light` 1区間にする。
 * 起床は区間の最後の終了
 */
function sleep(
  id: string,
  start: string,
  asleepMinutes: number,
  opts: { wakeDate?: string; stages?: StageInterval[]; hasStages?: boolean } = {},
): SleepSession {
  const startAt = jst(start);
  const stages = opts.stages ?? [{ stage: 'light', startAt, endAt: startAt + asleepMinutes * MIN }];
  return {
    id,
    sourceId: 'com.soxai',
    startAt,
    endAt: Math.max(...stages.map((s) => s.endAt)),
    wakeDate: opts.wakeDate ?? '2026-11-25',
    asleepMinutes,
    hasStages: opts.hasStages ?? true,
    stages,
  };
}

/** ステージと長さ（ミリ秒）の並びを、`start` から隙間なく続く区間にする */
function contiguous(start: string, parts: [Stage, number][]): StageInterval[] {
  let at = jst(start);
  return parts.map(([stage, ms]) => {
    const interval = { stage, startAt: at, endAt: at + ms };
    at += ms;
    return interval;
  });
}

/** 「データあり」の詳細を取り出す（「データなし」ならテストを落とす） */
function found(detail: DayDetail): Extract<DayDetail, { kind: 'found' }> {
  if (detail.kind !== 'found') throw new Error(`データありの詳細ではない: ${detail.kind}`);
  return detail;
}

describe('buildDayDetail', () => {
  // T051
  it('睡眠時間が最長のものが主睡眠、残りが就寝の早い順に昼寝になる', () => {
    const sessions = [
      sleep('nap15', '2026-11-25T15:00', 30),
      sleep('main', '2026-11-24T23:00', 420),
      sleep('nap12', '2026-11-25T12:00', 60),
    ];

    const detail = found(buildDayDetail(sessions, '2026-11-25'));

    expect(detail.main.id).toBe('main');
    expect(detail.main.asleepMinutes).toBe(420);
    expect(detail.naps.map((n) => [n.id, n.asleepMinutes])).toEqual([
      ['nap12', 60],
      ['nap15', 30],
    ]);
  });

  // T051（短い昼寝のほうが就寝が早い例。睡眠時間の順に並べる誤りを検出する）
  it('昼寝は睡眠時間ではなく就寝の早い順に並ぶ', () => {
    const sessions = [
      sleep('nap15', '2026-11-25T15:00', 60),
      sleep('main', '2026-11-24T23:00', 420),
      sleep('nap12', '2026-11-25T12:00', 30),
    ];

    const detail = found(buildDayDetail(sessions, '2026-11-25'));

    expect(detail.naps.map((n) => [n.id, n.asleepMinutes])).toEqual([
      ['nap12', 30],
      ['nap15', 60],
    ]);
  });

  // T052
  it('睡眠時間が同じなら、就寝が早いほうが主睡眠になる', () => {
    const sessions = [
      sleep('later', '2026-11-25T13:00', 300),
      sleep('earlier', '2026-11-24T22:00', 300),
    ];

    const detail = found(buildDayDetail(sessions, '2026-11-25'));

    expect(detail.main.id).toBe('earlier');
    expect(detail.naps.map((n) => n.id)).toEqual(['later']);
  });

  // T061
  it('指定日に睡眠がなければ「データなし」になる', () => {
    const sessions = [sleep('other', '2026-11-23T23:00', 420, { wakeDate: '2026-11-24' })];

    expect(buildDayDetail(sessions, '2026-11-25')).toEqual({ kind: 'none' });
  });

  // T056
  it('ステージ内訳は主睡眠だけについて、深い・浅い・REM・覚醒・不明の順に分と割合を返す', () => {
    const main = sleep('main', '2026-11-24T23:00', 380, {
      stages: contiguous('2026-11-24T23:00', [
        ['light', 200 * MIN],
        ['rem', 80 * MIN],
        ['unspecified', 10 * MIN],
        ['deep', 90 * MIN],
        ['awake', 20 * MIN],
      ]),
    });
    const nap = sleep('nap', '2026-11-25T13:00', 30, {
      stages: contiguous('2026-11-25T13:00', [['deep', 30 * MIN]]),
    });

    const detail = found(buildDayDetail([nap, main], '2026-11-25'));

    // 分母 400分。22.5% → 23%、2.5% → 3%
    expect(detail.breakdown).toEqual([
      { stage: 'deep', minutes: 90, percent: 23 },
      { stage: 'light', minutes: 200, percent: 50 },
      { stage: 'rem', minutes: 80, percent: 20 },
      { stage: 'awake', minutes: 20, percent: 5 },
      { stage: 'unspecified', minutes: 10, percent: 3 },
    ]);
  });

  // T057
  it('1分未満のステージは行に出さないが、分母には含める', () => {
    const main = sleep('main', '2026-11-24T23:00', 238, {
      stages: contiguous('2026-11-24T23:00', [
        ['light', 238 * MIN],
        ['rem', 59 * 1000],
        ['awake', 60 * 1000],
      ]),
    });

    const detail = found(buildDayDetail([main], '2026-11-25'));

    // 分母は 239分59秒。REM の59秒を含めないと浅いは 100% になる
    expect(detail.breakdown).toEqual([
      { stage: 'light', minutes: 238, percent: 99 },
      { stage: 'awake', minutes: 1, percent: 0 },
    ]);
  });

  // T058
  it('iOS でまとめた空き（区間のない時間）は割合の分母に入らない', () => {
    const start = jst('2026-11-24T23:00');
    const main = sleep('main', '2026-11-24T23:00', 360, {
      stages: [
        { stage: 'light', startAt: start, endAt: start + 180 * MIN },
        { stage: 'light', startAt: start + 200 * MIN, endAt: start + 380 * MIN },
      ],
    });

    const detail = found(buildDayDetail([main], '2026-11-25'));

    expect(detail.breakdown).toEqual([{ stage: 'light', minutes: 360, percent: 100 }]);
  });

  // T059
  it('割合は四捨五入する（12.5% → 13%、12.4% → 12%）', () => {
    const main = sleep('main', '2026-11-24T23:00', 400, {
      stages: contiguous('2026-11-24T23:00', [
        ['deep', 50 * MIN],
        ['rem', 49.6 * MIN],
        ['light', 300.4 * MIN],
      ]),
    });

    const detail = found(buildDayDetail([main], '2026-11-25'));

    expect(detail.breakdown).toEqual([
      { stage: 'deep', minutes: 50, percent: 13 },
      { stage: 'light', minutes: 300, percent: 75 },
      { stage: 'rem', minutes: 49, percent: 12 },
    ]);
  });

  // T060
  it('ステージなしの主睡眠は内訳が null になる', () => {
    const main = sleep('main', '2026-11-24T23:00', 420, {
      hasStages: false,
      stages: contiguous('2026-11-24T23:00', [['unspecified', 420 * MIN]]),
    });

    const detail = found(buildDayDetail([main], '2026-11-25'));

    expect(detail.breakdown).toBeNull();
  });

  // T191
  it('ステージありでも出す行がなければ内訳は空配列になる（null とは別）', () => {
    const main = sleep('main', '2026-11-24T23:00', 1, {
      stages: contiguous('2026-11-24T23:00', [
        ['light', 59 * 1000],
        ['deep', 59 * 1000],
      ]),
    });

    const detail = found(buildDayDetail([main], '2026-11-25'));

    expect(detail.breakdown).toEqual([]);
  });
});

describe('buildDaySummaries', () => {
  // T053
  it('合計睡眠時間は主睡眠と昼寝の合計で、就寝・起床は主睡眠のもの', () => {
    const main = sleep('main', '2026-11-24T23:00', 420);
    const sessions = [
      sleep('nap15', '2026-11-25T15:00', 30),
      main,
      sleep('nap12', '2026-11-25T12:00', 60),
    ];

    expect(buildDaySummaries(sessions)).toEqual([
      {
        wakeDate: '2026-11-25',
        totalAsleepMinutes: 510,
        mainStartAt: main.startAt,
        mainEndAt: main.endAt,
        napCount: 2,
      },
    ]);
  });

  // T054
  it('帰属日の新しい順に並び、睡眠のない日の行はない（未整列の入力）', () => {
    const sessions = [
      sleep('d23', '2026-11-22T23:00', 400, { wakeDate: '2026-11-23' }),
      sleep('d25', '2026-11-24T23:00', 420, { wakeDate: '2026-11-25' }),
      sleep('d24', '2026-11-23T23:00', 410, { wakeDate: '2026-11-24' }),
    ];

    expect(buildDaySummaries(sessions).map((d) => [d.wakeDate, d.totalAsleepMinutes])).toEqual([
      ['2026-11-25', 420],
      ['2026-11-24', 410],
      ['2026-11-23', 400],
    ]);
  });

  // T055
  it('睡眠0件なら空の配列になる', () => {
    expect(buildDaySummaries([])).toEqual([]);
  });
});

// 03 スマートアラームの推定の元データ（設計書 docs/features/03_smart-alarm.md の U1）
describe('pickMainSessions', () => {
  // T002
  it('帰属日ごとに主睡眠だけを、帰属日の古い順に返す（同じ長さなら就寝が早いほう）', () => {
    const mainStages = contiguous('2026-11-27T23:00', [
      ['awake', 5 * MIN],
      ['rem', 415 * MIN],
    ]);
    const sessions = [
      sleep('d27-main', '2026-11-27T23:00', 420, { wakeDate: '2026-11-28', stages: mainStages }),
      sleep('d27-nap', '2026-11-28T13:00', 30, { wakeDate: '2026-11-28' }),
      sleep('d26-late', '2026-11-27T01:00', 300, { wakeDate: '2026-11-27' }),
      sleep('d26-early', '2026-11-27T00:00', 300, { wakeDate: '2026-11-27' }),
      sleep('d25', '2026-11-25T23:00', 400, { wakeDate: '2026-11-26' }),
    ];

    const result = pickMainSessions(sessions);

    expect(result.map((s) => s.id)).toEqual(['d25', 'd26-early', 'd27-main']);
    expect(result[2].stages).toEqual(mainStages);
  });

  // T003
  it('睡眠0件なら空の配列になる', () => {
    expect(pickMainSessions([])).toEqual([]);
  });
});
