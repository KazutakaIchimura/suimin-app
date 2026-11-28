// アラームのライブラリ（react-native-alarm-scheduler）と UUID の生成（expo-crypto）を呼ぶ唯一のファイル
// （設計書 docs/features/03_smart-alarm.md の 3.3）。ライブラリの作者が1人なので、差し替えられるようにここへ閉じる。
// 鳴らし方の設定（3.1「アラームの設定」）もここに置く。ログは窓口（smart-alarm-operation.service.ts）が出す
import { randomUUID } from 'expo-crypto';
import AlarmScheduler from 'react-native-alarm-scheduler';

import {
  RING_MAX_SECONDS,
  SNOOZE_SECONDS,
  type AlarmContextRecord,
  type AlarmHandoff,
  type AlarmOccurrenceRecord,
  type AlarmPermission,
  type AlarmSettingsKind,
  type SnoozeRecord,
} from '@/features/smart-alarm/smart-alarm.types';

const toPermission = (p: AlarmPermission): AlarmPermission => ({
  platform: p.platform,
  status: p.status,
  canScheduleExactAlarms: p.canScheduleExactAlarms,
  canOpenSettings: p.canOpenSettings,
  canUseFullScreenIntent: p.canUseFullScreenIntent,
  canPostNotifications: p.canPostNotifications,
});

/** 許可を求める（まだ決めていなければ OS の確認が出る。決めてあれば今の状態を返す） */
export async function requestPermission(): Promise<AlarmPermission> {
  return toPermission(await AlarmScheduler.requestPermissionsAsync());
}

/** 設定を開く（正確なアラーム／全画面表示）。開けたら真 */
export async function openSettings(kind: AlarmSettingsKind): Promise<boolean> {
  return kind === 'alarm'
    ? AlarmScheduler.openAlarmSettingsAsync()
    : AlarmScheduler.openFullScreenIntentSettingsAsync();
}

/** `at`（UNIX ミリ秒）に1回だけ鳴るアラームを予約し、その ID を返す */
export async function scheduleOnce(at: number): Promise<string> {
  const id = randomUUID();
  const date = new Date(at);
  await AlarmScheduler.scheduleAlarmAsync({
    id,
    hour: date.getHours(),
    minute: date.getMinutes(),
    timestamp: at,
    title: '起床の時間です',
    ios: {
      alertActionMode: 'default',
      stopButtonTitle: '停止',
      secondaryButtonTitle: 'スヌーズ',
      secondaryButtonBehavior: 'openApp',
      stopIntentBehavior: 'recordOnly',
      countdownTitle: 'スヌーズ中',
    },
    android: {
      vibrate: true,
      maxRingDurationSeconds: RING_MAX_SECONDS,
    },
  });
  return id;
}

/** 予約の一覧の ID */
export async function listScheduledIds(): Promise<string[]> {
  return (await AlarmScheduler.getScheduledAlarmsAsync()).map((a) => a.id);
}

/** 鳴動の予定（`alarmId` を渡せばそのアラームのものだけ） */
export async function listOccurrences(alarmId?: string): Promise<AlarmOccurrenceRecord[]> {
  const list =
    alarmId === undefined
      ? await AlarmScheduler.getAlarmOccurrencesAsync()
      : await AlarmScheduler.getAlarmOccurrencesAsync(alarmId);
  return list.map((o) => ({
    occurrenceId: o.occurrenceId,
    alarmId: o.alarmId,
    scheduledFor: o.scheduledFor,
    relationship: o.relationship,
    phase: o.phase,
  }));
}

/** アラームを取り消す */
export async function cancel(alarmId: string): Promise<void> {
  await AlarmScheduler.cancelAlarmAsync(alarmId);
}

/** アプリを開いた理由。なければ `null` */
export async function readHandoff(): Promise<AlarmHandoff | null> {
  const handoff = await AlarmScheduler.getPendingNativeAlarmHandoffAsync();
  if (handoff === null) return null;
  return {
    alarmId: handoff.alarmId,
    action: handoff.action,
    timestamp: handoff.timestamp,
    trigger: handoff.trigger === true,
  };
}

/** アプリを開いた理由を消す */
export async function clearHandoff(): Promise<void> {
  await AlarmScheduler.clearPendingNativeAlarmHandoffAsync();
}

/** 今の鳴動。なければ `null` */
export async function readCurrentContext(): Promise<AlarmContextRecord | null> {
  const context = await AlarmScheduler.getCurrentAlarmContextAsync();
  return context === null
    ? null
    : { id: context.id, occurrenceId: context.occurrenceId, state: context.state };
}

/**
 * ライブラリの操作のイベント（`onAlarmAction`）を受ける。アプリが動いているあいだだけ届く。
 * イベントの中身は使わず、届いたことだけを知らせる。戻り値で購読をやめる
 */
export function subscribeAlarmActions(listener: () => void): () => void {
  const subscription = AlarmScheduler.addListener('onAlarmAction', () => listener());
  return () => subscription.remove();
}

/** 鳴動を延期で終わらせ、9分後に次の鳴動を予約する */
export async function snooze(occurrenceId: string, idempotencyKey: string): Promise<SnoozeRecord> {
  const result = await AlarmScheduler.resolveAlarmOccurrenceAsync(occurrenceId, {
    outcome: 'deferred',
    next: { delaySeconds: SNOOZE_SECONDS, relationship: 'deferred' },
    idempotencyKey,
  });
  return { status: result.status, nextAt: result.nextOccurrence?.scheduledFor ?? null };
}
