import type { SleepSession, StageInterval } from '@/features/sleep-record/sleep-record.types';

import { createTestDb, type TestDb } from '../../helpers/test-db';

// `@/lib/db` をテスト用DB（better-sqlite3 に実際のマイグレーションを適用したもの）に差し替える
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

// jest.mock の後に読み込む
// eslint-disable-next-line import/first
import {
  findSessionsByWakeDate,
  hasAnySession,
  listSessions,
  readLastSyncedAt,
  replaceSessions,
} from '@/features/sleep-record/sleep-record.repository';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 範囲の開始 R */
const R = new Date('2026-11-18T12:00:00+09:00').getTime();
/** 同期開始時刻 T */
const T = new Date('2026-11-25T12:00:00+09:00').getTime();

/** JST の日付 `YYYY-MM-DD` */
function jstDate(ms: number): string {
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
}

/** 採用する睡眠（リポジトリに渡す値）。区間を渡さなければ全体を `light` 1区間にする */
function adopted(
  id: string,
  startAt: number,
  endAt: number,
  opts: {
    stages?: StageInterval[];
    hasStages?: boolean;
    asleepMinutes?: number;
    sourceId?: string;
  } = {},
): SleepSession {
  return {
    id,
    sourceId: opts.sourceId ?? 'com.soxai',
    startAt,
    endAt,
    wakeDate: jstDate(endAt),
    asleepMinutes: opts.asleepMinutes ?? Math.floor((endAt - startAt) / MIN),
    hasStages: opts.hasStages ?? true,
    stages: opts.stages ?? [{ stage: 'light', startAt, endAt }],
  };
}

