// 起動時と前面復帰時に、アプリを開いた理由（スヌーズ）を処理する部品（設計書 docs/features/03_smart-alarm.md の 3.3）。
// 01 の SleepRecordSyncProvider と同じく、子を描画するだけ
import type { ReactNode } from 'react';

import { useSmartAlarmHandoff } from '@/features/smart-alarm/use-smart-alarm-handoff';

export function SmartAlarmHandoffProvider({ children }: { children: ReactNode }) {
  useSmartAlarmHandoff();
  return <>{children}</>;
}
