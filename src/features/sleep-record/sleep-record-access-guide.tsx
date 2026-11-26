// 連携状態に応じた案内文とボタン（一覧画面の部品）。表示する案内と押したときの操作を props で受け取る
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Guide, GuideAction } from '@/features/sleep-record/sleep-record.types';

type Props = {
  guides: Guide[];
  /** 許可の要求中は「連携する」ボタンを押せなくする */
  requesting: boolean;
  onAction: (action: GuideAction) => void;
};

export function SleepRecordAccessGuide({ guides, requesting, onAction }: Props) {
  return (
    <View>
      {guides.map((guide) =>
        guide.kind === 'syncing' ? (
          <View key={guide.kind} testID="sleep-record-syncing" style={styles.guide}>
            <ActivityIndicator />
          </View>
        ) : (
          <View key={guide.kind} style={styles.guide}>
            {guide.message !== null && <Text>{guide.message}</Text>}
            {guide.buttons.map((button) => {
              const disabled = button.action === 'requestAccess' && requesting;
              return (
                <Pressable
                  key={button.action}
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => onAction(button.action)}
                  style={styles.button}
                >
                  <Text>{button.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  guide: { padding: 16, gap: 8 },
  button: { paddingVertical: 8 },
});
