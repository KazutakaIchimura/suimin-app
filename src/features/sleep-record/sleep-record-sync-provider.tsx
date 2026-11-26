// 起動時・前面復帰時の睡眠の同期を、アプリ全体で1回だけ動かす（設計書 3.1・3.3）。`src/app/_layout.tsx` が子要素を包んで描画する
import type { ReactNode } from 'react';

import { useSleepRecordSync } from '@/features/sleep-record/use-sleep-record-sync';

export function SleepRecordSyncProvider({ children }: { children: ReactNode }) {
  useSleepRecordSync();
  return <>{children}</>;
}
