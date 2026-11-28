// 一覧の上に置くアラームの入口（設計書 docs/features/03_smart-alarm.md の 3.3・3.4）。表示と操作の受け付けだけ
import { Pressable, StyleSheet, Text } from 'react-native';

import { useSmartAlarmEntry } from '@/features/smart-alarm/use-smart-alarm-entry';

export function SmartAlarmEntry() {
  const { label, openAlarm } = useSmartAlarmEntry();
  return (
    <Pressable accessibilityRole="button" onPress={openAlarm} style={styles.entry}>
      <Text>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  entry: { padding: 16 },
});
