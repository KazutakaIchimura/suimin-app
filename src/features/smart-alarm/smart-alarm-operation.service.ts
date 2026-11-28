// アラーム操作の窓口：許可の確認とアラームの設定、解除、設定中のアラームの読み取り、スヌーズの処理と理由の消去、設定を開く
// （設計書 docs/features/03_smart-alarm.md の 3.1・3.5）。失敗はログを出して投げ直し、受け口層（store）が文言にする。
// アラームの時刻・候補はログに出さない（ID と件数だけ）
import { guideOf } from '@/features/smart-alarm/smart-alarm-guide.service';
import * as repository from '@/features/smart-alarm/smart-alarm.repository';
import {
  CancelAfterScheduleError,
  STALE_HANDOFF_MS,
  SnoozeOccurrenceNotFoundError,
  type AlarmSettingsKind,
  type HandoffResult,
  type NextAlarm,
  type SetAlarmResult,
} from '@/features/smart-alarm/smart-alarm.types';
import { logger } from '@/lib/logger';

/** `run` が失敗したら `name` の error ログを出し、同じエラーを投げ直す */
async function logFailure<T>(name: string, requestId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.error(name, { requestId, err });
    throw err;
  }
}

/** このアプリのアラームの ID（予約の一覧と、scheduled の予定の alarmId。重なりは除く） */
async function collectAlarmIds(): Promise<string[]> {
  const [scheduled, occurrences] = await Promise.all([
    repository.listScheduledIds(),
    repository.listOccurrences(),
  ]);
  const fromOccurrences = occurrences.filter((o) => o.phase === 'scheduled').map((o) => o.alarmId);
  return [...new Set([...scheduled, ...fromOccurrences])];
}

/** 1件ずつ順に取り消す（途中で失敗したら残りは呼ばない） */
async function cancelEach(ids: string[]): Promise<void> {
  for (const id of ids) await repository.cancel(id);
}

/**
 * 設定：許可を確かめ、時刻が過ぎていなければ1回だけ鳴るアラームを予約し、新しい ID 以外のアラームを取り消す。
 * 今は許可の要求のあとに `getNow` で取る（許可の確認に時間がかかったときのため）
 */
export async function setAlarm(input: {
  at: number;
  requestId: string;
  getNow: () => number;
}): Promise<SetAlarmResult> {
  const name = 'smartAlarm.schedule';
  const { requestId, at } = input;
  // 窓口の入口で守る（今は候補の計算からしか来ない。画面から来る値の確認なのでログは出さない）
  if (!Number.isFinite(at)) return { kind: 'invalid' };
  const permission = await logFailure(name, requestId, () => repository.requestPermission());
  const guide = guideOf(permission);
  if (!guide.schedule) return { kind: 'blocked', guide };
  if (at <= input.getNow()) return { kind: 'past' };

  const alarmId = await logFailure(name, requestId, () => repository.scheduleOnce(at));
  let cancelled: number;
  try {
    const others = (await collectAlarmIds()).filter((id) => id !== alarmId);
    await cancelEach(others);
    cancelled = others.length;
  } catch (err) {
    logger.error(name, { requestId, err });
    throw new CancelAfterScheduleError(at, err);
  }
  logger.info(name, { requestId, alarmId, cancelled });
  return { kind: 'scheduled', at, guide };
}

/** 設定中のアラーム：scheduled の予定のうち最も早いもの。なければ `null` */
export async function loadNextAlarm(input: { requestId: string }): Promise<NextAlarm | null> {
  const occurrences = await logFailure('smartAlarm.loadNext', input.requestId, () =>
    repository.listOccurrences(),
  );
  const next = occurrences
    .filter((o) => o.phase === 'scheduled')
    .sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
  return next === undefined
    ? null
    : { at: next.scheduledFor, snoozed: next.relationship === 'deferred' };
}

/** 解除：このアプリのアラームをすべて取り消す */
export async function cancelAll(input: { requestId: string }): Promise<void> {
  const name = 'smartAlarm.cancel';
  const cancelled = await logFailure(name, input.requestId, async () => {
    const ids = await collectAlarmIds();
    await cancelEach(ids);
    return ids.length;
  });
  logger.info(name, { requestId: input.requestId, cancelled });
}

