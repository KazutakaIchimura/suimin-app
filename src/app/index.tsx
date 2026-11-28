import { SleepRecordListScreen } from '@/features/sleep-record/sleep-record-list-screen';
import { SmartAlarmEntry } from '@/features/smart-alarm/smart-alarm-entry';

// 一覧の上にスマートアラームの入口を置く（一覧の部品が他機能の受け口を import しないよう、ここで組み合わせる）
export default function HomeRoute() {
  return <SleepRecordListScreen header={<SmartAlarmEntry />} />;
}
