import {
  getRequestStatusForAuthorization,
  isHealthDataAvailable,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';
import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  openHealthConnectSettings,
  requestPermission,
} from 'react-native-health-connect';

import {
  checkAccess,
  openSettings,
  requestAccess,
} from '@/features/sleep-record/sleep-record-access.service';

import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';
import { resetHealthMocks } from '../../helpers/reset-health-mocks';

// 外部I/Oの境界（ヘルスケアのネイティブライブラリ）だけを差し替える
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);

let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  resetHealthMocks();
  ({ named: logsNamed } = captureLogs());
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** `name` の error ログが1行だけ出て、渡した requestId と届いたエラーのメッセージを持つ */
function expectErrorLog(name: string, message: string) {
  const lines = logsNamed(name);
  expect(lines.map((l) => l.level)).toEqual(['error']);
  expect(lines[0].entry).toEqual({
    name,
    requestId: 'req-1',
    err: expect.objectContaining({ message }),
  });
}

describe('checkAccess', () => {
  // T121
  it('iOS の isHealthDataAvailable が例外を投げたら、同じエラーが届き error ログが出る', async () => {
    const err = new Error('isHealthDataAvailable failed');
    jest.mocked(isHealthDataAvailable).mockImplementation(() => {
      throw err;
    });

    await expect(checkAccess({ os: 'ios', requestId: 'req-1' })).rejects.toBe(err);
    expectErrorLog('sleepRecord.checkAccess', 'isHealthDataAvailable failed');
  });

  // T121
  it('iOS の getRequestStatusForAuthorization が reject したら、同じエラーが届き error ログが出る', async () => {
    const err = new Error('getRequestStatusForAuthorization failed');
    jest.mocked(getRequestStatusForAuthorization).mockRejectedValue(err);

    await expect(checkAccess({ os: 'ios', requestId: 'req-1' })).rejects.toBe(err);
    expectErrorLog('sleepRecord.checkAccess', 'getRequestStatusForAuthorization failed');
  });

  // T122
  it.each([
    ['getSdkStatus', getSdkStatus],
    ['initialize', initialize],
    ['getGrantedPermissions', getGrantedPermissions],
  ] as const)(
    'Android の %s が reject したら、同じエラーが届き error ログが出る',
    async (fn, mock) => {
      const err = new Error(`${fn} failed`);
      jest.mocked(mock).mockRejectedValue(err);

      await expect(checkAccess({ os: 'android', requestId: 'req-1' })).rejects.toBe(err);
      expectErrorLog('sleepRecord.checkAccess', `${fn} failed`);
    },
  );

  // T122
  it('Android の initialize が false なら、エラーが届き error ログが出る', async () => {
    jest.mocked(initialize).mockResolvedValue(false);

    const result = checkAccess({ os: 'android', requestId: 'req-1' });

    await expect(result).rejects.toThrow('Health Connect initialize returned false');
    expectErrorLog('sleepRecord.checkAccess', 'Health Connect initialize returned false');
    expect(getGrantedPermissions).not.toHaveBeenCalled();
  });
});

describe('requestAccess', () => {
  // T123
  it.each([
    ['ios', 'requestAuthorization', requestAuthorization],
    ['android', 'requestPermission', requestPermission],
  ] as const)(
    '%s の %s が reject したら、同じエラーが届き error ログが出る',
    async (os, fn, mock) => {
      const err = new Error(`${fn} failed`);
      jest.mocked(mock).mockRejectedValue(err);

      await expect(requestAccess({ os, requestId: 'req-1' })).rejects.toBe(err);
      expectErrorLog('sleepRecord.requestAccess', `${fn} failed`);
    },
  );

  const successCases = [
    [
      'ios',
      'requestAuthorization が false',
      () => jest.mocked(requestAuthorization).mockResolvedValue(false),
    ],
    [
      'ios',
      'requestAuthorization が true',
      () => jest.mocked(requestAuthorization).mockResolvedValue(true),
    ],
    [
      'android',
      'requestPermission が空配列',
      () => jest.mocked(requestPermission).mockResolvedValue([]),
    ],
  ] as const;

  // T124
  it.each(successCases)(
    '%s で %s を返しても、例外なく終わり info ログが出る',
    async (os, _label, arrange) => {
      arrange();

      await expect(requestAccess({ os, requestId: 'req-1' })).resolves.toBeUndefined();
      expect(logsNamed('sleepRecord.requestAccess').map((l) => [l.level, l.entry])).toEqual([
        ['info', { name: 'sleepRecord.requestAccess', requestId: 'req-1' }],
      ]);
    },
  );

  // T125
  it.each([false, true])(
    'iOS で requestAuthorization が %s を返すとき、求めるのは睡眠の読み取りだけ（toShare なし）',
    async (granted) => {
      jest.mocked(requestAuthorization).mockResolvedValue(granted);

      await requestAccess({ os: 'ios', requestId: 'req-1' });

      expect(requestAuthorization).toHaveBeenCalledTimes(1);
      const [toRequest] = jest.mocked(requestAuthorization).mock.calls[0];
      expect(toRequest.toRead).toEqual(['HKCategoryTypeIdentifierSleepAnalysis']);
      expect(toRequest.toShare ?? []).toEqual([]);
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );

  // T125
  it('Android で requestPermission が空配列を返すとき、求めるのは睡眠の読み取り1件だけ', async () => {
    jest.mocked(requestPermission).mockResolvedValue([]);

    await requestAccess({ os: 'android', requestId: 'req-1' });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith([
      { accessType: 'read', recordType: 'SleepSession' },
    ]);
    expect(requestAuthorization).not.toHaveBeenCalled();
  });
});

describe('openSettings', () => {
  // T126
  it('Android ではヘルスコネクトの設定を1回開く', async () => {
    await openSettings({ os: 'android', requestId: 'req-1' });

    expect(openHealthConnectSettings).toHaveBeenCalledTimes(1);
    expect(logsNamed('sleepRecord.openSettings')).toEqual([]);
  });

  // T127
  it('Android で openHealthConnectSettings が例外を投げたら、同じエラーが届き error ログが出る', async () => {
    const err = new Error('openHealthConnectSettings failed');
    jest.mocked(openHealthConnectSettings).mockImplementation(() => {
      throw err;
    });

    await expect(openSettings({ os: 'android', requestId: 'req-1' })).rejects.toBe(err);
    expectErrorLog('sleepRecord.openSettings', 'openHealthConnectSettings failed');
  });

  // T127
  it('iOS で呼ぶとエラーが届き error ログが出る', async () => {
    await expect(openSettings({ os: 'ios', requestId: 'req-1' })).rejects.toThrow(
      'openSettings is not supported on iOS',
    );
    expectErrorLog('sleepRecord.openSettings', 'openSettings is not supported on iOS');
    expect(openHealthConnectSettings).not.toHaveBeenCalled();
  });
});
