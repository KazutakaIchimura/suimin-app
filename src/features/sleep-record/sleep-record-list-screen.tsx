// 一覧画面（設計書 3.1・3.4）。案内・同期エラー・読み取りエラー・日ごとの行（タップで詳細へ）・下に引いて更新
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { SleepRecordAccessGuide } from '@/features/sleep-record/sleep-record-access-guide';
import { useSleepRecordList } from '@/features/sleep-record/use-sleep-record-list';

export function SleepRecordListScreen() {
  const { state, refreshing, onRefresh, onAction, retryRead, openChart } = useSleepRecordList();

  if (state.kind === 'loading') {
    return (
      <View style={styles.center}>
        <Text>読み込み中</Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="sleep-record-list"
      data={state.rows ?? []}
      keyExtractor={(row) => row.wakeDate}
      refreshControl={
        <RefreshControl
          testID="sleep-record-refresh"
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      }
      ListHeaderComponent={
        <View>
          {/* 週・月の推移（02）。一覧を表示しているときだけ出す（読み取りに失敗したときは出さない） */}
          {state.rows !== null && (
            <Pressable accessibilityRole="button" onPress={openChart} style={styles.message}>
              <Text>週・月の推移</Text>
            </Pressable>
          )}
          <SleepRecordAccessGuide
            guides={state.guides}
            requesting={state.requesting}
            onAction={onAction}
          />
          {state.errors.map((message) => (
            <Text key={message} style={styles.message}>
              {message}
            </Text>
          ))}
          {state.rows === null && (
            <View style={styles.message}>
              <Text>睡眠データを読み込めませんでした</Text>
              <Pressable accessibilityRole="button" onPress={retryRead}>
                <Text>再試行</Text>
              </Pressable>
            </View>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          testID="sleep-record-row"
          accessibilityRole="button"
          onPress={() => router.push(`/sleep/${item.wakeDate}`)}
          style={styles.row}
        >
          <Text>{item.dateLabel}</Text>
          <Text>{item.totalLabel}</Text>
          <Text>{item.timeLabel}</Text>
          {item.napLabel !== null && <Text>{item.napLabel}</Text>}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  message: { padding: 16, gap: 8 },
  row: { padding: 16, gap: 4 },
});
