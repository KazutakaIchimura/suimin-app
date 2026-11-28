// 睡眠の一覧から、日ごとの要約と1日の詳細を作る（設計書 3.1「主睡眠」「昼寝」・3.4）。純粋関数
import type {
  DayDetail,
  DaySummary,
  SleepSession,
  SleepSessionSummary,
  Stage,
  StageBreakdownRow,
} from '@/features/sleep-record/sleep-record.types';

const MINUTE_MS = 60 * 1000;

/** 内訳の並び順（深い・浅い・REM・覚醒・不明） */
const BREAKDOWN_ORDER: readonly Stage[] = ['deep', 'light', 'rem', 'awake', 'unspecified'];

/** 日ごとの要約一覧（帰属日の新しい順。睡眠のない日は含まない） */
export function buildDaySummaries(sessions: SleepSessionSummary[]): DaySummary[] {
  return [...groupByWakeDate(sessions)]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([wakeDate, list]) => {
      const { main, naps } = splitMain(list);
      return {
        wakeDate,
        totalAsleepMinutes: list.reduce((sum, s) => sum + s.asleepMinutes, 0),
        mainStartAt: main.startAt,
        mainEndAt: main.endAt,
        napCount: naps.length,
      };
    });
}

/**
 * 帰属日ごとの主睡眠だけを、帰属日の古い順に返す（ステージ区間はそのまま）。
 * 他機能（スマートアラームの推定。設計書 03 の 3.3）が使う。主睡眠の決め方は `splitMain` の1か所に保つ
 */
export function pickMainSessions(sessions: SleepSession[]): SleepSession[] {
  return [...groupByWakeDate(sessions)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, list]) => splitMain(list).main);
}

/** 指定した帰属日の詳細（主睡眠・ステージ内訳・昼寝）を作る */
export function buildDayDetail(sessions: SleepSession[], wakeDate: string): DayDetail {
  const sameDay = sessions.filter((s) => s.wakeDate === wakeDate);
  if (sameDay.length === 0) return { kind: 'none' };
  const { main, naps } = splitMain(sameDay);
  return { kind: 'found', main, breakdown: main.hasStages ? buildBreakdown(main) : null, naps };
}

/** 睡眠を帰属日ごとにまとめる（並び順は決めない） */
function groupByWakeDate<S extends SleepSessionSummary>(sessions: S[]): Map<string, S[]> {
  const byDate = new Map<string, S[]>();
  for (const session of sessions) {
    byDate.set(session.wakeDate, [...(byDate.get(session.wakeDate) ?? []), session]);
  }
  return byDate;
}

/**
 * 同じ帰属日の睡眠（1件以上）を主睡眠と昼寝に分ける。
 * 主睡眠は睡眠時間が最も長いもの（同じなら就寝が早いほう）、昼寝は就寝の早い順
 */
function splitMain<S extends SleepSessionSummary>(sameDay: S[]): { main: S; naps: S[] } {
  const [main, ...rest] = [...sameDay].sort(
    (a, b) => b.asleepMinutes - a.asleepMinutes || a.startAt - b.startAt,
  );
  return { main, naps: rest.sort((a, b) => a.startAt - b.startAt) };
}

/**
 * 主睡眠のステージ内訳。分は切り捨て、割合は四捨五入（.5 は切り上げ）。1分未満のステージは出さない。
 * 分母はステージ区間の合計（iOS でまとめた空きは含めず、出さない1分未満のステージは含める）
 */
function buildBreakdown(session: SleepSession): StageBreakdownRow[] {
  const total = session.stages.reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
  return BREAKDOWN_ORDER.map((stage) => {
    const ms = session.stages
      .filter((s) => s.stage === stage)
      .reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
    // ms * 100 を先に計算し、12.5% などが 12.4999… にずれないようにする
    return { stage, minutes: Math.floor(ms / MINUTE_MS), percent: Math.round((ms * 100) / total) };
  }).filter((row) => row.minutes > 0);
}
