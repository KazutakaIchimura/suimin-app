// `ready` 以外の連携状態を、ネイティブのモックの戻り値で作る（設計書 3.1「連携状態と案内」の判定）
import type * as HealthKit from '@kingstinct/react-native-healthkit';
import type * as HealthConnect from 'react-native-health-connect';

import type { AccessStatus, HealthOs } from '@/features/sleep-record/sleep-record.types';

/** テストが読み込み直したネイティブのモック */
export type HealthMocks = {
  hk: jest.MockedObject<typeof HealthKit>;
  hc: jest.MockedObject<typeof HealthConnect>;
};

/** [OS, 作る連携状態, モックの戻り値を変える関数]。iOS・Android で起きる組み合わせだけ */
export const NOT_READY_STATES: [HealthOs, AccessStatus, (mocks: HealthMocks) => void][] = [
  [
    'ios',
    'notRequested',
    ({ hk }) =>
      hk.getRequestStatusForAuthorization.mockResolvedValue(
        1 as never, // shouldRequest
      ),
  ],
  ['ios', 'unavailable', ({ hk }) => hk.isHealthDataAvailable.mockReturnValue(false)],
  [
    'ios',
    'checkFailed',
    ({ hk }) => hk.getRequestStatusForAuthorization.mockRejectedValue(new Error('status failed')),
  ],
  ['android', 'notGranted', ({ hc }) => hc.getGrantedPermissions.mockResolvedValue([])],
  [
    'android',
    'unavailable',
    ({ hc }) => hc.getSdkStatus.mockResolvedValue(1), // SDK_UNAVAILABLE
  ],
  [
    'android',
    'updateRequired',
    ({ hc }) => hc.getSdkStatus.mockResolvedValue(2), // SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED
  ],
  [
    'android',
    'checkFailed',
    ({ hc }) => hc.getSdkStatus.mockRejectedValue(new Error('sdk status failed')),
  ],
];
