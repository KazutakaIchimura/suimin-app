// グラフを描くだけの部品（設計書 docs/features/02_sleep-chart.md の 3.3）。
// 整形済みの値（日ごとの棒の高さ・帯の上端と下端）を受け取り、計算しない。Jest では何も描かない部品に差し替える
import { Rect } from '@shopify/react-native-skia';
import { StyleSheet, View } from 'react-native';
import { Bar, CartesianChart } from 'victory-native';

import {
  CHART_AXIS_MINUTES,
  CHART_BAR_MAX_MINUTES,
  type ChartBand,
} from '@/features/sleep-record/sleep-record.types';

type Props = {
  /** 日ごとの棒の高さ（分。0〜`CHART_BAR_MAX_MINUTES`）。値なしは `null` */
  bars: (number | null)[];
  /** 日ごとの帯（軸の分。0〜`CHART_AXIS_MINUTES`）。描かない日は `null` */
  bands: (ChartBand | null)[];
};

const BAR_COLOR = '#5B8DEF';
const BAND_COLOR = '#8E7CC3';

export function SleepRecordChartCanvas({ bars, bands }: Props) {
  const count = Math.max(bars.length, 1);
  // 横軸の範囲を -0.5〜日数-0.5 にして、i 日目を、日ごとに等分した重ねたボタンの i 番目の列の中央に描く
  const xDomain: [number, number] = [-0.5, count - 0.5];
  const columnWidth = (bounds: { left: number; right: number }) =>
    (bounds.right - bounds.left) / count;
  const barData = bars.map((minutes, index) => ({ index, minutes: minutes ?? 0 }));
  const bandData = bands.map((band, index) => ({
    index,
    from: band?.from ?? 0,
    to: band?.to ?? 0,
  }));

  return (
    <View>
      <View style={styles.chart}>
        <CartesianChart
          data={barData}
          xKey="index"
          yKeys={['minutes']}
          domain={{ x: xDomain, y: [0, CHART_BAR_MAX_MINUTES] }}
        >
          {({ points, chartBounds }) => (
            <Bar
              points={points.minutes}
              chartBounds={chartBounds}
              color={BAR_COLOR}
              barWidth={Math.max(4, columnWidth(chartBounds) * 0.6)}
            />
          )}
        </CartesianChart>
      </View>
      <View style={styles.chart}>
        <CartesianChart
          data={bandData}
          xKey="index"
          yKeys={['from', 'to']}
          domain={{ x: xDomain, y: [0, CHART_AXIS_MINUTES] }}
        >
          {({ points, yScale, chartBounds }) => {
            const width = Math.max(4, columnWidth(chartBounds) * 0.6);
            return points.from.map((point, i) =>
              bands[i] === null ? null : (
                <Rect
                  key={i}
                  x={point.x - width / 2}
                  // 上下を反転：軸の分 0（前日 18:00）がグラフの上端、1440（当日 18:00）が下端
                  y={yScale(CHART_AXIS_MINUTES - bandData[i].from)}
                  width={width}
                  height={
                    yScale(CHART_AXIS_MINUTES - bandData[i].to) -
                    yScale(CHART_AXIS_MINUTES - bandData[i].from)
                  }
                  color={BAND_COLOR}
                />
              ),
            );
          }}
        </CartesianChart>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { height: 180 },
});
