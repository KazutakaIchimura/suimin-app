// 手順14・15 の「シード S」（設計書「テストリスト」手順14 の前提）。
// DB に入れる場合も、ネイティブのモックが返す場合も同じ睡眠になるようにする
import type Database from 'better-sqlite3';

const MIN = 60 * 1000;

/** JST の日時（`2026-11-24T23:00` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

type Stage = 'awake' | 'light' | 'deep' | 'rem';

/** シード S の睡眠：[id, 就寝, 帰属日, 睡眠時間（分）, ステージと長さ（分）を就寝から隙間なく] */
const S_SESSIONS: [string, string, string, number, [Stage, number][]][] = [
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

/** 各睡眠のステージ区間（UNIX ミリ秒） */
function intervals(start: string, stages: [Stage, number][]) {
  let at = jst(start);
  return stages.map(([stage, minutes]) => {
    const interval = { stage, startAt: at, endAt: at + minutes * MIN };
    at = interval.endAt;
    return interval;
  });
}

/** シード S を、テスト対象を通さず SQL で DB に入れる */
export function seedS(sqlite: Database.Database): void {
  const insertSession = sqlite.prepare(
    'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, 1)',
  );
  const insertStage = sqlite.prepare(
    'INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, ?, ?, ?)',
  );
  for (const [id, start, wakeDate, asleepMinutes, stages] of S_SESSIONS) {
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

/** シード S と同じ睡眠になる HealthKit の睡眠サンプル（`queryCategorySamples` の戻り値） */
export function sIosSamples() {
  return S_SESSIONS.flatMap(([id, start, , , stages]) =>
    intervals(start, stages).map((s, i) => ({
      uuid: `${id}-${i}`,
      value: HK_VALUE[s.stage],
      startDate: new Date(s.startAt),
      endDate: new Date(s.endAt),
      sourceRevision: { source: { name: 'SOXAI', bundleIdentifier: 'com.soxai' } },
    })),
  );
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
