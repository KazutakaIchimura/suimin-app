// 画面をまたいで共有するスマートアラームの状態と、その操作（設計書 docs/features/03_smart-alarm.md の 3.1・3.3・3.4）。
// 一覧の入口・アラームの画面・アプリを開いた理由の処理が同じ状態を使う。
// 窓口（サービス層）が投げたエラーはここで受け取り、画面の文言にする（ログは窓口が出している）
import { create } from 'zustand';

import {
  RESULT_MESSAGES,
  formatScheduled,
  formatScheduledButNotCancelled,
  formatSnoozed,
} from '@/features/smart-alarm/smart-alarm-format.service';
import {
  cancelAll,
  clearHandoff,
  loadNextAlarm,
  openSettings as openAlarmSettings,
  processHandoff,
  setAlarm,
} from '@/features/smart-alarm/smart-alarm-operation.service';
import {
  CancelAfterScheduleError,
  type AlarmSettingsKind,
  type NextAlarmState,
} from '@/features/smart-alarm/smart-alarm.types';
import { now } from '@/lib/clock';
import { createRequestId } from '@/lib/request-id';

/** 最後の操作の結果（文言と「設定を開く」のボタン）。次の操作をすると入れ替わる */
export type OperationResult = {
  messages: string[];
  settings: AlarmSettingsKind | null;
};

const EMPTY_RESULT: OperationResult = { messages: [], settings: null };

type SmartAlarmState = {
  /** 設定中のアラームの読み取りの状態 */
  next: NextAlarmState;
  /** 最後の操作の結果 */
  result: OperationResult;
  /** 設定・解除の処理中か（候補・解除のボタンを押せなくする） */
  busy: boolean;
  /** 設定中のアラームを読み直す。重なったときは、最後に始めた読み直しの結果だけを使う */
  reloadNext: () => Promise<void>;
  /** `at`（UNIX ミリ秒）にアラームを設定する */
  set: (at: number) => Promise<void>;
  /** アラームを解除する */
  cancel: () => Promise<void>;
  /** 設定を開く。開けなければ失敗の文言を足す */
  openSettings: (kind: AlarmSettingsKind) => Promise<void>;
  /** スヌーズが例外で失敗し、やり直せるか（「再試行」を出す） */
  snoozeRetry: boolean;
  /**
   * アプリを開いた理由を処理する（3.1「スヌーズ」）。アラームの画面へ移るべきなら `'navigate'` を返す。
   * 理由の読み取りの失敗は何も出さない（スヌーズかどうか分からないため）。スヌーズの失敗は失敗の文言と「再試行」
   */
  handleHandoff: () => Promise<'navigate' | 'stay'>;
};

/** 読み直しの番号。終わったときに最新の番号でなければ結果を捨てる（古い結果で新しい状態を上書きしない） */
let reloadSeq = 0;

export const useSmartAlarmStore = create<SmartAlarmState>((set, get) => ({
  next: { kind: 'loading' },
  result: EMPTY_RESULT,
  busy: false,
  snoozeRetry: false,
  reloadNext: async () => {
    reloadSeq += 1;
    const seq = reloadSeq;
    try {
      const next = await loadNextAlarm({ requestId: createRequestId() });
      if (seq === reloadSeq) set({ next: { kind: 'loaded', next } });
    } catch {
      if (seq === reloadSeq) set({ next: { kind: 'failed' } });
    }
  },
  set: async (at) => {
    // 処理中にもう一度呼ばれたら何もしない（新旧のアラームが互いを取り消して0件になるのを防ぐ）
    if (get().busy) return;
    set({ busy: true, result: EMPTY_RESULT, snoozeRetry: false });
    try {
      const outcome = await setAlarm({
        at,
        requestId: createRequestId(),
        getNow: () => now().getTime(),
      });
      if (outcome.kind === 'invalid') {
        set({ result: { messages: [RESULT_MESSAGES.scheduleFailed], settings: null } });
      } else if (outcome.kind === 'past') {
        set({ result: { messages: [RESULT_MESSAGES.past], settings: null } });
      } else if (outcome.kind === 'blocked') {
        const messages = outcome.guide.message === null ? [] : [outcome.guide.message];
        set({ result: { messages, settings: outcome.guide.settings } });
      } else {
        const messages = [formatScheduled(outcome.at)];
        if (outcome.guide.message !== null) messages.push(outcome.guide.message);
        set({ result: { messages, settings: outcome.guide.settings } });
      }
    } catch (err) {
      const message =
        err instanceof CancelAfterScheduleError
          ? formatScheduledButNotCancelled(err.at)
          : RESULT_MESSAGES.scheduleFailed;
      set({ result: { messages: [message], settings: null } });
    } finally {
      // 成功・失敗にかかわらず読み直す（途中で失敗したときに実際の状態を出すため）
      await get().reloadNext();
      set({ busy: false });
    }
  },
  cancel: async () => {
    if (get().busy) return;
    set({ busy: true, result: EMPTY_RESULT, snoozeRetry: false });
    try {
      await cancelAll({ requestId: createRequestId() });
      set({ result: { messages: [RESULT_MESSAGES.cancelled], settings: null } });
    } catch {
      set({ result: { messages: [RESULT_MESSAGES.cancelFailed], settings: null } });
    } finally {
      await get().reloadNext();
      set({ busy: false });
    }
  },
  handleHandoff: async () => {
    const requestId = createRequestId();
    let snoozing = false;
    /** 理由を消す。失敗してもログは窓口が出しているので、表示は変えない */
    const clear = async () => {
      try {
        await clearHandoff({ requestId });
      } catch {
        // スヌーズの結果はそのまま出す（3.1）
      }
    };
    try {
      const outcome = await processHandoff({
        requestId,
        now: now().getTime(),
        onSnoozeStart: () => {
          snoozing = true;
        },
      });
      // 窓口が「消してよい」とした理由だけを消す
      if (outcome.clear) await clear();
      if (outcome.kind === 'none' || outcome.kind === 'clearOnly') {
        // 再試行の時点で理由が古くなっていた・なくなっていたら、出ていた失敗の表示と「再試行」も消す
        if (get().snoozeRetry) set({ snoozeRetry: false, result: EMPTY_RESULT });
        return 'stay';
      }
      const message =
        outcome.kind === 'snoozed' ? formatSnoozed(outcome.nextAt) : RESULT_MESSAGES.snoozeFailed;
      set({ snoozeRetry: false, result: { messages: [message], settings: null } });
      void get().reloadNext();
      return 'navigate';
    } catch {
      if (!snoozing) return 'stay';
      set({
        snoozeRetry: true,
        result: { messages: [RESULT_MESSAGES.snoozeFailed], settings: null },
      });
      void get().reloadNext();
      return 'navigate';
    }
  },
  openSettings: async (kind) => {
    let opened: boolean;
    try {
      opened = await openAlarmSettings({ kind, requestId: createRequestId() });
    } catch {
      opened = false;
    }
    const { result } = get();
    // 続けて失敗しても同じ文言は重ねない
    if (!opened && !result.messages.includes(RESULT_MESSAGES.openSettingsFailed)) {
      set({
        result: { ...result, messages: [...result.messages, RESULT_MESSAGES.openSettingsFailed] },
      });
    }
  },
}));