/**
 * スヌーズする鳴動：今の鳴動（理由と同じアラームで ID があるもの）、なければ予定の ringing。
 * どちらもなく、そのアラームに scheduled の deferred の予定があれば、スヌーズ済み（前の処理の延期は成功し、
 * 理由の消去に失敗した）としてその予定の時刻を返す
 */
async function findSnoozeTarget(
  alarmId: string,
): Promise<{ occurrenceId: string } | { alreadySnoozedAt: number }> {
  const context = await repository.readCurrentContext();
  // 鳴っている（`alerting`。省略は鳴っているとみなす）ときだけ。スヌーズ済みでまだ鳴っていない鳴動（`countdown` など）は延期し直さない
  const ringingNow = context?.state === undefined || context.state === 'alerting';
  if (
    context !== null &&
    ringingNow &&
    context.id === alarmId &&
    context.occurrenceId !== undefined
  ) {
    return { occurrenceId: context.occurrenceId };
  }
  const occurrences = await repository.listOccurrences(alarmId);
  const ringing = occurrences.find((o) => o.phase === 'ringing');
  if (ringing !== undefined) return { occurrenceId: ringing.occurrenceId };
  const snoozed = occurrences.find((o) => o.phase === 'scheduled' && o.relationship === 'deferred');
  if (snoozed !== undefined) return { alreadySnoozedAt: snoozed.scheduledFor };
  throw new SnoozeOccurrenceNotFoundError();
}

/**
 * アプリを開いた理由を処理する。スヌーズのボタン（`secondaryOpen` で `trigger` でない、10分以内）なら、
 * 今の鳴動を9分後へ延期する。理由の消去は `clearHandoff` で行う（store が呼ぶ）
 */
export async function processHandoff(input: {
  requestId: string;
  now: number;
  /** スヌーズの段階（理由を読み終え、スヌーズすると決めたあと）に入るときに呼ぶ。受け口層が失敗の段階を見分けるため */
  onSnoozeStart?: () => void;
}): Promise<HandoffResult> {
  const name = 'smartAlarm.snooze';
  const { requestId } = input;
  return logFailure(name, requestId, async () => {
    const handoff = await repository.readHandoff();
    if (handoff === null) return { kind: 'none', clear: false };
    const isSnooze = handoff.action === 'secondaryOpen' && !handoff.trigger;
    const isStale = input.now - handoff.timestamp >= STALE_HANDOFF_MS;
    if (!isSnooze || isStale) return { kind: 'clearOnly', clear: true };

    input.onSnoozeStart?.();
    const target = await findSnoozeTarget(handoff.alarmId);
    if ('alreadySnoozedAt' in target) {
      return { kind: 'snoozed', clear: true, nextAt: target.alreadySnoozedAt };
    }
    const { occurrenceId } = target;
    const result = await repository.snooze(occurrenceId, `snooze:${occurrenceId}`);
    logger.info(name, { requestId, alarmId: handoff.alarmId, status: result.status });
    return result.status === 'resolvedWithoutNext' || result.nextAt === null
      ? { kind: 'noNext', clear: true }
      : { kind: 'snoozed', clear: true, nextAt: result.nextAt };
  });
}

/** アプリを開いた理由を消す */
export async function clearHandoff(input: { requestId: string }): Promise<void> {
  await logFailure('smartAlarm.snooze', input.requestId, () => repository.clearHandoff());
}

/** 設定を開く。開けなかった（偽）ときもログを出し、偽を返す */
export async function openSettings(input: {
  kind: AlarmSettingsKind;
  requestId: string;
}): Promise<boolean> {
  const name = 'smartAlarm.openSettings';
  const opened = await logFailure(name, input.requestId, () => repository.openSettings(input.kind));
  if (!opened) logger.error(name, { requestId: input.requestId, opened: false });
  return opened;
}

/** ライブラリの操作のイベント（アプリが動いているあいだに届く）を受ける。戻り値で購読をやめる */
export function subscribeAlarmActions(listener: () => void): () => void {
  return repository.subscribeAlarmActions(listener);
}
