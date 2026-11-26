// ヘルスケアのネイティブライブラリの差し替え（設計書 3.3「テストでは次の外部I/Oの境界だけを jest.mock で差し替える」）。
// 列挙値・定数はライブラリ本物の値を使い、ネイティブを呼ぶ関数だけを jest.fn にする。
// 使い方：
//   jest.mock('@kingstinct/react-native-healthkit', () => jest.requireActual('<このファイル>').createHealthKitMock());
//   jest.mock('react-native-health-connect', () => jest.requireActual('<このファイル>').createHealthConnectMock());
//   beforeEach(() => resetHealthMocks());  // reset-health-mocks.ts
// このファイルはライブラリを import しない（差し替えの作成中に読まれるため、import すると循環する）
import path from 'node:path';

const HEALTHKIT_LIB = path.resolve(
  __dirname,
  '../../../node_modules/@kingstinct/react-native-healthkit/lib/commonjs',
);

/**
 * `@kingstinct/react-native-healthkit` の差し替え。
 * 本体はネイティブ（nitro）を読み込むため Jest では読めないので、列挙値のファイルだけを実際のパスから読む
 */
export function createHealthKitMock() {
  const generated = jest.requireActual(
    path.join(HEALTHKIT_LIB, 'generated/healthkit.generated.js'),
  );
  const auth = jest.requireActual(path.join(HEALTHKIT_LIB, 'types/Auth.js'));
  return {
    __esModule: true,
    CategoryValueSleepAnalysis: generated.CategoryValueSleepAnalysis,
    AuthorizationRequestStatus: auth.AuthorizationRequestStatus,
    isHealthDataAvailable: jest.fn(),
    getRequestStatusForAuthorization: jest.fn(),
    requestAuthorization: jest.fn(),
    queryCategorySamples: jest.fn(),
  };
}

/** `react-native-health-connect` の差し替え。定数は本物のまま、ネイティブを呼ぶ関数だけを差し替える */
export function createHealthConnectMock() {
  const actual = jest.requireActual('react-native-health-connect');
  return {
    ...actual,
    getSdkStatus: jest.fn(),
    initialize: jest.fn(),
    getGrantedPermissions: jest.fn(),
    requestPermission: jest.fn(),
    openHealthConnectSettings: jest.fn(),
    readRecords: jest.fn(),
  };
}
