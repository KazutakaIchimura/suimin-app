// グラフの画面（設計書 docs/features/02_sleep-chart.md の 3.1）。フックの状態を表示し、操作をフックに渡すだけ
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SleepRecordChartCanvas } from '@/features/sleep-record/sleep-record-chart-canvas';
import { useSleepRecordChart } from '@/features/sleep-record/use-sleep-record-chart';

/** 縦軸の目盛りの文字（グラフの外側に置く）。`sleep-record.types.ts` の `CHART_BAR_MAX_MINUTES`（12時間）・`CHART_AXIS_START_HOUR`（18時）に合わせる */
const BAR_TICKS = ['12時間', '8', '4', '0'];
const BAND_TICKS = ['18:00', '0:00', '6:00', '12:00', '18:00'];

export function SleepRecordChartScreen() {
  const { state, refreshing, onRefresh, retryRead, prev, next, selectKind, openDay } =
    useSleepRecordChart();

  if (state.kind === 'failed') {
    return (
      <View style={styles.center}>
        <Text>睡眠データを読み込めませんでした</Text>
        <Pressable accessibilityRole="button" onPress={retryRead}>
          <Text>再試行</Text>
        </Pressable>
      </View>
    );
  }

  const isWeek = state.periodKind === 'week';
  return (
    <ScrollView
      testID="sleep-record-chart-scroll"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.row}>
        {(['week', 'month'] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityState={{ selected: state.periodKind === kind }}
            onPress={() => selectKind(kind)}
            style={styles.button}
          >
            <Text>{kind === 'week' ? '週' : '月'}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !state.canPrev }}
          disabled={!state.canPrev}
          onPress={prev}
          style={styles.button}
        >
          <Text>{isWeek ? '前の週' : '前の月'}</Text>
        </Pressable>
        <Text style={styles.title}>{state.title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !state.canNext }}
          disabled={!state.canNext}
          onPress={next}
          style={styles.button}
        >
          <Text>{isWeek ? '次の週' : '次の月'}</Text>
        </Pressable>
      </View>

      {state.average === null ? (
        <Text style={styles.message}>この期間の睡眠データはありません</Text>
      ) : (
        <>
          <View style={styles.row}>
            <Text>平均 {state.average.total}</Text>
            <Text>就寝 {state.average.bed}</Text>
            <Text>起床 {state.average.wake}</Text>
          </View>
          <View style={styles.chartArea}>
            <View style={styles.ticks}>
              <View style={styles.tickColumn}>
                {BAR_TICKS.map((t) => (
                  <Text key={t} style={styles.tick}>
                    {t}
                  </Text>
                ))}
              </View>
              <View style={styles.tickColumn}>
                {BAND_TICKS.map((t, i) => (
                  <Text key={`${t}-${i}`} style={styles.tick}>
                    {t}
                  </Text>
                ))}
              </View>
            </View>
            <View style={styles.plot}>
              <SleepRecordChartCanvas
                bars={state.days.map((d) => d.bar)}
                bands={state.days.map((d) => d.band)}
              />
              {/* 日ごとの透明なボタン（タップで詳細へ。読み上げの説明もここに付ける） */}
              <View style={StyleSheet.absoluteFill}>
                <View style={styles.dayRow}>
                  {state.days.map((day) => (
                    <Pressable
                      key={day.wakeDate}
                      testID="sleep-record-chart-day"
                      accessibilityRole="button"
                      accessibilityLabel={day.accessibilityLabel}
                      accessibilityState={{ disabled: !day.pressable }}
                      disabled={!day.pressable}
                      onPress={() => openDay(day.wakeDate)}
                      style={styles.day}
                    >
                      <Text style={styles.dayLabel}>{day.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  content: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  button: { padding: 8 },
  title: { flex: 1, textAlign: 'center' },
  message: { paddingVertical: 24, textAlign: 'center' },
  chartArea: { flexDirection: 'row' },
  ticks: { width: 48, gap: 20 },
  tickColumn: { height: 180, justifyContent: 'space-between' },
  tick: { fontSize: 10 },
  plot: { flex: 1 },
  dayRow: { flex: 1, flexDirection: 'row' },
  day: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  dayLabel: { fontSize: 10 },
});
