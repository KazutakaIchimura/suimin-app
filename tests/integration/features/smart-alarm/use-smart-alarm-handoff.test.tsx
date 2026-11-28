// RNTL の自動の後片付けを止める（各テストで読み込み直すため、afterEach で cleanup を呼ぶ）
process.env.RNTL_SKIP_AUTO_CLEANUP = 'true';

/* eslint-disable import/first */
import { deferred } from '../../helpers/deferred';
import { cleanupApp, loadApp, warmUpApp, type LoadedApp } from '../../helpers/load-app';
import { createTestDb, type TestDb } from '../../helpers/test-db';
/* eslint-enable import/first */

// 外部I/Oの境界だけを差し替える：ヘルスケアのネイティブライブラリ、`@/lib/db`（テスト用DB）、`AppState`。
// アラームのライブラリは tests/setup/native-alarm-mocks.js が差し替える
jest.mock('@kingstinct/react-native-healthkit', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthKitMock(),
);
jest.mock('react-native-health-connect', () =>
  jest.requireActual('../../helpers/health-mocks').createHealthConnectMock(),
);
let mockTestDb: TestDb;
jest.mock('@/lib/db', () => ({ getDb: () => mockTestDb.db }));

jest.setTimeout(15000);
beforeAll(() => warmUpApp(), 120000);

/** JST の日時（`2026-11-29T07:00` または `2026-11-29T07:00:30` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local}${local.length === 16 ? ':00' : ''}+09:00`).getTime();

const SNOOZED = '7:09 にもう一度鳴ります';
const SNOOZED_NEXT = '次のアラーム 7:09（スヌーズ）';
const FAILED = 'スヌーズを設定できませんでした';

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(jst('2026-11-29T07:00:30'));
  mockTestDb = createTestDb();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await cleanupApp();
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockTestDb.destroy();
});

/** A が鳴っていて、スヌーズのボタンで開いた（理由・今の鳴動・ringing の予定） */
function ringing(app: LoadedApp, handoff: Record<string, unknown> = {}) {
  const state = app.alarm.fakeAlarmState();
  state.occurrences.push({
    occurrenceId: 'A',
    alarmId: 'A',
    scheduledFor: jst('2026-11-29T07:00'),
    relationship: 'primary',
    phase: 'ringing',
  });
  state.context = { id: 'A', occurrenceId: 'A' };
  state.handoff = {
    id: 'h1',
    alarmId: 'A',
    action: 'secondaryOpen',
    timestamp: jst('2026-11-29T07:00:10'),
    ...handoff,
  };
}

const resolve = (app: LoadedApp) => app.alarm.alarmMock().resolveAlarmOccurrenceAsync;
/** smartAlarm.snooze の error ログが出たか */
const snoozeErrors = () =>
  error.mock.calls.filter((c) => String(c[0]).includes('"name":"smartAlarm.snooze"'));
const back = async (app: LoadedApp) =>
  app.rntl.act(async () => (require('expo-router') as typeof import('expo-router')).router.back());

