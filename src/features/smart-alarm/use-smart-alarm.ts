// アラームの画面のフック（設計書 docs/features/03_smart-alarm.md の 3.1・3.3・3.4）。
// 使う値（DB を描画の中で読む）、今から寝る・起床時刻を指定の候補、store の状態を、整形済みの画面用の状態にする
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import {
  effectiveBedtime,
  nowCandidates,
  resolveBedtime,
  resolveWakeTime,
  wakeCandidates,
} from '@/features/smart-alarm/smart-alarm-candidate.service';
import { standardCycleParams } from '@/features/smart-alarm/smart-alarm-estimate.service';
import {
  PARAMS_FAILED_MESSAGE,
  RESULT_MESSAGES,
  formatBedtimeLabel,
  formatCandidate,
  formatNextAlarm,
  formatParams,
  formatWakeLabel,
} from '@/features/smart-alarm/smart-alarm-format.service';
import { loadCycleParams } from '@/features/smart-alarm/smart-alarm-params.service';
import { useSmartAlarmStore } from '@/features/smart-alarm/smart-alarm.store';
import { DEFAULT_WAKE, type AlarmCandidate } from '@/features/smart-alarm/smart-alarm.types';
import { now } from '@/lib/clock';
import { createRequestId } from '@/lib/request-id';

/** 画面に出す候補のボタン */
export type CandidateButton = { key: string; at: number; label: string };

const toButtons = (list: AlarmCandidate[], mode: 'now' | 'wake'): CandidateButton[] =>
  list.map((c) => ({ key: `${mode}-${c.at}`, at: c.at, label: formatCandidate(c, mode) }));

/**
 * 使う値を読む（失敗したら標準値と失敗の印。ログは 01 の窓口が出している）。
 * `_attempt` は読み直すきっかけの回数（useMemo の依存に使う）
 */
function readParams(_attempt: number) {
  try {
    return { params: loadCycleParams({ now: now(), requestId: createRequestId() }), failed: false };
  } catch {
    return { params: standardCycleParams(), failed: true };
  }
}

export function useSmartAlarm() {
  // 「今」を描画のたびに取るため、React Compiler の最適化から外す（Compiler は now() を描画の結果ごとキャッシュするため。02 と同じ）
  'use no memo';
  const store = useSmartAlarmStore(
    useShallow((s) => ({
      next: s.next,
      result: s.result,
      busy: s.busy,
      reloadNext: s.reloadNext,
      set: s.set,
      cancel: s.cancel,
      openSettings: s.openSettings,
      snoozeRetry: s.snoozeRetry,
      handleHandoff: s.handleHandoff,
    })),
  );
  const { reloadNext } = store;
  /** 使う値を読み直すきっかけ（画面を開いたとき・前面に戻ったとき） */
  const [readAttempt, setReadAttempt] = useState(0);
  /** 選んだ就寝予定時刻（UNIX ミリ秒）。選んでいなければ `null` */
  const [chosenBedtime, setChosenBedtime] = useState<number | null>(null);
  const [wake, setWake] = useState<{ hour: number; minute: number }>(DEFAULT_WAKE);

  useEffect(() => {
    void reloadNext();
  }, [reloadNext]);

  useEffect(() => {
    let last: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (state) => {
      if (last === 'background' && state === 'active') setReadAttempt((n) => n + 1);
      last = state;
    });
    return () => sub.remove();
  }, []);

  // 01 の DB の読み取りは同期関数なので、描画の中で読む（読み直すのはきっかけの回数が変わったときだけ）
  const { params, failed } = useMemo(() => readParams(readAttempt), [readAttempt]);

  const current = now().getTime();
  const bedtime = effectiveBedtime(current, chosenBedtime);
  const wakeAt = resolveWakeTime(bedtime, wake.hour, wake.minute);
  const nowDate = new Date(current);

  return {
    nextLabel: store.next.kind === 'loaded' ? formatNextAlarm(store.next.next, nowDate) : null,
    nextFailed: store.next.kind === 'failed',
    nextFailedMessage: RESULT_MESSAGES.loadNextFailed,
    canCancel: store.next.kind === 'loaded' && store.next.next !== null,
    busy: store.busy,
    messages: store.result.messages,
    settings: store.result.settings,
    paramsLabel: formatParams(params),
    paramsFailedMessage: failed ? PARAMS_FAILED_MESSAGE : null,
    nowButtons: toButtons(nowCandidates(current, params), 'now'),
    bedtime: { label: formatBedtimeLabel(bedtime), value: bedtime },
    wake: { label: formatWakeLabel(wakeAt), value: wakeAt },
    wakeButtons: toButtons(wakeCandidates(bedtime, wakeAt, params), 'wake'),
    pickBedtime: (hour: number, minute: number) =>
      setChosenBedtime(resolveBedtime(now().getTime(), hour, minute)),
    pickWake: (hour: number, minute: number) => setWake({ hour, minute }),
    choose: (at: number) => void store.set(at),
    cancel: () => void store.cancel(),
    openSettings: () => {
      if (store.result.settings !== null) void store.openSettings(store.result.settings);
    },
    retryNext: () => void reloadNext(),
    /** スヌーズの「再試行」を出すか */
    snoozeRetry: store.snoozeRetry,
    /** スヌーズをやり直す（理由の読み取りから。すでにアラームの画面にいるので移らない） */
    retrySnooze: () => void store.handleHandoff(),
  };
}
