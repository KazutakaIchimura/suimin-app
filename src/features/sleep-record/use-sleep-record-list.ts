// 一覧画面用の状態（設計書 3.1「連携状態と案内」「読み込み中の表示」・3.4）。
// store の連携状態と DB の睡眠から、案内と整形済みの日ごとの行を作る
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import {
  formatDate,
  formatMinutes,
  formatTime,
} from '@/features/sleep-record/sleep-record-format.service';
import { buildGuides } from '@/features/sleep-record/sleep-record-guide.service';
import { loadDaySummaries } from '@/features/sleep-record/sleep-record-query.service';
import { useSleepRecordStore } from '@/features/sleep-record/sleep-record.store';
import type {
  DaySummary,
  Guide,
  GuideAction,
  HealthOs,
} from '@/features/sleep-record/sleep-record.types';
import { now } from '@/lib/clock';
import { createRequestId } from '@/lib/request-id';

/** 一覧の1行（整形済み） */
export type SleepRecordListRow = {
  wakeDate: string;
  dateLabel: string;
  totalLabel: string;
  timeLabel: string;
  /** 昼寝がなければ `null` */
  napLabel: string | null;
};

export type SleepRecordListState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      guides: Guide[];
      /** 許可の要求中（「連携する」ボタンを押せなくする） */
      requesting: boolean;
      /** 許可の要求・設定を開くの失敗の表示 */
      errors: string[];
      /** DB の読み取りに失敗したら `null`（「睡眠データを読み込めませんでした」を出す） */
      rows: SleepRecordListRow[] | null;
    };

/** DB の読み取りの結果 */
type ListRead = { kind: 'loaded'; summaries: DaySummary[] } | { kind: 'failed' };

/**
 * DB から日ごとの要約一覧を読む（失敗のログは窓口が出す）。
 * `_trigger` は読み直しのきっかけ（版番号と再試行の回数）で、値は使わない（これが変わったときだけ読み直す）
 */
function readList(_trigger: string): ListRead {
  try {
    return { kind: 'loaded', summaries: loadDaySummaries({ requestId: createRequestId() }) };
  } catch {
    return { kind: 'failed' };
  }
}

function toRow(day: DaySummary, today: Date): SleepRecordListRow {
  return {
    wakeDate: day.wakeDate,
    dateLabel: formatDate(day.wakeDate, today),
    totalLabel: formatMinutes(day.totalAsleepMinutes),
    timeLabel: `${formatTime(day.mainStartAt)}〜${formatTime(day.mainEndAt)}`,
    napLabel: day.napCount > 0 ? `昼寝 ${day.napCount}件` : null,
  };
}

export function useSleepRecordList() {
  const store = useSleepRecordStore(
    useShallow((s) => ({
      accessStatus: s.accessStatus,
      syncing: s.syncing,
      lastSyncError: s.lastSyncError,
      dataVersion: s.dataVersion,
      requestingAccess: s.requestingAccess,
      requestAccessFailed: s.requestAccessFailed,
      openSettingsFailed: s.openSettingsFailed,
      sync: s.sync,
      requestAccess: s.requestAccess,
      openSettings: s.openSettings,
    })),
  );
  const [readAttempt, setReadAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // 初回の描画と、版番号が上がる（同期が成功する）たび・読み取りの再試行のたびに DB から読む。
  // DB の読み取りは同期関数なので描画の中で読み、読み終える前の表示（「読み込み中」や、誤った空の案内）の間を作らない。
  // 読み直しの間も、それまでの表示から結果だけが入れ替わる
  const readTrigger = `${store.dataVersion}:${readAttempt}`;
  const read = useMemo(() => readList(readTrigger), [readTrigger]);

  const { sync, requestAccess, openSettings } = store;
  const onAction = useCallback(
    (action: GuideAction) => {
      switch (action) {
        case 'requestAccess':
          return void requestAccess();
        case 'openSettings':
          return void openSettings();
        case 'retryAccess':
        case 'retrySync':
          return void sync();
      }
    },
    [sync, requestAccess, openSettings],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await sync();
    } finally {
      setRefreshing(false);
    }
  }, [sync]);

  const retryRead = useCallback(() => setReadAttempt((n) => n + 1), []);

  let state: SleepRecordListState;
  if (store.accessStatus === null) {
    state = { kind: 'loading' };
  } else {
    const os: HealthOs = Platform.OS === 'android' ? 'android' : 'ios';
    const errors: string[] = [];
    if (store.requestAccessFailed) errors.push('連携の要求に失敗しました');
    if (store.openSettingsFailed) {
      errors.push(
        'ヘルスコネクトの設定を開けませんでした。設定アプリからヘルスコネクトを開いてください',
      );
    }
    const today = now();
    state = {
      kind: 'ready',
      guides: buildGuides({
        os,
        status: store.accessStatus,
        // 読み取りに失敗したときは、睡眠がないとは言えないので「睡眠データがありません」を出さない
        hasSessions: read.kind === 'failed' || read.summaries.length > 0,
        syncing: store.syncing,
        syncFailed: store.lastSyncError !== null,
      }),
      requesting: store.requestingAccess,
      errors,
      rows: read.kind === 'loaded' ? read.summaries.map((d) => toRow(d, today)) : null,
    };
  }

  /** 「週・月の推移」：グラフの画面へ移る（02） */
  const openChart = () => router.push('/chart');

  return { state, refreshing, onRefresh, onAction, retryRead, openChart };
}
