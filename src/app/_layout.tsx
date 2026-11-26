import { Stack } from 'expo-router';

import { SleepRecordSyncProvider } from '@/features/sleep-record/sleep-record-sync-provider';
import { MigrationGate } from '@/lib/migration-gate';

export default function RootLayout() {
  return (
    <MigrationGate>
      <SleepRecordSyncProvider>
        <Stack />
      </SleepRecordSyncProvider>
    </MigrationGate>
  );
}
