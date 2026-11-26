// 起動時・前面復帰時に store の sync() を呼ぶ（設計書 3.1「同期（取り込み）のルール」）
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useSleepRecordStore } from '@/features/sleep-record/sleep-record.store';

/** 描画したとき（起動時）に1回、そのあとは前面に戻る（background → active）たびに sync() を呼ぶ */
export function useSleepRecordSync(): void {
  const sync = useSleepRecordStore((state) => state.sync);

  useEffect(() => {
    void sync();
    // 「前面に戻った」は background → active だけ（inactive → active は含めない。
    // iOS では許可のシートを閉じたときにも起き、許可の要求中に同期が割り込むため）
    // 起動直後の状態（取れないこともある）。background からの変化だけを前面復帰とみなす
    let previous: string | null | undefined = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous === 'background' && next === 'active') void sync();
      previous = next;
    });
    return () => subscription.remove();
  }, [sync]);
}
