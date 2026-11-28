// 一覧画面（設計書 3.1・3.4）。案内・同期エラー・読み取りエラー・日ごとの行（タップで詳細へ）・下に引いて更新。
// 一覧の上に、外から渡す部品（`header`。03 のスマートアラームの入口）を置く。中身は知らない（他機能の部品を import しない）
import type { ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { SleepRecordAccessGuide } from '@/features/sleep-record/sleep-record-access-guide';
import { useSleepRecordList } from '@/features/sleep-record/use-sleep-record-list';

export function SleepRecordListScreen({ header }: { header?: ReactNode }) {
  const { state, refreshing, onRefresh, onAction, retryRead, openChart, openDay } =
    useSleepRecordList();

  // 外から渡す部品は一覧の外の上に置き、「読み込み中」の間も出す（03 の 3.3）。
  // 一覧の中に置くと、「読み込み中」から一覧に切り替わるときに作り直されるため
  return (
    <View style={styles.fill}>
      {header}
      {state.kind === 'loading' ? (
        <View style={styles.center}>
          <Text>読み込み中</Text>
        </View>
      ) : (
        <SleepRecordList
          state={state}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onAction={onAction}
          retryRead={retryRead}
          openChart={openChart}
          openDay={openDay}
        />
      )}
    </View>
  );
}

type ListProps = Omit<ReturnType<typeof useSleepRecordList>, 'state'> & {
  state: Exclude<ReturnType<typeof useSleepRecordList>['state'], { kind: 'loading' }>;
};

/** 一覧の本体（「読み込み中」以外） */
function SleepRecordList({
  state,
  refreshing,
  onRefresh,
  onAction,
  retryRead,
  openChart,
  openDay,
}: ListProps) {
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
          onPress={() => openDay(item.wakeDate)}
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
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  message: { padding: 16, gap: 8 },
  row: { padding: 16, gap: 4 },
});
