// 01 の手順14・15 の「シード S」（01 の設計書「テストリスト」手順14 の前提）と、
// 02 の手順5 の「シード C」（02 の設計書「テストリスト」の共通の前提。S に 11/17・10/30 を足したもの）。
// DB に入れる場合も、ネイティブのモックが返す場合も同じ睡眠になるようにする。
// 03 の「シード E」（03 の設計書「テストリスト」の共通の前提。推定の日数の判定用）もここに置く
import type Database from 'better-sqlite3';

const MIN = 60 * 1000;

/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

type Stage = 'awake' | 'light' | 'deep' | 'rem';

/** 睡眠：[id, 就寝, 帰属日, 睡眠時間（分）, ステージと長さ（分）を就寝から隙間なく] */
type SeedSession = [string, string, string, number, [Stage, number][]];

/** シード S の睡眠 */
const S_SESSIONS: SeedSession[] = [
  [
    's-main-25',
    '2026-11-24T23:14',
    '2026-11-25',
    432,
    [
      ['deep', 90],
      ['light', 280],
      ['rem', 62],
      ['awake', 20],
    ],
  ],
  ['s-nap-25', '2026-11-25T13:00', '2026-11-25', 30, [['light', 30]]],
  ['s-main-24', '2026-11-23T23:00', '2026-11-24', 420, [['light', 420]]],
];

/** シード C の睡眠（シード S ＋ 11/17・10/30） */
const C_SESSIONS: SeedSession[] = [
  ...S_SESSIONS,
  ['c-main-17', '2026-11-17T00:30', '2026-11-17', 420, [['light', 420]]],
  ['c-main-1030', '2026-10-29T23:30', '2026-10-30', 420, [['light', 420]]],
];

/** 各睡眠のステージ区間（UNIX ミリ秒） */
function intervals(start: string, stages: [Stage, number][]) {
  let at = jst(start);
  return stages.map(([stage, minutes]) => {
    const interval = { stage, startAt: at, endAt: at + minutes * MIN };
    at = interval.endAt;
    return interval;
  });
}

/** 睡眠を、テスト対象を通さず SQL で DB に入れる */
function seedSessions(sqlite: Database.Database, sessions: SeedSession[]): void {
  const insertSession = sqlite.prepare(
    'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, 1)',
  );
  const insertStage = sqlite.prepare(
    'INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, ?, ?, ?)',
  );
  for (const [id, start, wakeDate, asleepMinutes, stages] of sessions) {
    const list = intervals(start, stages);
    insertSession.run(
      id,
      'com.soxai',
      list[0].startAt,
      list[list.length - 1].endAt,
      wakeDate,
      asleepMinutes,
    );
    for (const s of list) insertStage.run(id, s.stage, s.startAt, s.endAt);
  }
}

/** HealthKit の睡眠の値（CategoryValueSleepAnalysis） */
const HK_VALUE: Record<Stage, number> = { awake: 2, light: 3, deep: 4, rem: 5 };

/** 睡眠と同じ睡眠になる HealthKit の睡眠サンプル（`queryCategorySamples` の戻り値） */
function iosSamplesOf(sessions: SeedSession[]) {
  return sessions.flatMap(([id, start, , , stages]) =>
    intervals(start, stages).map((s, i) => ({
      uuid: `${id}-${i}`,
      value: HK_VALUE[s.stage],
      startDate: new Date(s.startAt),
      endDate: new Date(s.endAt),
      sourceRevision: { source: { name: 'SOXAI', bundleIdentifier: 'com.soxai' } },
    })),
  );
}

/** シード S を DB に入れる */
export function seedS(sqlite: Database.Database): void {
  seedSessions(sqlite, S_SESSIONS);
}

/** シード C を DB に入れる */
export function seedC(sqlite: Database.Database): void {
  seedSessions(sqlite, C_SESSIONS);
}

/** シード S と同じ睡眠になる HealthKit の睡眠サンプル */
export function sIosSamples() {
  return iosSamplesOf(S_SESSIONS);
}

/** シード C と同じ睡眠になる HealthKit の睡眠サンプル。`exclude` に挙げた id の睡眠は除く */
export function cIosSamples(exclude: string[] = []) {
  return iosSamplesOf(C_SESSIONS.filter(([id]) => !exclude.includes(id)));
}

/** ヘルスコネクトのステージの値（SleepStageType） */
const HC_STAGE: Record<Stage, number> = { awake: 1, light: 4, deep: 5, rem: 6 };

/** シード S と同じ睡眠になるヘルスコネクトの SleepSession（`readRecords` の戻り値） */
export function sAndroidPage() {
  return {
    records: S_SESSIONS.map(([id, start, , , stages]) => {
      const list = intervals(start, stages);
      const iso = (ms: number) => new Date(ms).toISOString();
      return {
        metadata: { id, dataOrigin: 'com.soxai' },
        startTime: iso(list[0].startAt),
        endTime: iso(list[list.length - 1].endAt),
        stages: list.map((s) => ({
          stage: HC_STAGE[s.stage],
          startTime: iso(s.startAt),
          endTime: iso(s.endAt),
        })),
      };
    }),
    pageToken: undefined,
  };
}

/**
 * シード E の主睡眠1回分（前日 23:00 就寝、入眠 8分）。`withCycle` ならレム期が2つ（終わり 1:00・2:35、間隔 95分）
 */
function eSession(wakeDate: string, withCycle: boolean): SeedSession {
  const [y, m, d] = wakeDate.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const bed = `${prev.toISOString().slice(0, 10)}T23:00`;
  const stages: [Stage, number][] = withCycle
    ? [
        ['awake', 8],
        ['light', 82],
        ['rem', 30],
        ['deep', 60],
        ['light', 5],
        ['rem', 30],
        ['light', 205],
      ]
    : [
        ['awake', 8],
        ['light', 82],
        ['rem', 30],
        ['deep', 60],
        ['light', 240],
      ];
  const asleep = stages.filter(([st]) => st !== 'awake').reduce((sum, [, min]) => sum + min, 0);
  return [`e-${wakeDate}`, bed, wakeDate, asleep, stages];
}

/** シード E の帰属日（`2026-10-29`〜`2026-11-12`）と、サイクル値があるか */
function eDates(): [string, boolean][] {
  const list: [string, boolean][] = [
    ['2026-10-29', true],
    ['2026-10-30', true],
  ];
  for (let day = 31; day <= 43; day += 1) {
    const date = new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);
    list.push([date, date !== '2026-11-12']);
  }
  return list;
}

/**
 * シード E を DB に入れる（今日 `2026-11-28` の範囲 `10-30`〜`11-28` で、入眠の値が14日・サイクル長の値が13日。
 * `10-29` は範囲の外で、数えるとサイクル長が14日になる）。`withToday` なら帰属日 `11-28` のサイクル値ありの主睡眠も足す
 */
export function seedE(sqlite: Database.Database, opts: { withToday?: boolean } = {}): void {
  const dates = eDates();
  if (opts.withToday === true) dates.push(['2026-11-28', true]);
  seedSessions(
    sqlite,
    dates.map(([date, withCycle]) => eSession(date, withCycle)),
  );
}