describe('sleep-record の DB リポジトリ', () => {
  /** 前提のデータを、テスト対象のリポジトリを通さず SQL で入れる */
  const seedSession = (session: SleepSession) => {
    mockTestDb.sqlite
      .prepare(
        'INSERT INTO sleep_sessions (id, source_id, start_at, end_at, wake_date, asleep_minutes, has_stages) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.sourceId,
        session.startAt,
        session.endAt,
        session.wakeDate,
        session.asleepMinutes,
        session.hasStages ? 1 : 0,
      );
    for (const s of session.stages) {
      mockTestDb.sqlite
        .prepare(
          'INSERT INTO sleep_stages (session_id, stage, start_at, end_at) VALUES (?, ?, ?, ?)',
        )
        .run(session.id, s.stage, s.startAt, s.endAt);
    }
  };
  const seedSyncState = (lastSyncedAt: number) => {
    mockTestDb.sqlite
      .prepare('INSERT INTO sleep_sync_state (id, last_synced_at) VALUES (1, ?)')
      .run(lastSyncedAt);
  };
  const sessionRows = () =>
    mockTestDb.sqlite.prepare('SELECT * FROM sleep_sessions ORDER BY id').all();
  const sessionIds = () =>
    (
      mockTestDb.sqlite.prepare('SELECT id FROM sleep_sessions ORDER BY id').all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  const stageRows = (sessionId: string) =>
    mockTestDb.sqlite
      .prepare(
        'SELECT stage, start_at, end_at FROM sleep_stages WHERE session_id = ? ORDER BY start_at',
      )
      .all(sessionId);
  const allStageRows = () =>
    mockTestDb.sqlite.prepare('SELECT * FROM sleep_stages ORDER BY id').all();
  /** 睡眠の値を、DB の行の形にする */
  const asRow = (s: SleepSession) => ({
    id: s.id,
    source_id: s.sourceId,
    start_at: s.startAt,
    end_at: s.endAt,
    wake_date: s.wakeDate,
    asleep_minutes: s.asleepMinutes,
    has_stages: s.hasStages ? 1 : 0,
  });
  const syncStateRows = () => mockTestDb.sqlite.prepare('SELECT * FROM sleep_sync_state').all();

  beforeEach(() => {
    mockTestDb = createTestDb();
  });

  afterEach(() => {
    mockTestDb.destroy();
  });

  describe('replaceSessions', () => {
    // T070
    it('起床が範囲の開始以降の睡眠は消えて入れ直され、それより前は残り、同期記録は上書きされる', () => {
      seedSession(adopted('before', R - 1 - 6 * HOUR, R - 1));
      // 起床ちょうど R。before と重ならないよう就寝は R − 1ms（DB に直接入れる前提データ）
      seedSession(adopted('atStart', R - 1, R, { asleepMinutes: 1 }));
      seedSession(adopted('nextDay', R + DAY - 6 * HOUR, R + DAY));
      seedSyncState(R - 3 * DAY);

      const start = R + 2 * DAY - 6 * HOUR;
      const fresh = adopted('new', start, R + 2 * DAY, {
        sourceId: 'com.other',
        asleepMinutes: 340,
        stages: [
          { stage: 'awake', startAt: start, endAt: start + 20 * MIN },
          { stage: 'deep', startAt: start + 20 * MIN, endAt: start + 2 * HOUR },
          { stage: 'rem', startAt: start + 2 * HOUR, endAt: R + 2 * DAY },
        ],
      });

      replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [fresh] });

      expect(sessionIds()).toEqual(['before', 'new']);
      expect(sessionRows()).toContainEqual(asRow(fresh));
      expect(stageRows('new')).toEqual(
        fresh.stages.map((st) => ({ stage: st.stage, start_at: st.startAt, end_at: st.endAt })),
      );
      expect(syncStateRows()).toEqual([{ id: 1, last_synced_at: T }]);
    });

    // T071
    it('範囲より前でも、採用する睡眠と同じ id の睡眠は消えて入れ直される（主キー衝突しない）', () => {
      seedSession(adopted('x', R - 3 * DAY - 6 * HOUR, R - 3 * DAY));
      const moved = adopted('x', R + DAY - 7 * HOUR, R + DAY);

      replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [moved] });

      expect(sessionRows()).toEqual([asRow(moved)]);
      expect(stageRows('x')).toEqual([
        { stage: 'light', start_at: moved.startAt, end_at: moved.endAt },
      ]);
    });

    // T072（P1 と P2 を同じ DB に入れると P1 と P2 どうしが重なるため、別々に確かめる）
    describe('範囲より前の睡眠と採用する睡眠の重なり', () => {
      const newStart = R - 2 * HOUR;
      const fresh = adopted('new', newStart, R + 6 * HOUR);

      it('採用する睡眠と1ミリ秒重なる睡眠 P1 は消える', () => {
        seedSession(adopted('p1', newStart - 6 * HOUR, newStart + 1));

        replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [fresh] });

        expect(sessionIds()).toEqual(['new']);
      });

      it('終了が採用する睡眠の開始とちょうど同じ睡眠 P2 は残る', () => {
        seedSession(adopted('p2', newStart - 6 * HOUR, newStart));

        replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [fresh] });

        expect(sessionIds()).toEqual(['new', 'p2']);
      });
    });

    // T183
    it('範囲より前のステージありの長い睡眠でも、重なれば消え、今回のステージなしの睡眠が入る', () => {
      const newStart = R - 2 * HOUR;
      seedSession(adopted('p1', newStart - 6 * HOUR, newStart + 2 * HOUR, { asleepMinutes: 480 }));
      const fresh = adopted('new', newStart, newStart + 5 * HOUR, {
        hasStages: false,
        asleepMinutes: 300,
        stages: [{ stage: 'unspecified', startAt: newStart, endAt: newStart + 5 * HOUR }],
      });

      replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [fresh] });

      expect(sessionRows()).toEqual([asRow(fresh)]);
    });

    // T073
    it('消えた睡眠のステージ区間は0件になり、ほかの睡眠のステージは残る', () => {
      const start = R + DAY - 6 * HOUR;
      seedSession(
        adopted('gone', start, R + DAY, {
          stages: [
            { stage: 'light', startAt: start, endAt: start + HOUR },
            { stage: 'deep', startAt: start + HOUR, endAt: start + 2 * HOUR },
            { stage: 'rem', startAt: start + 2 * HOUR, endAt: R + DAY },
          ],
        }),
      );
      seedSession(adopted('kept', R - 3 * DAY - 6 * HOUR, R - 3 * DAY));

      replaceSessions({ rangeStartAt: R, syncStartedAt: T, sessions: [] });

      expect(stageRows('gone')).toEqual([]);
      expect(stageRows('kept')).toEqual([
        { stage: 'light', start_at: R - 3 * DAY - 6 * HOUR, end_at: R - 3 * DAY },
      ]);
    });

    // T074
    it('入れ替えの途中で失敗したら、睡眠・ステージ区間・同期記録はすべて入れ替え前のまま', () => {
      seedSession(adopted('before', R - 3 * DAY - 6 * HOUR, R - 3 * DAY));
      seedSession(adopted('inRange', R + DAY - 6 * HOUR, R + DAY));
      seedSyncState(R - 3 * DAY);
      const snapshot = () => ({
        sessions: sessionRows(),
        stages: allStageRows(),
        syncState: syncStateRows(),
      });
      const before = snapshot();
      // 睡眠の削除と挿入が済んだあと、ステージの挿入で必ず失敗させる
      mockTestDb.sqlite.exec(
        "CREATE TRIGGER fail_stage_insert BEFORE INSERT ON sleep_stages BEGIN SELECT RAISE(ABORT, 'test failure'); END",
      );

      expect(() =>
        replaceSessions({
          rangeStartAt: R,
          syncStartedAt: T,
          sessions: [adopted('new', R + 2 * DAY - 6 * HOUR, R + 2 * DAY)],
        }),
      ).toThrow('test failure');

      expect(snapshot()).toEqual(before);
    });
  });

  describe('読み取り', () => {
    /** 帰属日 date の睡眠（ステージ区間2件つき）。start は JST の就寝日時 */
    const daySession = (id: string, start: string, date: string) => {
      const startAt = new Date(`${start}:00+09:00`).getTime();
      return {
        ...adopted(id, startAt, startAt + 6 * HOUR, {
          stages: [
            { stage: 'light', startAt, endAt: startAt + 2 * HOUR },
            { stage: 'deep', startAt: startAt + 2 * HOUR, endAt: startAt + 6 * HOUR },
          ],
        }),
        wakeDate: date,
      };
    };
    // T075
    it('日ごとの取得・帰属日指定の取得・睡眠の有無が正しく返る', () => {
      // s24 はステージなし（has_stages の 0/1 と真偽値の変換を確かめる）
      const s24Base = daySession('s24', '2026-11-23T23:00', '2026-11-24');
      const s24: SleepSession = {
        ...s24Base,
        hasStages: false,
        stages: [{ stage: 'unspecified', startAt: s24Base.startAt, endAt: s24Base.endAt }],
      };
      const s25a = daySession('s25a', '2026-11-24T23:00', '2026-11-25');
      const s25b = daySession('s25b', '2026-11-25T08:00', '2026-11-25');
      [s24, s25a, s25b].forEach(seedSession);

      // 日ごと：3件（並び順は決めていないので集合で比べる）。ステージ区間は含めない
      const listed = listSessions();
      expect(listed.map((s) => s.id).sort()).toEqual(['s24', 's25a', 's25b']);
      const strip = ({ stages: _s, ...rest }: SleepSession) => rest;
      expect(listed).toEqual(expect.arrayContaining([s24, s25a, s25b].map(strip)));

      // 指定日：s25a・s25b とそれぞれのステージ区間だけ
      const found = findSessionsByWakeDate('2026-11-25');
      expect([...found].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([s25a, s25b]);

      expect(hasAnySession()).toBe(true);
    });

    // T076
    it('DB が空なら、日ごと・指定日は空、有無と同期記録は「なし」', () => {
      expect(listSessions()).toEqual([]);
      expect(findSessionsByWakeDate('2026-11-25')).toEqual([]);
      expect(hasAnySession()).toBe(false);
      expect(readLastSyncedAt()).toBeNull();
    });
  });
});
