// 一覧の入口のフック（設計書 docs/features/03_smart-alarm.md の 3.3・3.4）。
// store の設定中のアラームを文言にし、アラームの画面へ移る関数を返す。開いたときに読み直す
import { router } from 'expo-router';
import { useEffect } from 'react';

import { formatEntry } from '@/features/smart-alarm/smart-alarm-format.service';
import { useSmartAlarmStore } from '@/features/smart-alarm/smart-alarm.store';
import { now } from '@/lib/clock';

export function useSmartAlarmEntry() {
  // 「今日でなければ日付を付ける」の今日を描画のたびに取るため、React Compiler の最適化から外す（02 のグラフのフックと同じ）
  'use no memo';
  const next = useSmartAlarmStore((s) => s.next);
  const reloadNext = useSmartAlarmStore((s) => s.reloadNext);

  useEffect(() => {
    void reloadNext();
  }, [reloadNext]);

  // 続けて押しても積み増さない（router.navigate は、すでにスタックにあればそこへ戻る）
  const openAlarm = () => router.navigate('/alarm');
  return { label: formatEntry(next, now()), openAlarm };
}
