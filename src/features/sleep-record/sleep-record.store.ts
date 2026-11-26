// 画面をまたいで共有する睡眠記録の状態と、その操作（設計書 3.1「同期（取り込み）のルール」・3.3）
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  checkAccess,
  openSettings as openHealthSettings,
  requestAccess as requestHealthAccess,
} from '@/features/sleep-record/sleep-record-access.service';
import { syncSleep } from '@/features/sleep-record/sleep-record-sync.service';
import type { AccessStatus, HealthOs } from '@/features/sleep-record/sleep-record.types';
import { now } from '@/lib/clock';
import { createRequestId } from '@/lib/request-id';

type SleepRecordState = {
  /** 連携状態。まだ一度も取れていなければ `null` */
  accessStatus: AccessStatus | null;
  /** sync() の実行中か（連携状態の取得から同期の完了まで。`ready` 以外で終わるときは取得の結果と同時に下ろす） */
  syncing: boolean;
  /** 最後の同期のエラー（次の同期が成功したら消す） */
  lastSyncError: unknown;
  /** データの版番号。同期が成功するたびに上がり、一覧・詳細はこれを見て DB から読み直す */
  dataVersion: number;
  /** 連携状態を取得して入れる */
  refreshAccess: () => Promise<AccessStatus>;
  /** 連携状態を取得し、`ready` なら同期する */
  sync: () => Promise<void>;
  /** 許可の要求中か（「連携する」ボタンを押せなくする） */
  requestingAccess: boolean;
  /** 許可の要求の失敗（次に押したときに消す） */
  requestAccessFailed: boolean;
  /** 許可を求め、成功したら新しく sync() を始める。失敗したら連携状態は取り直さない */
  requestAccess: () => Promise<void>;
  /** 設定を開くの失敗（次に押したときに消す） */
  openSettingsFailed: boolean;
  /** 設定を開く（Android だけ） */
  openSettings: () => Promise<void>;
};

const os = (): HealthOs => (Platform.OS === 'android' ? 'android' : 'ios');

// 実行中の操作。実行中にもう一度呼ばれたら、新しく始めずにこれの完了を待つ
let runningRefresh: Promise<AccessStatus> | null = null;
let runningSync: Promise<void> | null = null;
/** 実行中の sync() が連携状態の取得を待っているか（`ready` 以外なら、連携状態と同じ1回の更新で同期中の印を下ろす） */
let syncAwaitingAccess = false;
/** 次に連携状態を取り直し終えたとき、許可の要求中の印を同じ更新で下ろすか */
let releaseRequestOnAccess = false;

/** `start` で始めた Promise を、終わるまで `hold` に持たせる */
function single<T>(
  current: Promise<T> | null,
  hold: (p: Promise<T> | null) => void,
  start: () => Promise<T>,
): Promise<T> {
  if (current) return current;
  const promise = start().finally(() => hold(null));
  hold(promise);
  return promise;
}

export const useSleepRecordStore = create<SleepRecordState>()((set, get) => {
  const refreshWith = (requestId: string) =>
    single(
      runningRefresh,
      (p) => (runningRefresh = p),
      async () => {
        let status: AccessStatus;
        try {
          status = await checkAccess({ os: os(), requestId });
        } catch {
          // ログは窓口が出している。再試行の案内を出す
          status = 'checkFailed';
        }
        // sync() の途中に「ready・同期中でない」状態を作らないよう、関係する印も同じ1回の更新で入れる
        set({
          accessStatus: status,
          ...(syncAwaitingAccess && status !== 'ready' ? { syncing: false } : {}),
          ...(releaseRequestOnAccess ? { requestingAccess: false } : {}),
        });
        releaseRequestOnAccess = false;
        return status;
      },
    );

  return {
    accessStatus: null,
    syncing: false,
    lastSyncError: null,
    dataVersion: 0,
    refreshAccess: () => refreshWith(createRequestId()),
    sync: () =>
      single(
        runningSync,
        (p) => (runningSync = p),
        async () => {
          const requestId = createRequestId();
          // 同期中の印は連携状態の取得の前に立てる（取得の結果が ready 以外なら、取得の更新で下ろす）
          syncAwaitingAccess = true;
          set({ syncing: true });
          let status: AccessStatus;
          try {
            status = await refreshWith(requestId);
          } finally {
            syncAwaitingAccess = false;
          }
          if (status !== 'ready') return;
          try {
            await syncSleep({ os: os(), requestId, getNow: now });
            set((state) => ({ lastSyncError: null, dataVersion: state.dataVersion + 1 }));
          } catch (err) {
            // ログは同期サービスが出している。画面には失敗の表示を出す
            set({ lastSyncError: err });
          } finally {
            set({ syncing: false });
          }
        },
      ),
    openSettingsFailed: false,
    openSettings: async () => {
      set({ openSettingsFailed: false });
      try {
        await openHealthSettings({ os: os(), requestId: createRequestId() });
      } catch {
        // ログは窓口が出している。画面には「設定を開けませんでした」を出す
        set({ openSettingsFailed: true });
      }
    },
    requestingAccess: false,
    requestAccessFailed: false,
    requestAccess: async () => {
      // 要求中（連携状態を取り直し終えるまで）は、もう一度呼ばれても要求を重ねない
      if (get().requestingAccess) return;
      set({ requestingAccess: true, requestAccessFailed: false });
      try {
        await requestHealthAccess({ os: os(), requestId: createRequestId() });
      } catch {
        // ログは窓口が出している。ボタンは押せるまま残し、連携状態は取り直さない
        set({ requestingAccess: false, requestAccessFailed: true });
        return;
      }
      // 実行中の sync() には合流しない（許可の前に読んだ古い連携状態で終わるため）。
      // 終わるのを待ってから、要求とは別の操作として連携状態の取得から始める。
      // 要求中の印は、その取得を終えた更新で下ろす（同期の完了は待たない）
      while (runningSync) await runningSync;
      releaseRequestOnAccess = true;
      await get().sync();
    },
  };
});
