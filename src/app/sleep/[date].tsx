import { useLocalSearchParams } from 'expo-router';

import { SleepRecordDetailScreen } from '@/features/sleep-record/sleep-record-detail-screen';

export default function SleepDetailRoute() {
  const { date } = useLocalSearchParams<{ date: string }>();
  return <SleepRecordDetailScreen date={date} />;
}
