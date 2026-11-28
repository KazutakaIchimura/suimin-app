// アラームの画面（設計書 docs/features/03_smart-alarm.md の 3.4）。表示と操作の受け付けだけ
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SmartAlarmTimeInput } from '@/features/smart-alarm/smart-alarm-time-input';
import { useSmartAlarm, type CandidateButton } from '@/features/smart-alarm/use-smart-alarm';

export function SmartAlarmScreen() {
  const s = useSmartAlarm();

  const candidate = (b: CandidateButton) => (
    <Pressable
      key={b.key}
      accessibilityRole="button"
      accessibilityLabel={b.label}
      disabled={s.busy}
      onPress={() => s.choose(b.at)}
      style={styles.candidate}
    >
      <Text>{b.label}</Text>
    </Pressable>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* 設定中のアラーム（読み込み中は何も出さない） */}
      <View style={styles.section}>
        {s.nextLabel !== null && <Text>{s.nextLabel}</Text>}
        {s.canCancel && (
          <Pressable accessibilityRole="button" disabled={s.busy} onPress={s.cancel}>
            <Text>解除</Text>
          </Pressable>
        )}
        {s.nextFailed && (
          <>
            <Text>{s.nextFailedMessage}</Text>
            <Pressable accessibilityRole="button" onPress={s.retryNext}>
              <Text>再試行</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* 操作の結果と案内 */}
      {(s.messages.length > 0 || s.settings !== null || s.snoozeRetry) && (
        <View style={styles.section}>
          {s.messages.map((m, i) => (
            <Text key={`${i}-${m}`}>{m}</Text>
          ))}
          {s.settings !== null && (
            <Pressable accessibilityRole="button" onPress={s.openSettings}>
              <Text>設定を開く</Text>
            </Pressable>
          )}
          {s.snoozeRetry && (
            <Pressable accessibilityRole="button" onPress={s.retrySnooze}>
              <Text>再試行</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* 使う値の説明 */}
      <View style={styles.section}>
        <Text>{s.paramsLabel}</Text>
        {s.paramsFailedMessage !== null && <Text>{s.paramsFailedMessage}</Text>}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>今から寝る</Text>
        {s.nowButtons.map(candidate)}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>起床時刻を指定</Text>
        <SmartAlarmTimeInput
          label={s.bedtime.label}
          value={s.bedtime.value}
          testID="smart-alarm-bedtime-input"
          onPick={s.pickBedtime}
        />
        <SmartAlarmTimeInput
          label={s.wake.label}
          value={s.wake.value}
          testID="smart-alarm-wake-input"
          onPick={s.pickWake}
        />
        {s.wakeButtons.map(candidate)}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  section: { gap: 8 },
  heading: { fontWeight: 'bold' },
  candidate: { paddingVertical: 8 },
});
