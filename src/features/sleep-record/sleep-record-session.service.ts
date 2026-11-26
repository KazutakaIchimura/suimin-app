// セグメントから睡眠を組み立てる（設計書 3.1「セグメントから睡眠への組み立て」）。純粋関数
import type {
  AndroidSegment,
  HealthSegment,
  IosSegment,
  SleepSession,
  Stage,
  StageInterval,
} from '@/features/sleep-record/sleep-record.types';

/** iOS で同じ睡眠にまとめる空きの上限（ちょうどを含む） */
const IOS_MERGE_GAP_MS = 30 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/** 記録元が欠けたときの代わりの値 */
const UNKNOWN_SOURCE = 'unknown';

/** 重なる部分で採用するステージの優先度（大きいほど優先）。具体的なステージを「不明」より優先する */
const STAGE_PRIORITY: Record<Stage, number> = {
  deep: 5,
  rem: 4,
  light: 3,
  awake: 2,
  unspecified: 1,
};

/** 1つの睡眠にまとめたセグメント */
type Group = { id: string; sourceId: string; segments: HealthSegment[] };

/**
 * セグメントから睡眠を組み立てる：欠けた ID を補う → 長さ0以下を捨てる → まとめる →
 * ステージ区間にする → 0分の睡眠を捨てる → 睡眠どうしの重なりを除く
 */
export function buildSessions(segments: HealthSegment[]): SleepSession[] {
  const filled = segments.map(fillIds);
  const iosSegments = filled.filter((s): s is IosSegment => s.os === 'ios' && hasLength(s));
  // Android はステージがすべて捨てられたかを見るため、まとめたあとで捨てる
  const androidSegments = filled.filter((s): s is AndroidSegment => s.os === 'android');
  const sessions = [...groupIos(iosSegments), ...groupAndroid(androidSegments)]
    .map(toSession)
    // 睡眠時間が0分の睡眠は捨てる（DB の `asleep_minutes > 0` に違反しないように）
    .filter((session) => session.asleepMinutes > 0);
  return removeOverlaps(sessions);
}

