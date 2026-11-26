// ヘルスケアのリポジトリの切り替え（設計書 3.3）。引数の os で iOS／Android の実装を選ぶ（react-native は import しない）
import * as android from '@/features/sleep-record/sleep-record-health-android.repository';
import * as ios from '@/features/sleep-record/sleep-record-health-ios.repository';
import type { HealthOs } from '@/features/sleep-record/sleep-record.types';

/** iOS／Android の実装が同じ形であることを型で確かめる */
type HealthRepository = typeof ios & typeof android;

/** os に合う実装を返す（どちらも同じ形の関数を持つ） */
export function getHealthRepository(os: HealthOs): HealthRepository {
  return os === 'ios' ? ios : android;
}
