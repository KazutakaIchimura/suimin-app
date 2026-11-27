// グラフの画面用の状態（設計書 docs/features/02_sleep-chart.md の 3.1）。
// 表示中の期間を状態に持ち、DB の日ごとの要約から、見出し・平均・日ごとの値を整形済みの画面用の状態にする
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { buildChartDays, chartAverage } from '@/features/sleep-record/sleep-record-chart.service';
import {
  formatAxisClock,
  formatChartDate,
  formatDayLabel,
  formatMinutes,
  formatPeriodTitle,
} from '@/features/sleep-record/sleep-record-format.service';
import {
  canMove,
  clampPeriod,
  localDate,
  periodBounds,
  periodOf,
  shiftPeriod,
  togglePeriod,
} from '@/features/sleep-record/sleep-record-period.service';
import { loadDaySummaries } from '@/features/sleep-record/sleep-record-query.service';
import { useSleepRecordStore } from '@/features/sleep-record/sleep-record.store';
import type {
  ChartBand,
  DaySummary,
  Period,
  PeriodKind,
} from '@/features/sleep-record/sleep-record.types';
import { now } from '@/lib/clock';
import { createRequestId } from '@/lib/request-id';

/** 日ごとの表示（整形済み）。`bar`・`band` は描画の部品に渡す値 */
export type SleepRecordChartDay = {
  wakeDate: string;
  /** グラフの日付の文字（週「25（水）」・月「25」） */
  label: string;
  /** 読み上げの説明 */
  accessibilityLabel: string;
  /** 睡眠のある過去の日だけ押せる（詳細へ移る） */
  pressable: boolean;
  /** 棒の高さ（分。0〜720）。値なしは `null` */
  bar: number | null;
  /** 帯（軸の分。0〜1440）。描かない日は `null` */
  band: ChartBand | null;
};

export type SleepRecordChartState =
  | { kind: 'failed' }
  | {
      kind: 'ready';
      periodKind: PeriodKind;
      title: string;
      canPrev: boolean;
      canNext: boolean;
      /** 期間に睡眠がなければ `null`（「この期間の睡眠データはありません」を出す） */
      average: { total: string; bed: string; wake: string } | null;
      days: SleepRecordChartDay[];
    };

/** DB の読み取りの結果 */
type ChartRead = { kind: 'loaded'; summaries: DaySummary[] } | { kind: 'failed' };

/**
 * DB から日ごとの要約を読む（失敗のログは窓口が `sleepRecord.loadList` で出す）。
 * `_trigger` は読み直しのきっかけ（版番号と再試行の回数）で、値は使わない
 */
function readSummaries(_trigger: string): ChartRead {
  try {
    return { kind: 'loaded', summaries: loadDaySummaries({ requestId: createRequestId() }) };
  } catch {
    return { kind: 'failed' };
  }
}

export function useSleepRecordChart() {
  // React Compiler の最適化から外す。「今日」は描画のたびに現在時刻から取る（3.1）が、Compiler は描画を純粋とみなして
  // `now()` を描画の結果ごとキャッシュし、前面復帰などで描き直しても前の日のままになることがあるため
  'use no memo';
  const dataVersion = useSleepRecordStore((s) => s.dataVersion);
  const sync = useSleepRecordStore((s) => s.sync);
  // 最初に開くのは今日を含む週
  const [selected, setSelected] = useState<Period>(() => periodOf('week', localDate(now())));
  const [readAttempt, setReadAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 前面に戻るたびに増やして描き直す（開いたまま日付が変わったとき、「今日」を取り直すため）
  const [, setForegroundCount] = useState(0);

  useEffect(() => {
    // 「前面に戻った」は 01 の前面復帰の同期（use-sleep-record-sync.ts）と同じく background → active だけ
    let previous: string | null | undefined = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous === 'background' && next === 'active') setForegroundCount((n) => n + 1);
      previous = next;
    });
    return () => subscription.remove();
  }, []);

  // 一覧と同じく、DB の読み取りは同期関数なので描画の中で読み、版番号が上がる・再試行のたびに読み直す
  const readTrigger = `${dataVersion}:${readAttempt}`;
  const read = useMemo(() => readSummaries(readTrigger), [readTrigger]);

  // 「今日」は描画のたびに取る。表示する期間は描画のたびに範囲に収め直す（同期で古い睡眠が消えた・日付が変わった場合）
  const nowDate = now();
  const today = localDate(nowDate);
  const summaries = read.kind === 'loaded' ? read.summaries : [];
  const wakeDates = summaries.map((s) => s.wakeDate);
  // 範囲は週か月かで決まり、収め直しても週か月かは変わらないので、1回だけ求めて使い回す
  const bounds = periodBounds(selected.kind, wakeDates, today);
  const period = clampPeriod(selected, bounds);

  // メモ化は React Compiler に任せる（描画のたびに変わる期間に依存するため useCallback で包まない）
  const move = (delta: 1 | -1) => setSelected(shiftPeriod(period, delta));
  const selectKind = (kind: PeriodKind) => {
    if (kind !== period.kind) setSelected(togglePeriod(period, wakeDates, today));
  };
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await sync();
    } finally {
      setRefreshing(false);
    }
  };
  const retryRead = () => setReadAttempt((n) => n + 1);
  /** 日のタップ：その日の詳細へ移る（睡眠のある過去の日のボタンだけが押せる） */
  const openDay = (wakeDate: string) => router.push(`/sleep/${wakeDate}`);

  let state: SleepRecordChartState;
  if (read.kind === 'failed') {
    state = { kind: 'failed' };
  } else {
    const { prev, next } = canMove(period, bounds);
    const days = buildChartDays(summaries, period, today);
    const average = chartAverage(days);
    state = {
      kind: 'ready',
      periodKind: period.kind,
      title: formatPeriodTitle(period, nowDate),
      canPrev: prev,
      canNext: next,
      average: average && {
        total: formatMinutes(average.asleepMinutes),
        bed: formatAxisClock(average.bedOffset),
        wake: formatAxisClock(average.wakeOffset),
      },
      days: days.map((day) => ({
        wakeDate: day.wakeDate,
        label: formatChartDate(day.wakeDate, period.kind),
        accessibilityLabel: formatDayLabel(day.wakeDate, day.value, nowDate),
        pressable: day.value !== null,
        bar: day.value?.barMinutes ?? null,
        band: day.value?.band ?? null,
      })),
    };
  }

  return {
    state,
    refreshing,
    onRefresh,
    retryRead,
    prev: () => move(-1),
    next: () => move(1),
    selectKind,
    openDay,
  };
}
