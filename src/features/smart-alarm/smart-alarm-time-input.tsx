// 時と分を入れる部品（設計書 docs/features/03_smart-alarm.md の 3.3）。押すと OS の時刻ピッカーを出し、選んだ時と分を返すだけ。
// Android はピッカーを出すとダイアログになり、選ぶか閉じると `onChange` が呼ばれる。iOS もここで閉じる
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';

type Props = {
  /** ボタンの文字（例：「就寝予定 23:34」） */
  label: string;
  /** ピッカーに出す時刻（UNIX ミリ秒） */
  value: number;
  /** ピッカーの `testID` */
  testID: string;
  onPick: (hour: number, minute: number) => void;
};

export function SmartAlarmTimeInput({ label, value, testID, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const onChange = (event: DateTimePickerEvent, date?: Date) => {
    setOpen(false);
    if (event.type === 'set' && date !== undefined) onPick(date.getHours(), date.getMinutes());
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setOpen(true)}
      >
        <Text>{label}</Text>
      </Pressable>
      {open && (
        <DateTimePicker
          testID={testID}
          mode="time"
          is24Hour
          value={new Date(value)}
          onChange={onChange}
        />
      )}
    </>
  );
}
