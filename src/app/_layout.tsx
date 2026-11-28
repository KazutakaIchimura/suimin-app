import { Stack } from 'expo-router';

import { SleepRecordSyncProvider } from '@/features/sleep-record/sleep-record-sync-provider';
import { SmartAlarmHandoffProvider } from '@/features/smart-alarm/smart-alarm-handoff-provider';
import { MigrationGate } from '@/lib/migration-gate';

export default function RootLayout() {
  return (
    <MigrationGate>
      <SleepRecordSyncProvider>
        <SmartAlarmHandoffProvider>
          <Stack />
        </SmartAlarmHandoffProvider>
      </SleepRecordSyncProvider>
    </MigrationGate>
  );
}