/** 有効なセグメントの件数（設計書 3.1「セグメントの件数」） */
export function countValidSegments(segments: HealthSegment[]): number {
  const filled = segments.map(fillIds);
  const iosCount = filled.filter((s) => s.os === 'ios' && hasLength(s)).length;
  // Android は組み立てと同じく SleepSession ごとにまとめ、まとめたあとのセグメントの数を数える
  const androidCount = groupAndroid(
    filled.filter((s): s is AndroidSegment => s.os === 'android'),
  ).reduce((sum, group) => sum + group.segments.length, 0);
  return iosCount + androidCount;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * 欠けた ID・記録元に代わりの値を付ける。ID は「<記録元>:<開始>:<終了>」で、同じ記録なら毎回同じ値になる
 * （iOS はそのサンプルの時刻、Android は SleepSession の時刻）
 */
function fillIds(seg: HealthSegment): HealthSegment {
  const sourceId = present(seg.sourceId) ? seg.sourceId : UNKNOWN_SOURCE;
  if (seg.os === 'ios') {
    const sampleId = present(seg.sampleId)
      ? seg.sampleId
      : `${sourceId}:${seg.startAt}:${seg.endAt}`;
    return { ...seg, sourceId, sampleId };
  }
  const sessionId = present(seg.sessionId)
    ? seg.sessionId
    : `${sourceId}:${seg.sessionStartAt}:${seg.sessionEndAt}`;
  return { ...seg, sourceId, sessionId };
}

/** 長さ0以下のセグメント（DB の `end_at > start_at` に違反する）でないか */
function hasLength(seg: { startAt: number; endAt: number }): boolean {
  return seg.endAt > seg.startAt;
}

/**
 * iOS：同じ記録元のセグメントを開始時刻順に並べ、それまでの最も遅い終了から
 * 次の開始までの空きが30分以下（重なりを含む）なら同じ睡眠にまとめる
 */
function groupIos(segments: IosSegment[]): Group[] {
  const bySource = new Map<string, IosSegment[]>();
  for (const seg of segments) {
    const key = seg.sourceId ?? '';
    bySource.set(key, [...(bySource.get(key) ?? []), seg]);
  }

  const groups: Group[] = [];
  for (const [sourceId, list] of bySource) {
    // 開始時刻順。開始が同じなら UUID の辞書順（睡眠の id を先頭のサンプルで決めるため）
    const sorted = [...list].sort(
      (a, b) => a.startAt - b.startAt || ((a.sampleId ?? '') < (b.sampleId ?? '') ? -1 : 1),
    );
    let current: IosSegment[] = [];
    let latestEnd = -Infinity;
    for (const seg of sorted) {
      if (current.length > 0 && seg.startAt - latestEnd > IOS_MERGE_GAP_MS) {
        groups.push(toIosGroup(sourceId, current));
        current = [];
        latestEnd = -Infinity;
      }
      current.push(seg);
      latestEnd = Math.max(latestEnd, seg.endAt);
    }
    if (current.length > 0) groups.push(toIosGroup(sourceId, current));
  }
  return groups;
}

/** iOS でまとめた睡眠の id は、先頭（開始が最も早い）サンプルの UUID */
function toIosGroup(sourceId: string, segments: IosSegment[]): Group {
  return { id: segments[0].sampleId ?? '', sourceId, segments };
}

/**
 * Android：同じ SleepSession のセグメントを1つの睡眠にまとめる。
 * ステージがすべて長さ0以下で捨てられたセッションは、セッション全体を1件の `unspecified` にする
 */
function groupAndroid(segments: AndroidSegment[]): Group[] {
  const bySession = new Map<string, AndroidSegment[]>();
  for (const seg of segments) {
    const id = seg.sessionId ?? '';
    bySession.set(id, [...(bySession.get(id) ?? []), seg]);
  }

  const groups: Group[] = [];
  for (const [id, list] of bySession) {
    const first = list[0];
    const valid = list.filter(hasLength);
    const whole: AndroidSegment = {
      ...first,
      stage: 'unspecified',
      startAt: first.sessionStartAt,
      endAt: first.sessionEndAt,
    };
    const used = valid.length > 0 ? valid : hasLength(whole) ? [whole] : [];
    if (used.length > 0) groups.push({ id, sourceId: first.sourceId ?? '', segments: used });
  }
  return groups;
}

/**
 * 同じ睡眠内のセグメントの重なりを解消し、重ならないステージ区間にする。
 * 境界で区切った各区間に、覆っているセグメントのうち最も優先度の高いステージを採用し、
 * 隣り合う同じステージの区間は1つにつなぐ（空きを挟むものはつながない）
 */
function resolveStages(segments: HealthSegment[]): StageInterval[] {
  const bounds = [...new Set(segments.flatMap((s) => [s.startAt, s.endAt]))].sort((a, b) => a - b);
  const intervals: StageInterval[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const startAt = bounds[i];
    const endAt = bounds[i + 1];
    const covering = segments.filter((s) => s.startAt < endAt && s.endAt > startAt);
    if (covering.length === 0) continue;
    const stage = covering.reduce((best, s) =>
      STAGE_PRIORITY[s.stage] > STAGE_PRIORITY[best.stage] ? s : best,
    ).stage;
    const last = intervals[intervals.length - 1];
    if (last && last.stage === stage && last.endAt === startAt) {
      last.endAt = endAt;
    } else {
      intervals.push({ stage, startAt, endAt });
    }
  }
  return intervals;
}

/** 端末のタイムゾーンでの日付 `YYYY-MM-DD` */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toSession(group: Group): SleepSession {
  const stages = resolveStages(group.segments);
  const asleepMs = stages
    .filter((s) => s.stage !== 'awake')
    .reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
  // 就寝・起床は覚醒を含むセグメントの範囲
  const startAt = Math.min(...stages.map((s) => s.startAt));
  const endAt = Math.max(...stages.map((s) => s.endAt));
  return {
    id: group.id,
    sourceId: group.sourceId,
    startAt,
    endAt,
    // 帰属日は起床時刻の日付
    wakeDate: localDate(endAt),
    asleepMinutes: Math.floor(asleepMs / MINUTE_MS),
    hasStages: stages.some((s) => s.stage === 'light' || s.stage === 'deep' || s.stage === 'rem'),
    stages,
  };
}

/**
 * 重なり排除で先に残す順。負なら a を先にする：
 * ステージあり → 睡眠時間が長い → 記録元IDの辞書順 → 就寝が早い → 睡眠 id の辞書順
 */
function compareForKeep(a: SleepSession, b: SleepSession): number {
  if (a.hasStages !== b.hasStages) return a.hasStages ? -1 : 1;
  if (a.asleepMinutes !== b.asleepMinutes) return b.asleepMinutes - a.asleepMinutes;
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  if (a.startAt !== b.startAt) return a.startAt - b.startAt;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** 1ミリ秒でも重なるか（終了と開始がちょうど同じなら重ならない） */
function overlaps(a: SleepSession, b: SleepSession): boolean {
  return a.startAt < b.endAt && a.endAt > b.startAt;
}

/** 優先順に並べ、先頭から「すでに残した睡眠と重ならなければ残す」を繰り返す */
function removeOverlaps(sessions: SleepSession[]): SleepSession[] {
  const kept: SleepSession[] = [];
  for (const session of [...sessions].sort(compareForKeep)) {
    if (!kept.some((k) => overlaps(k, session))) kept.push(session);
  }
  return kept;
}
