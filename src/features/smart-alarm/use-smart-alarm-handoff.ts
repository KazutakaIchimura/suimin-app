// アプリを開いた理由（スヌーズ）を処理するフック（設計書 docs/features/03_smart-alarm.md の 3.1「スヌーズ」・3.3）。
// 起動時・前面復帰時（background → active）・ライブラリの操作のイベントが届いたときに store の処理を呼び、スヌーズを処理したらアラームの画面へ移る。
// 前面復帰時は設定中のアラームも読み直す（起動時は入口・アラームの画面が開いたときに読む）
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { subscribeAlarmActions } from '@/features/smart-alarm/smart-alarm-operation.service';
import { useSmartAlarmStore } from '@/features/smart-alarm/smart-alarm.store';

export function useSmartAlarmHandoff(): void {
  const handleHandoff = useSmartAlarmStore((s) => s.handleHandoff);
  const reloadNext = useSmartAlarmStore((s) => s.reloadNext);

  useEffect(() => {
    // router.navigate は、すでにスタックにあればそこへ戻り、積み増さない（expo-router のドキュメント）
    const run = async () => {
      if ((await handleHandoff()) === 'navigate') router.navigate('/alarm');
    };
    void run();
    let previous: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (state) => {
      if (previous === 'background' && state === 'active') {
        void run();
        void reloadNext();
      }
      previous = state;
    });
    // 前面のまま（前面復帰が起きないとき）に届く操作のイベントでも、同じく理由を読んで処理する
    const unsubscribe = subscribeAlarmActions(() => void run());
    return () => {
      sub.remove();
      unsubscribe();
    };
  }, [handleHandoff, reloadNext]);
}
