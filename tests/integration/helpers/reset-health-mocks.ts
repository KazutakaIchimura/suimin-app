// 差し替えたヘルスケアのライブラリ（health-mocks.ts）を、各テストの前に既定の状態へ戻す
import * as healthKit from '@kingstinct/react-native-healthkit';
import * as healthConnect from 'react-native-health-connect';

/**
 * 差し替えた関数の呼び出し記録と戻り値を消し、既定（連携済みで睡眠0件）に戻す。各テストの前に呼ぶ
 * （`jest.clearAllMocks` は `mockReturnValue` で変えた戻り値を消さないため）
 */
export function resetHealthMocks() {
  const hk = jest.mocked(healthKit);
  hk.isHealthDataAvailable.mockReset().mockReturnValue(true);
  hk.getRequestStatusForAuthorization
    .mockReset()
    .mockResolvedValue(healthKit.AuthorizationRequestStatus.unnecessary);
  hk.requestAuthorization.mockReset().mockResolvedValue(true);
  hk.queryCategorySamples.mockReset().mockResolvedValue([]);

  const hc = jest.mocked(healthConnect);
  hc.getSdkStatus.mockReset().mockResolvedValue(healthConnect.SdkAvailabilityStatus.SDK_AVAILABLE);
  hc.initialize.mockReset().mockResolvedValue(true);
  hc.getGrantedPermissions
    .mockReset()
    .mockResolvedValue([{ accessType: 'read', recordType: 'SleepSession' }]);
  hc.requestPermission.mockReset().mockResolvedValue([]);
  hc.openHealthConnectSettings.mockReset();
  hc.readRecords.mockReset().mockResolvedValue({ records: [], pageToken: undefined } as never);
}
