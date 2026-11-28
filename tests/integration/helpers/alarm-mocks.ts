// アラームのライブラリ `react-native-alarm-scheduler` の偽物（設計書 docs/features/03_smart-alarm.md の 3.3「テスト」・テストリストの共通の前提）。
// ネイティブを呼ぶ関数だけを jest.fn にし、予約・予定・アプリを開いた理由をメモリで持つ。
//   - 予約すると予約の一覧と予定（phase: scheduled・relationship: primary・occurrenceId はアラームの ID）に入り、取り消すと両方から消える
//   - 延期で終わらせると、その鳴動を completed にし、Date.now()＋delaySeconds の予定（relationship: deferred）を足して返す。
//     同じ idempotencyKey の2回目は最初の結果を返し、予定を足さない
// 失敗・戻り値の差し替え・途中で止めるのは、テストから各 jest.fn の mockXxxOnce で行う。
// 使い方：tests/setup/native-alarm-mocks.js が全テストで jest.mock に渡す。各テストの前に resetAlarmMocks() で既定へ戻す
// このファイルはライブラリを import しない（差し替えの作成中に読まれるため、import すると循環する）

/** 偽物の関数の一覧（ライブラリの `AlarmScheduler` と同じ名前） */
export type AlarmSchedulerMock = Record<(typeof FUNCTION_NAMES)[number], jest.Mock>;

export type FakeOccurrence = {
  occurrenceId: string;
  alarmId: string;
  scheduledFor: number;
  relationship: 'primary' | 'deferred' | 'followUp';
  phase: 'scheduled' | 'ringing' | 'completed' | 'cancelled';
};

export type FakeHandoff = {
  id: string;
  alarmId: string;
  action: 'nativeStop' | 'secondaryOpen' | 'snooze' | 'dismiss';
  timestamp: number;
  trigger?: boolean;
};

/** 偽物が持つ状態。テストから直接読み書きしてよい */
export type FakeAlarmState = {
  permission: Record<string, unknown>;
  /** 予約の一覧（`getScheduledAlarmsAsync`）。ID と時刻 */
  scheduled: { id: string; timestamp: number }[];
  occurrences: FakeOccurrence[];
  handoff: FakeHandoff | null;
  context: { id: string; occurrenceId?: string; relationship?: string; state?: string } | null;
  /** idempotencyKey ごとの最初の結果 */
  resolved: Map<string, unknown>;
};

/** 既定の許可（iOS の形。`canUseFullScreenIntent`・`canPostNotifications` は省略） */
export const DEFAULT_PERMISSION = {
  platform: 'ios',
  status: 'authorized',
  canScheduleExactAlarms: true,
  canOpenSettings: true,
};

const FUNCTION_NAMES = [
  'getPermissionsAsync',
  'requestPermissionsAsync',
  'openAlarmSettingsAsync',
  'openFullScreenIntentSettingsAsync',
  'scheduleAlarmAsync',
  'cancelAlarmAsync',
  'getScheduledAlarmsAsync',
  'getAlarmOccurrencesAsync',
  'getCurrentAlarmContextAsync',
  'getPendingNativeAlarmHandoffAsync',
  'clearPendingNativeAlarmHandoffAsync',
  'resolveAlarmOccurrenceAsync',
  'addListener',
] as const;

const state: FakeAlarmState = {
  permission: { ...DEFAULT_PERMISSION },
  scheduled: [],
  occurrences: [],
  handoff: null,
  context: null,
  resolved: new Map(),
};
let deferredCount = 0;
/** `addListener` で登録された操作のイベント（`onAlarmAction`）の受け手 */
let actionListeners: ((action: unknown) => void)[] = [];

/** ライブラリの操作のイベント（`onAlarmAction`）を流す（アプリが動いているあいだに届くもの） */
export function emitAlarmAction(action: unknown): void {
  for (const listener of actionListeners) listener(action);
}

/** 偽物の状態（テストから前提を置く・結果を読む） */
export function fakeAlarmState(): FakeAlarmState {
  return state;
}

/** 予約を1件置く（予約の一覧と、scheduled・primary の予定の両方） */
export function seedAlarm(id: string, timestamp: number): void {
  state.scheduled.push({ id, timestamp });
  state.occurrences.push({
    occurrenceId: id,
    alarmId: id,
    scheduledFor: timestamp,
    relationship: 'primary',
    phase: 'scheduled',
  });
}

