// E2E 用のシードアプリ（設計書 3.3「E2E」）。ヘルスコネクトへシードの睡眠を入れる。テストの道具で、配布しない。
// 画面・ログに睡眠の時刻は出さない
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  deleteRecordsByTimeRange,
  getGrantedPermissions,
  initialize,
  insertRecords,
  requestPermission,
  SleepStageType,
} from 'react-native-health-connect';

// シードの定義は本体の E2E と共通（素の JavaScript）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const seed = require('../sleep-seed.js') as {
  SEED_NAMES: string[];
  buildSeed: (name: string, now: number) => SeedSession[];
};

type SeedStage = 'deep' | 'light' | 'rem' | 'awake';
type SeedSession = {
  id: string;
  startAt: number;
  endAt: number;
  stages: { stage: SeedStage; startAt: number; endAt: number }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** 消す範囲（このアプリが書いた SleepSession を直近60日ぶん。シードは14日前まで） */
const CLEAR_DAYS = 60;

const STAGE_TYPE: Record<SeedStage, number> = {
  awake: SleepStageType.AWAKE,
  light: SleepStageType.LIGHT,
  deep: SleepStageType.DEEP,
  rem: SleepStageType.REM,
};

const iso = (ms: number) => new Date(ms).toISOString();

/** 睡眠の書き込みが許可されているか。なければ要求する */
async function ensureWritePermission(): Promise<boolean> {
  const canWrite = (granted: { accessType: string; recordType: string }[]) =>
    granted.some((p) => p.accessType === 'write' && p.recordType === 'SleepSession');
  if (canWrite(await getGrantedPermissions())) return true;
  return canWrite(await requestPermission([{ accessType: 'write', recordType: 'SleepSession' }]));
}

/** このアプリが書いた睡眠を消し、シード `name` を入れる */
async function applySeed(name: string): Promise<void> {
  if (!(await initialize())) throw new Error('Health Connect initialize returned false');
  if (!(await ensureWritePermission())) throw new Error('Write permission was not granted');
  const now = Date.now();
  // ヘルスコネクトは、書いたアプリのデータしか消せない
  await deleteRecordsByTimeRange('SleepSession', {
    operator: 'between',
    startTime: iso(now - CLEAR_DAYS * DAY_MS),
    endTime: iso(now + DAY_MS),
  });
  const sessions = seed.buildSeed(name, now);
  if (sessions.length === 0) return;
  await insertRecords(
    sessions.map((s) => ({
      recordType: 'SleepSession' as const,
      startTime: iso(s.startAt),
      endTime: iso(s.endAt),
      stages: s.stages.map((st) => ({
        stage: STAGE_TYPE[st.stage],
        startTime: iso(st.startAt),
        endTime: iso(st.endAt),
      })),
    })),
  );
}

export function App() {
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);

  const onPress = async (name: string) => {
    setRunning(true);
    setStatus('');
    try {
      await applySeed(name);
      setStatus(`投入完了：${name}`);
    } catch (err) {
      // 時刻などの睡眠データは含めず、失敗の種類だけを出す
      console.error('seed failed', err instanceof Error ? err.message : String(err));
      setStatus('投入失敗');
    } finally {
      setRunning(false);
    }
  };

  return (
    <View style={styles.container}>
      {seed.SEED_NAMES.map((name) => (
        <Pressable
          key={name}
          accessibilityRole="button"
          disabled={running}
          onPress={() => void onPress(name)}
          style={styles.button}
        >
          <Text>{name}</Text>
        </Pressable>
      ))}
      <Text testID="seed-status">{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  button: { padding: 16 },
});
