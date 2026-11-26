// 詳細画面用の状態（設計書 3.1「読み込み中の表示」・3.4「詳細」「詳細画面の日付パラメータ」）。
// 日付パラメータを検証し、指定日の詳細を整形済みの画面用の状態にする
import { useCallback, useMemo, useState } from 'react';

import { parseWakeDate } from '@/features/sleep-record/sleep-record-date.service';
import { formatMinutes, formatTime } from '@/features/sleep-record/sleep-record-format.service';
import { loadDayDetail } from '@/features/sleep-record/sleep-record-query.service';
import { useSleepRecordStore } from '@/features/sleep-record/sleep-record.store';
import type { DayDetail, SleepSession, Stage } from '@/features/sleep-record/sleep-record.types';
import { createRequestId } from '@/lib/request-id';

/** 睡眠1件の表示（整形済み） */
export type SleepRecordDetailSleep = { timeLabel: string; totalLabel: string };

export type SleepRecordDetailState =
  | { kind: 'loading' }
  | { kind: 'invalidDate' }
  | { kind: 'failed' }
  | { kind: 'none' }
  | {
      kind: 'found';
      main: SleepRecordDetailSleep;
      /** ステージ内訳の行（「深い 1時間30分 20%」の形）。出す行がなければ `null`（「ステージ情報なし」） */
      breakdown: string[] | null;
      naps: (SleepRecordDetailSleep & { id: string })[];
    };

const STAGE_LABEL: Record<Stage, string> = {
  deep: '深い',
  light: '浅い',
  rem: 'REM',
  awake: '覚醒',
  unspecified: '不明',
};

/** DB の読み取りの結果 */
type DetailRead = { kind: 'loaded'; detail: DayDetail } | { kind: 'failed' };

/**
 * DB から指定日の詳細を読む（失敗のログは窓口が出す。日付はログに出さない）。
 * `_trigger` は読み直しのきっかけ（版番号と再試行の回数）で、値は使わない
 */
function readDetail(wakeDate: string | null, _trigger: string): DetailRead | null {
  if (wakeDate === null) return null;
  try {
    return { kind: 'loaded', detail: loadDayDetail({ wakeDate, requestId: createRequestId() }) };
  } catch {
    return { kind: 'failed' };
  }
}

function toSleep(session: SleepSession): SleepRecordDetailSleep {
  return {
    timeLabel: `${formatTime(session.startAt)}〜${formatTime(session.endAt)}`,
    totalLabel: formatMinutes(session.asleepMinutes),
  };
}

export function useSleepRecordDetail(dateParam: string | string[] | undefined) {
  const accessStatus = useSleepRecordStore((s) => s.accessStatus);
  const dataVersion = useSleepRecordStore((s) => s.dataVersion);
  const [readAttempt, setReadAttempt] = useState(0);
  const wakeDate = parseWakeDate(dateParam);

  // 一覧と同じく、DB の読み取りは同期関数なので描画の中で読み、版番号が上がる（同期が成功する）たび・再試行のたびに読み直す
  const readTrigger = `${dataVersion}:${readAttempt}`;
  const read = useMemo(() => readDetail(wakeDate, readTrigger), [wakeDate, readTrigger]);

  const retryRead = useCallback(() => setReadAttempt((n) => n + 1), []);

  let state: SleepRecordDetailState;
  if (read === null) {
    state = { kind: 'invalidDate' };
  } else if (accessStatus === null) {
    state = { kind: 'loading' };
  } else if (read.kind === 'failed') {
    state = { kind: 'failed' };
  } else if (read.detail.kind === 'none') {
    state = { kind: 'none' };
  } else {
    const { main, breakdown, naps } = read.detail;
    state = {
      kind: 'found',
      main: toSleep(main),
      breakdown:
        breakdown !== null && breakdown.length > 0
          ? breakdown.map(
              (row) => `${STAGE_LABEL[row.stage]} ${formatMinutes(row.minutes)} ${row.percent}%`,
            )
          : null,
      naps: naps.map((nap) => ({ id: nap.id, ...toSleep(nap) })),
    };
  }

  return { state, retryRead };
}
