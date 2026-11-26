// 詳細画面（設計書 3.4「詳細」）。主睡眠・ステージ内訳・昼寝の一覧・日付不正／データなし／読み取りエラーの表示
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSleepRecordDetail } from '@/features/sleep-record/use-sleep-record-detail';

type Props = {
  /** expo-router の日付パラメータ（`string | string[] | undefined` になりうる） */
  date: string | string[] | undefined;
};

export function SleepRecordDetailScreen({ date }: Props) {
  const { state, retryRead } = useSleepRecordDetail(date);

  switch (state.kind) {
    case 'loading':
      return <Message text="読み込み中" />;
    case 'invalidDate':
      return <Message text="日付が正しくありません" />;
    case 'none':
      return <Message text="この日の睡眠データはありません" />;
    case 'failed':
      return (
        <View style={styles.center}>
          <Text>睡眠データを読み込めませんでした</Text>
          <Pressable accessibilityRole="button" onPress={retryRead}>
            <Text>再試行</Text>
          </Pressable>
        </View>
      );
    case 'found':
      return (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text>{state.main.timeLabel}</Text>
            <Text>{state.main.totalLabel}</Text>
          </View>
          <View style={styles.section}>
            {state.breakdown === null ? (
              <Text>ステージ情報なし</Text>
            ) : (
              state.breakdown.map((row) => (
                <View key={row} testID="sleep-record-breakdown-row">
                  <Text>{row}</Text>
                </View>
              ))
            )}
          </View>
          {state.naps.map((nap) => (
            <View key={nap.id} style={styles.section}>
              <Text>{nap.timeLabel}</Text>
              <Text>{nap.totalLabel}</Text>
            </View>
          ))}
        </ScrollView>
      );
  }
}

function Message({ text }: { text: string }) {
  return (
    <View style={styles.center}>
      <Text>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  content: { padding: 16, gap: 16 },
  section: { gap: 4 },
});