// T130
it('起動時に理由がスヌーズなら、延期して理由を消し、アラームの画面にスヌーズの表示が出る', async () => {
  const app = loadApp();
  ringing(app);

  await app.open();

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(await app.screen.findByText(SNOOZED_NEXT)).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/alarm');
  expect(resolve(app)).toHaveBeenCalledTimes(1);
  expect(app.alarm.fakeAlarmState().handoff).toBeNull();
  // 準備前の移動についての警告・エラーが出ない
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

// T131
it('前面に戻ったとき（background → active）も同じ', async () => {
  const app = loadApp();
  await app.open();
  await app.screen.findByRole('button', { name: 'アラーム 未設定' });

  ringing(app);
  await app.emit('background');
  await app.emit('active');

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/alarm');
});

// T132
it('inactive → active では読まない', async () => {
  const app = loadApp();
  await app.open();
  await app.screen.findByRole('button', { name: 'アラーム 未設定' });

  ringing(app);
  await app.emit('inactive');
  await app.emit('active');

  expect(resolve(app)).not.toHaveBeenCalled();
  expect(app.screen).toHavePathname('/');
});

// T133
it('前面に戻ると、設定中のアラームを読み直す', async () => {
  const app = loadApp();
  await app.open();
  await app.screen.findByRole('button', { name: 'アラーム 未設定' });

  app.alarm.seedAlarm('B', jst('2026-11-29T21:00'));
  await app.emit('background');
  await app.emit('active');

  expect(await app.screen.findByRole('button', { name: 'アラーム 21:00' })).toBeOnTheScreen();
});

// T134
it('延期が失敗すると失敗の表示と「再試行」が出て、再試行で成功すると表示が入れ替わる', async () => {
  const app = loadApp();
  ringing(app);
  resolve(app).mockRejectedValueOnce(new Error('native failure'));
  app.alarm.fakeAlarmState().occurrences.push({
    occurrenceId: 'B',
    alarmId: 'B',
    scheduledFor: jst('2026-11-29T07:30'),
    relationship: 'primary',
    phase: 'scheduled',
  });

  await app.open();

  expect(await app.screen.findByText(FAILED)).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/alarm');
  // 失敗のあとも設定中のアラームを読み直す
  expect(await app.screen.findByText('次のアラーム 7:30')).toBeOnTheScreen();
  expect(app.alarm.fakeAlarmState().handoff).toEqual({
    id: 'h1',
    alarmId: 'A',
    action: 'secondaryOpen',
    timestamp: jst('2026-11-29T07:00:10'),
  });
  expect(app.alarm.alarmMock().clearPendingNativeAlarmHandoffAsync).not.toHaveBeenCalled();
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(app.screen.queryByText(FAILED)).toBeNull();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
});

// T135
it.each([
  ['停止', { action: 'nativeStop' }],
  ['理由なし', null],
  ['10分以上前', { timestamp: jst('2026-11-29T06:50') }],
] as const)('理由が%sなら画面は一覧のままで、延期されない', async (_label, handoff) => {
  const app = loadApp();
  if (handoff === null) app.alarm.fakeAlarmState().handoff = null;
  else ringing(app, handoff);

  await app.open();
  await app.screen.findByRole('button', { name: /^アラーム/ });
  await app.rntl.waitFor(() =>
    expect(app.alarm.alarmMock().getPendingNativeAlarmHandoffAsync).toHaveBeenCalled(),
  );

  expect(app.screen).toHavePathname('/');
  expect(app.screen.queryByText(FAILED)).toBeNull();
  expect(resolve(app)).not.toHaveBeenCalled();
  if (handoff !== null) {
    await app.rntl.waitFor(() => expect(app.alarm.fakeAlarmState().handoff).toBeNull());
  }
});

// T136
it('理由の読み取りが失敗しても、画面は一覧のままで何も表示しない', async () => {
  const app = loadApp();
  ringing(app);
  app.alarm
    .alarmMock()
    .getPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(new Error('native failure'));

  await app.open();
  await app.rntl.waitFor(() => expect(snoozeErrors()).toHaveLength(1));

  expect(app.screen).toHavePathname('/');
  for (const text of [FAILED, /にもう一度鳴ります/])
    expect(app.screen.queryByText(text)).toBeNull();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
});

// T137
it('アラームの画面を出しているときにスヌーズを処理しても、画面は積み増されない', async () => {
  const app = loadApp();
  await app.open();
  await app.rntl.fireEvent.press(
    await app.screen.findByRole('button', { name: 'アラーム 未設定' }),
  );
  expect(app.screen).toHavePathname('/alarm');

  ringing(app);
  await app.emit('background');
  await app.emit('active');
  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();

  await back(app);
  expect(app.screen).toHavePathname('/');
});

// T138
it('冷えた起動でスヌーズを処理したあと戻ると、一覧になる', async () => {
  const app = loadApp();
  ringing(app);
  await app.open();
  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();

  await back(app);

  expect(app.screen).toHavePathname('/');
  expect(await app.screen.findByRole('button', { name: /^アラーム/ })).toBeOnTheScreen();
});

// T139
it('次の鳴動がない結果なら、失敗の表示だけで「再試行」は出ず、理由は消える', async () => {
  const app = loadApp();
  ringing(app);
  resolve(app).mockResolvedValueOnce({
    alarmId: 'A',
    resolvedOccurrenceId: 'A',
    outcome: 'deferred',
    status: 'resolvedWithoutNext',
  });

  await app.open();

  expect(await app.screen.findByText(FAILED)).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
  await app.rntl.waitFor(() => expect(app.alarm.fakeAlarmState().handoff).toBeNull());
});

// T140
it('失敗のあと10分たってから再試行すると、延期せず、理由と失敗の表示が消える', async () => {
  const app = loadApp();
  ringing(app);
  resolve(app).mockRejectedValueOnce(new Error('native failure'));
  await app.open();
  expect(await app.screen.findByText(FAILED)).toBeOnTheScreen();

  jest.setSystemTime(jst('2026-11-29T07:10:10'));
  await app.rntl.fireEvent.press(app.screen.getByRole('button', { name: '再試行' }));

  await app.rntl.waitFor(() => expect(app.screen.queryByText(FAILED)).toBeNull());
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
  expect(resolve(app)).toHaveBeenCalledTimes(1);
  expect(app.alarm.fakeAlarmState().handoff).toBeNull();
});

// T141
it('スヌーズのあとの理由の消去が失敗しても、スヌーズの表示が出る', async () => {
  const app = loadApp();
  ringing(app);
  app.alarm
    .alarmMock()
    .clearPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(new Error('native failure'));

  await app.open();

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(snoozeErrors()).toHaveLength(1);
});

// T142
it('停止の理由の消去が失敗しても、画面は一覧のままで何も表示しない', async () => {
  const app = loadApp();
  ringing(app, { action: 'nativeStop' });
  app.alarm
    .alarmMock()
    .clearPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(new Error('native failure'));

  await app.open();
  await app.rntl.waitFor(() => expect(snoozeErrors()).toHaveLength(1));

  expect(app.screen).toHavePathname('/');
  for (const text of [FAILED, /にもう一度鳴ります/])
    expect(app.screen.queryByText(text)).toBeNull();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
});

// T143
it.each([
  ['理由の読み取り', 'getPendingNativeAlarmHandoffAsync'],
  ['延期', 'resolveAlarmOccurrenceAsync'],
] as const)('起動時に%sが1回失敗しても、前面復帰でやり直して成功する', async (_label, fn) => {
  const app = loadApp();
  ringing(app);
  app.alarm.alarmMock()[fn].mockRejectedValueOnce(new Error('native failure'));
  await app.open();
  await app.rntl.waitFor(() => expect(snoozeErrors()).toHaveLength(1));

  jest.setSystemTime(jst('2026-11-29T07:00:40'));
  await app.emit('background');
  await app.emit('active');

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(app.screen).toHavePathname('/alarm');
  expect(app.screen.queryByText(FAILED)).toBeNull();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
});

// T144
it('次の鳴動がなく、理由の消去も失敗したら、失敗の表示だけで「再試行」は出ない', async () => {
  const app = loadApp();
  ringing(app);
  resolve(app).mockResolvedValueOnce({
    alarmId: 'A',
    resolvedOccurrenceId: 'A',
    outcome: 'deferred',
    status: 'resolvedWithoutNext',
  });
  app.alarm
    .alarmMock()
    .clearPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(new Error('native failure'));

  await app.open();

  expect(await app.screen.findByText(FAILED)).toBeOnTheScreen();
  expect(app.screen.queryByRole('button', { name: '再試行' })).toBeNull();
  await app.rntl.waitFor(() => expect(snoozeErrors()).toHaveLength(1));
});

// T145
it('前面のまま操作のイベントが届いたら、理由を読んでスヌーズする', async () => {
  const app = loadApp();
  await app.open();
  await app.screen.findByRole('button', { name: 'アラーム 未設定' });

  ringing(app);
  await app.rntl.act(async () => {
    // 中身は使わず、保存された理由（secondaryOpen）を読む
    app.alarm.emitAlarmAction({ alarmId: 'A', action: 'nativeStop' });
  });

  expect(await app.screen.findByText(SNOOZED)).toBeOnTheScreen();
  expect(resolve(app)).toHaveBeenCalledTimes(1);
  expect(app.screen).toHavePathname('/alarm');
});

// T121（手順8の項目。前面復帰で読み直す部品がこの手順でできるため、ここで確かめる）
it('前面復帰の読み直しが、設定のあとの読み直しより後に古い結果で終わっても、新しい設定のまま', async () => {
  const app = loadApp();
  await app.open('/alarm');
  expect(await app.screen.findByText('アラームは設定されていません')).toBeOnTheScreen();

  // 前面復帰のあとの次の予定の読み取りだけを、予約がない古い結果のまま止める
  const reads = app.alarm.alarmMock().getAlarmOccurrencesAsync;
  const held = deferred<unknown[]>();
  reads.mockImplementationOnce(() => held.promise);
  await app.emit('background');
  await app.emit('active');

  await app.rntl.fireEvent.press(
    app.screen.getByRole('button', { name: /4サイクル（6時間14分後）$/ }),
  );
  expect(await app.screen.findByText('次のアラーム 13:14')).toBeOnTheScreen();

  await app.rntl.act(async () => held.resolve([]));

  expect(app.screen.getByText('次のアラーム 13:14')).toBeOnTheScreen();
  expect(app.screen.queryByText('アラームは設定されていません')).toBeNull();
});