/** 偽物の関数に既定の振る舞いを入れる */
function applyDefaults(mock: AlarmSchedulerMock): void {
  mock.addListener.mockImplementation((event: string, listener: (action: unknown) => void) => {
    if (event === 'onAlarmAction') actionListeners.push(listener);
    return {
      remove: () => {
        actionListeners = actionListeners.filter((l) => l !== listener);
      },
    };
  });
  mock.getPermissionsAsync.mockImplementation(async () => ({ ...state.permission }));
  mock.requestPermissionsAsync.mockImplementation(async () => ({ ...state.permission }));
  mock.openAlarmSettingsAsync.mockResolvedValue(true);
  mock.openFullScreenIntentSettingsAsync.mockResolvedValue(true);
  mock.scheduleAlarmAsync.mockImplementation(
    async (input: { id: string; timestamp: number; hour: number; minute: number }) => {
      seedAlarm(input.id, input.timestamp);
      return {
        id: input.id,
        hour: input.hour,
        minute: input.minute,
        title: '',
        weekdays: [],
        timestamp: input.timestamp,
        platform: 'ios',
      };
    },
  );
  mock.cancelAlarmAsync.mockImplementation(async (id: string) => {
    const existed =
      state.scheduled.some((a) => a.id === id) || state.occurrences.some((o) => o.alarmId === id);
    state.scheduled = state.scheduled.filter((a) => a.id !== id);
    state.occurrences = state.occurrences.filter((o) => o.alarmId !== id);
    return existed;
  });
  mock.getScheduledAlarmsAsync.mockImplementation(async () =>
    state.scheduled.map((a) => ({ id: a.id, timestamp: a.timestamp })),
  );
  mock.getAlarmOccurrencesAsync.mockImplementation(async (alarmId?: string) =>
    state.occurrences
      .filter((o) => alarmId === undefined || o.alarmId === alarmId)
      .map((o) => ({ ...o })),
  );
  mock.getCurrentAlarmContextAsync.mockImplementation(async () =>
    state.context === null ? null : { ...state.context },
  );
  mock.getPendingNativeAlarmHandoffAsync.mockImplementation(async () =>
    state.handoff === null ? null : { ...state.handoff },
  );
  mock.clearPendingNativeAlarmHandoffAsync.mockImplementation(async () => {
    state.handoff = null;
  });
  mock.resolveAlarmOccurrenceAsync.mockImplementation(
    async (
      occurrenceId: string,
      resolution: { next?: { delaySeconds: number }; idempotencyKey?: string },
    ) => {
      const key = resolution.idempotencyKey;
      if (key !== undefined && state.resolved.has(key)) return state.resolved.get(key);
      const current = state.occurrences.find((o) => o.occurrenceId === occurrenceId);
      const alarmId = current?.alarmId ?? occurrenceId;
      if (current !== undefined) current.phase = 'completed';
      deferredCount += 1;
      const next: FakeOccurrence = {
        occurrenceId: `${alarmId}-def-${deferredCount}`,
        alarmId,
        scheduledFor: Date.now() + (resolution.next?.delaySeconds ?? 0) * 1000,
        relationship: 'deferred',
        phase: 'scheduled',
      };
      state.occurrences.push(next);
      const result = {
        alarmId,
        resolvedOccurrenceId: occurrenceId,
        outcome: 'deferred',
        status: 'resolved',
        nextOccurrence: { ...next },
      };
      if (key !== undefined) state.resolved.set(key, result);
      return result;
    },
  );
}

/** `jest.mock('react-native-alarm-scheduler', ...)` に渡すモジュール */
export function createAlarmSchedulerModuleMock() {
  const mock = Object.fromEntries(FUNCTION_NAMES.map((n) => [n, jest.fn()])) as AlarmSchedulerMock;
  applyDefaults(mock);
  return { __esModule: true, default: mock, AlarmScheduler: mock };
}

/** 差し替え済みのライブラリの偽物（呼び出しの記録・振る舞いの差し替えに使う） */
export function alarmMock(): AlarmSchedulerMock {
  return jest.requireMock('react-native-alarm-scheduler').default as AlarmSchedulerMock;
}

/** 偽物の状態と関数を既定に戻す */
export function resetAlarmMocks(): void {
  state.permission = { ...DEFAULT_PERMISSION };
  state.scheduled = [];
  state.occurrences = [];
  state.handoff = null;
  state.context = null;
  state.resolved = new Map();
  deferredCount = 0;
  actionListeners = [];
  const mock = alarmMock();
  for (const fn of Object.values(mock)) fn.mockReset();
  applyDefaults(mock);
  resetUuidMock();
}

let uuidCount = 0;

/** `expo-crypto` の `randomUUID` の偽物。呼ぶたびに `00000000-0000-4000-8000-00000000000n` を返す */
export function createCryptoModuleMock() {
  return {
    __esModule: true,
    randomUUID: jest.fn(() => {
      uuidCount += 1;
      return `00000000-0000-4000-8000-${String(uuidCount).padStart(12, '0')}`;
    }),
  };
}

/** UUID の通し番号を 1 からに戻す */
export function resetUuidMock(): void {
  uuidCount = 0;
}
