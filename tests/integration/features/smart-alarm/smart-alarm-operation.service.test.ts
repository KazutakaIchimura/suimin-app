import { alarmMock, fakeAlarmState, resetAlarmMocks, seedAlarm } from '../../helpers/alarm-mocks';
import { captureLogs, type CapturedLog } from '../../helpers/capture-logs';

import {
  cancelAll,
  clearHandoff,
  loadNextAlarm,
  openSettings,
  processHandoff,
  setAlarm,
} from '@/features/smart-alarm/smart-alarm-operation.service';
import {
  CancelAfterScheduleError,
  SnoozeOccurrenceNotFoundError,
} from '@/features/smart-alarm/smart-alarm.types';

/** JST の日時（`2026-11-29T05:48` または `2026-11-29T05:48:30` の形）を UNIX ミリ秒にする */
const jst = (local: string) =>
  new Date(`${local}${local.length === 16 ? ':00' : ''}+09:00`).getTime();

const NOW = jst('2026-11-28T23:34');
const AT = jst('2026-11-29T05:48');
const NEW_ID = '00000000-0000-4000-8000-000000000001';

let now = NOW;
const getNow = () => now;
/** 今を変える（`getNow` と `Date.now()` の両方。偽物の次の鳴動は `Date.now()` から計算するため） */
function setNow(ms: number) {
  now = ms;
  jest.setSystemTime(ms);
}

let logsNamed: (name: string) => CapturedLog[];

beforeEach(() => {
  resetAlarmMocks();
  jest.useFakeTimers();
  setNow(NOW);
  ({ named: logsNamed } = captureLogs());
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** 投げられたものを返す（投げなければ失敗） */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('投げなかった');
}

/**
 * ログに時刻（UNIX ミリ秒と「5:48」の形）が入っていないこと。
 * `err.stack` はスタックの行（`ファイル:行:列`）が時刻の形に当たるので、1行目（エラーの文言）だけを見る
 */
function expectNoTime(lines: CapturedLog[], times: number[]) {
  for (const { entry } of lines) {
    const err = entry.err as { stack?: string } | undefined;
    const text = JSON.stringify(
      err?.stack === undefined
        ? entry
        : { ...entry, err: { ...err, stack: err.stack.split('\n')[0] } },
    );
    for (const t of times) {
      expect(text).not.toContain(String(t));
      const d = new Date(t);
      expect(text).not.toContain(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
    }
  }
}

describe('setAlarm（設定）', () => {
  // T060
  it('許可があれば1回だけ鳴るアラームを鳴らし方の設定つきで予約し、時刻を出さない info ログを出す', async () => {
    const result = await setAlarm({ at: AT, requestId: 'req-1', getNow });

    const mock = alarmMock();
    expect(mock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mock.requestPermissionsAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mock.scheduleAlarmAsync.mock.invocationCallOrder[0],
    );
    expect(mock.scheduleAlarmAsync).toHaveBeenCalledTimes(1);
    const input = mock.scheduleAlarmAsync.mock.calls[0][0];
    expect(input).toMatchObject({
      id: NEW_ID,
      hour: 5,
      minute: 48,
      timestamp: AT,
      title: '起床の時間です',
      ios: {
        alertActionMode: 'default',
        stopButtonTitle: '停止',
        secondaryButtonTitle: 'スヌーズ',
        secondaryButtonBehavior: 'openApp',
        stopIntentBehavior: 'recordOnly',
        countdownTitle: 'スヌーズ中',
      },
      android: { vibrate: true, maxRingDurationSeconds: 300 },
    });
    expect(input.weekdays).toBeUndefined();
    expect(input.android.launchUri).toBeUndefined();
    for (const key of ['soundUri', 'soundName', 'silent']) {
      expect(input[key]).toBeUndefined();
      expect(input.ios[key]).toBeUndefined();
      expect(input.android[key]).toBeUndefined();
    }
    expect(mock.cancelAlarmAsync).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'scheduled',
      at: AT,
      guide: { schedule: true, message: null, settings: null },
    });
    const lines = logsNamed('smartAlarm.schedule');
    expect(lines.map((l) => [l.level, l.entry])).toEqual([
      ['info', { name: 'smartAlarm.schedule', requestId: 'req-1', alarmId: NEW_ID, cancelled: 0 }],
    ]);
    expectNoTime(lines, [AT]);
  });

  // T061
  it('予約してから、新しい ID 以外の予約とスヌーズの予定を1回ずつ取り消す（scheduled 以外の予定は取り消さない）', async () => {
    seedAlarm('A', jst('2026-11-29T06:00'));
    // 予約の一覧にだけある D（予定は completed だけ）
    fakeAlarmState().scheduled.push({ id: 'D', timestamp: jst('2026-11-28T06:00') });
    fakeAlarmState().occurrences.push(
      {
        occurrenceId: 'B-1',
        alarmId: 'B',
        scheduledFor: jst('2026-11-29T07:00'),
        relationship: 'deferred',
        phase: 'scheduled',
      },
      {
        occurrenceId: 'Z',
        alarmId: 'Z',
        scheduledFor: jst('2026-11-28T07:00'),
        relationship: 'primary',
        phase: 'completed',
      },
      {
        occurrenceId: 'D',
        alarmId: 'D',
        scheduledFor: jst('2026-11-28T06:00'),
        relationship: 'primary',
        phase: 'completed',
      },
    );

    await setAlarm({ at: AT, requestId: 'req-1', getNow });

    const mock = alarmMock();
    // 予約の一覧の順（A・D）、続けて予定の順（B）
    const cancelled = mock.cancelAlarmAsync.mock.calls.map((c) => c[0]);
    expect(cancelled).toEqual(['A', 'D', 'B']);
    expect(mock.scheduleAlarmAsync.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...mock.cancelAlarmAsync.mock.invocationCallOrder),
    );
    expect(logsNamed('smartAlarm.schedule')[0].entry).toMatchObject({ cancelled: 3 });
  });

  // T129
  it.each([[Number.NaN], [Infinity], [-Infinity]])(
    '押した時刻が %p なら、許可の要求も予約もせず、無効な時刻の結果を返す（ログなし）',
    async (at) => {
      expect(await setAlarm({ at, requestId: 'req-1', getNow })).toEqual({
        kind: 'invalid',
      });
      expect(alarmMock().requestPermissionsAsync).not.toHaveBeenCalled();
      expect(alarmMock().scheduleAlarmAsync).not.toHaveBeenCalled();
      expect(logsNamed('smartAlarm.schedule')).toEqual([]);
    },
  );

  // T126
  it('設定のたびに許可を求める（結果を覚えない）', async () => {
    await setAlarm({ at: AT, requestId: 'req-1', getNow });
    await setAlarm({ at: jst('2026-11-29T07:18'), requestId: 'req-2', getNow });

    expect(alarmMock().requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  // T062
  it.each([
    [
      'denied',
      { status: 'denied' },
      {
        schedule: false,
        message: 'アラームの許可がありません。設定で許可してください',
        settings: 'alarm',
      },
    ],
    [
      'unavailable',
      { status: 'unavailable' },
      { schedule: false, message: 'この端末ではアラームを使えません', settings: null },
    ],
  ])('許可が %s なら予約も取り消しもせず、案内を返す', async (_label, change, guide) => {
    seedAlarm('A', jst('2026-11-29T06:00'));
    Object.assign(fakeAlarmState().permission, change);

    expect(await setAlarm({ at: AT, requestId: 'req-1', getNow })).toEqual({
      kind: 'blocked',
      guide,
    });
    expect(alarmMock().scheduleAlarmAsync).not.toHaveBeenCalled();
    expect(alarmMock().cancelAlarmAsync).not.toHaveBeenCalled();
  });

  // T063
  it('全画面表示の許可だけがなければ、予約して案内も返す', async () => {
    Object.assign(fakeAlarmState().permission, {
      platform: 'android',
      canUseFullScreenIntent: false,
    });

    expect(await setAlarm({ at: AT, requestId: 'req-1', getNow })).toEqual({
      kind: 'scheduled',
      at: AT,
      guide: {
        schedule: true,
        message: 'ロック中の画面にアラームを大きく出すには、設定で許可してください',
        settings: 'fullScreen',
      },
    });
    expect(alarmMock().scheduleAlarmAsync).toHaveBeenCalledTimes(1);
  });

  // T064
  it.each([
    ['候補の時刻ちょうど', AT, AT, 'past'],
    ['候補の時刻の1ミリ秒前', AT, AT - 1, 'scheduled'],
    ['6:58:00 の候補に今 6:58:30', jst('2026-11-29T06:58'), jst('2026-11-29T06:58:30'), 'past'],
  ])('今が%sなら %s', async (_label, at, current, kind) => {
    setNow(current);

    const result = await setAlarm({ at, requestId: 'req-1', getNow });

    expect(result.kind).toBe(kind);
    expect(alarmMock().scheduleAlarmAsync).toHaveBeenCalledTimes(kind === 'past' ? 0 : 1);
  });

  // T065
  it('許可の要求の間に時刻が進み、候補が過ぎたら予約しない（今は許可の要求のあとに取る）', async () => {
    let release: () => void = () => {};
    alarmMock().requestPermissionsAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...fakeAlarmState().permission });
        }),
    );

    const pending = setAlarm({ at: AT, requestId: 'req-1', getNow });
    setNow(AT + 1000);
    release();

    expect((await pending).kind).toBe('past');
    expect(alarmMock().scheduleAlarmAsync).not.toHaveBeenCalled();
  });

  // T066
  it.each([
    ['許可の要求', 'requestPermissionsAsync'],
    ['予約', 'scheduleAlarmAsync'],
  ] as const)(
    '%sが失敗すると、取り消さずに error ログを出して同じエラーを投げる',
    async (_label, fn) => {
      seedAlarm('A', jst('2026-11-29T06:00'));
      const failure = new Error('native failure');
      alarmMock()[fn].mockRejectedValueOnce(failure);

      expect(await caught(() => setAlarm({ at: AT, requestId: 'req-1', getNow }))).toBe(failure);

      if (fn === 'requestPermissionsAsync') {
        expect(alarmMock().scheduleAlarmAsync).not.toHaveBeenCalled();
      }
      expect(alarmMock().cancelAlarmAsync).not.toHaveBeenCalled();
      expect(fakeAlarmState().scheduled.map((a) => a.id)).toEqual(['A']);
      expect(logsNamed('smartAlarm.schedule').map((l) => [l.level, l.entry])).toEqual([
        [
          'error',
          {
            name: 'smartAlarm.schedule',
            requestId: 'req-1',
            err: expect.objectContaining({ message: 'native failure' }),
          },
        ],
      ]);
    },
  );

  // T067
  it.each([
    ['取り消し', 'cancelAlarmAsync'],
    ['予約の一覧の読み取り', 'getScheduledAlarmsAsync'],
    ['予定の読み取り', 'getAlarmOccurrencesAsync'],
  ] as const)(
    '予約のあとの%sが失敗すると、新しいアラームは残り、取り消しの失敗を表すエラーを投げる',
    async (_label, fn) => {
      seedAlarm('A', jst('2026-11-29T06:00'));
      alarmMock()[fn].mockRejectedValueOnce(new Error('native failure'));

      const err = await caught(() => setAlarm({ at: AT, requestId: 'req-1', getNow }));

      expect(err).toBeInstanceOf(CancelAfterScheduleError);
      expect((err as CancelAfterScheduleError).at).toBe(AT);
      expect(fakeAlarmState().scheduled.map((a) => a.id)).toContain(NEW_ID);
      expect(logsNamed('smartAlarm.schedule').map((l) => l.level)).toEqual(['error']);
      expectNoTime(logsNamed('smartAlarm.schedule'), [AT]);
    },
  );
});

describe('loadNextAlarm（設定中のアラーム）', () => {
  /** 予定を1件足す */
  const occ = (
    id: string,
    time: string,
    phase: 'scheduled' | 'ringing' | 'completed' | 'cancelled',
    relationship: 'primary' | 'deferred' = 'primary',
  ) =>
    fakeAlarmState().occurrences.push({
      occurrenceId: id,
      alarmId: id,
      scheduledFor: jst(time),
      relationship,
      phase,
    });

  // T068
  it('scheduled の予定のうち最も早いもの（ほかの phase は選ばない）', async () => {
    occ('a', '2026-11-29T06:00', 'scheduled');
    occ('b', '2026-11-29T05:48', 'scheduled');
    occ('c', '2026-11-29T05:00', 'completed');
    occ('d', '2026-11-29T04:00', 'cancelled');
    occ('e', '2026-11-29T03:00', 'ringing');

    expect(await loadNextAlarm({ requestId: 'req-1' })).toEqual({ at: AT, snoozed: false });
  });

  // T069
  it('スヌーズの予定はスヌーズとして返す', async () => {
    occ('a', '2026-11-29T07:09', 'scheduled', 'deferred');

    expect(await loadNextAlarm({ requestId: 'req-1' })).toEqual({
      at: jst('2026-11-29T07:09'),
      snoozed: true,
    });
  });

  // T070
  it('予定がなければなし', async () => {
    expect(await loadNextAlarm({ requestId: 'req-1' })).toBeNull();
  });

  // T071
  it('読み取りが失敗すると error ログを出して同じエラーを投げる', async () => {
    const failure = new Error('native failure');
    alarmMock().getAlarmOccurrencesAsync.mockRejectedValueOnce(failure);

    expect(await caught(() => loadNextAlarm({ requestId: 'req-1' }))).toBe(failure);
    expect(logsNamed('smartAlarm.loadNext').map((l) => [l.level, l.entry.requestId])).toEqual([
      ['error', 'req-1'],
    ]);
  });

  // T081
  it('設定のあとの取り消しが失敗したとき、残っているうち最も早いものが返る', async () => {
    seedAlarm('A', jst('2026-11-29T05:00'));
    alarmMock().cancelAlarmAsync.mockRejectedValueOnce(new Error('native failure'));
    await caught(() => setAlarm({ at: AT, requestId: 'req-1', getNow }));

    expect(await loadNextAlarm({ requestId: 'req-2' })).toEqual({
      at: jst('2026-11-29T05:00'),
      snoozed: false,
    });
  });
});

describe('cancelAll（解除）', () => {
  // T072
  it('予約の一覧と予定の両方の ID を、重なりを除いて1回ずつ取り消す（scheduled 以外は取り消さない）', async () => {
    seedAlarm('A', jst('2026-11-29T05:48'));
    seedAlarm('B', jst('2026-11-29T06:00'));
    // 予約の一覧にだけある D（予定なし）
    fakeAlarmState().scheduled.push({ id: 'D', timestamp: jst('2026-11-29T08:00') });
    fakeAlarmState().occurrences.push(
      {
        occurrenceId: 'C-1',
        alarmId: 'C',
        scheduledFor: jst('2026-11-29T07:00'),
        relationship: 'deferred',
        phase: 'scheduled',
      },
      ...(['completed', 'ringing', 'cancelled'] as const).map((phase) => ({
        occurrenceId: `Z-${phase}`,
        alarmId: 'Z',
        scheduledFor: jst('2026-11-28T07:00'),
        relationship: 'primary' as const,
        phase,
      })),
    );

    await cancelAll({ requestId: 'req-1' });

    const cancelled = alarmMock().cancelAlarmAsync.mock.calls.map((c) => c[0]);
    expect(cancelled).toEqual(['A', 'B', 'D', 'C']);
    const lines = logsNamed('smartAlarm.cancel');
    expect(lines.map((l) => [l.level, l.entry])).toEqual([
      ['info', { name: 'smartAlarm.cancel', requestId: 'req-1', cancelled: 4 }],
    ]);
    expectNoTime(lines, [jst('2026-11-29T05:48')]);
  });

  // T073
  it('予約・予定がなければ何も呼ばずに成功する', async () => {
    await cancelAll({ requestId: 'req-1' });

    expect(alarmMock().cancelAlarmAsync).not.toHaveBeenCalled();
    expect(logsNamed('smartAlarm.cancel')[0].entry).toMatchObject({ cancelled: 0 });
  });

  // T074
  it('途中の1件が失敗すると残りは呼ばず、error ログを出して投げる（取り消せたものは消えたまま）', async () => {
    seedAlarm('A', jst('2026-11-29T05:48'));
    seedAlarm('B', jst('2026-11-29T06:00'));
    seedAlarm('C', jst('2026-11-29T07:00'));
    const failure = new Error('native failure');
    alarmMock().cancelAlarmAsync.mockImplementation(async (id: string) => {
      if (id === 'B') throw failure;
      fakeAlarmState().scheduled = fakeAlarmState().scheduled.filter((a) => a.id !== id);
      return true;
    });

    expect(await caught(() => cancelAll({ requestId: 'req-1' }))).toBe(failure);
    expect(alarmMock().cancelAlarmAsync.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(fakeAlarmState().scheduled.map((a) => a.id)).toEqual(['B', 'C']);
    expect(logsNamed('smartAlarm.cancel').map((l) => l.level)).toEqual(['error']);
  });

  // T075
  it.each([['getScheduledAlarmsAsync'], ['getAlarmOccurrencesAsync']] as const)(
    'ID を集める読み取り（%s）が失敗すると、何も取り消さずに error ログを出して投げる',
    async (fn) => {
      seedAlarm('A', jst('2026-11-29T05:48'));
      const failure = new Error('native failure');
      alarmMock()[fn].mockRejectedValueOnce(failure);

      expect(await caught(() => cancelAll({ requestId: 'req-1' }))).toBe(failure);
      expect(alarmMock().cancelAlarmAsync).not.toHaveBeenCalled();
      expect(logsNamed('smartAlarm.cancel').map((l) => l.level)).toEqual(['error']);
    },
  );
});

describe('processHandoff・clearHandoff（スヌーズ）', () => {
  const RING_NOW = jst('2026-11-29T07:00:30');

  /** T076 の前提：A が鳴っていて、スヌーズのボタンで開いた */
  function ringing(
    handoff: Partial<NonNullable<ReturnType<typeof fakeAlarmState>['handoff']>> = {},
  ) {
    setNow(RING_NOW);
    fakeAlarmState().occurrences.push({
      occurrenceId: 'A',
      alarmId: 'A',
      scheduledFor: jst('2026-11-29T07:00'),
      relationship: 'primary',
      phase: 'ringing',
    });
    fakeAlarmState().context = { id: 'A', occurrenceId: 'A' };
    fakeAlarmState().handoff = {
      id: 'h1',
      alarmId: 'A',
      action: 'secondaryOpen',
      timestamp: jst('2026-11-29T07:00:10'),
      ...handoff,
    };
  }

  const resolveCalls = () => alarmMock().resolveAlarmOccurrenceAsync.mock.calls;

  // T076
  it('スヌーズのボタンなら、今の鳴動を9分後へ延期し、次の鳴動の時刻を返す（理由はここでは消さない）', async () => {
    ringing();

    const result = await processHandoff({ requestId: 'req-1', now: getNow() });

    expect(resolveCalls()).toEqual([
      [
        'A',
        {
          outcome: 'deferred',
          next: { delaySeconds: 540, relationship: 'deferred' },
          idempotencyKey: 'snooze:A',
        },
      ],
    ]);
    expect(result).toEqual({ kind: 'snoozed', clear: true, nextAt: jst('2026-11-29T07:09:30') });
    expect(alarmMock().clearPendingNativeAlarmHandoffAsync).not.toHaveBeenCalled();
    const lines = logsNamed('smartAlarm.snooze');
    expect(lines.map((l) => [l.level, l.entry])).toEqual([
      ['info', { name: 'smartAlarm.snooze', requestId: 'req-1', alarmId: 'A', status: 'resolved' }],
    ]);
    expectNoTime(lines, [jst('2026-11-29T07:09:30')]);
  });

  /** T077・T058 の前提：今の鳴動が取れず、予定に A の ringing（A-2）と別のアラーム Y の ringing がある */
  function ringingInOccurrencesOnly() {
    ringing();
    fakeAlarmState().occurrences = [
      {
        occurrenceId: 'A-2',
        alarmId: 'A',
        scheduledFor: jst('2026-11-29T07:00'),
        relationship: 'primary',
        phase: 'ringing',
      },
      {
        occurrenceId: 'A-3',
        alarmId: 'A',
        scheduledFor: jst('2026-11-30T07:00'),
        relationship: 'primary',
        phase: 'scheduled',
      },
      {
        occurrenceId: 'Y-1',
        alarmId: 'Y',
        scheduledFor: jst('2026-11-29T07:00'),
        relationship: 'primary',
        phase: 'ringing',
      },
    ];
  }

  // T077
  it('今の鳴動が null なら、理由のアラームの予定から ringing の鳴動を使う', async () => {
    ringingInOccurrencesOnly();
    fakeAlarmState().context = null;

    await processHandoff({ requestId: 'req-1', now: getNow() });

    expect(alarmMock().getAlarmOccurrencesAsync).toHaveBeenCalledWith('A');
    expect(resolveCalls().map((c) => [c[0], c[1].idempotencyKey])).toEqual([['A-2', 'snooze:A-2']]);
  });

  // T058
  it.each([
    ['鳴動の ID がない', { id: 'A' }],
    ['理由と別のアラーム', { id: 'Y', occurrenceId: 'Y-1' }],
  ])('今の鳴動が%sなら取れないとみなし、予定から探す', async (_label, context) => {
    ringingInOccurrencesOnly();
    fakeAlarmState().context = context;

    await processHandoff({ requestId: 'req-1', now: getNow() });

    expect(resolveCalls().map((c) => [c[0], c[1].idempotencyKey])).toEqual([['A-2', 'snooze:A-2']]);
  });

  // T059
  it('スヌーズで予約した鳴動が鳴っているなら、その鳴動の ID で延期する（アラームの ID に戻さない）', async () => {
    ringing();
    fakeAlarmState().occurrences = [
      {
        occurrenceId: 'A-def-1',
        alarmId: 'A',
        scheduledFor: jst('2026-11-29T07:00'),
        relationship: 'deferred',
        phase: 'ringing',
      },
    ];
    fakeAlarmState().context = { id: 'A', occurrenceId: 'A-def-1', relationship: 'deferred' };

    await processHandoff({ requestId: 'req-1', now: getNow() });

    expect(resolveCalls().map((c) => [c[0], c[1].idempotencyKey])).toEqual([
      ['A-def-1', 'snooze:A-def-1'],
    ]);
    expect(
      fakeAlarmState().occurrences.filter(
        (o) => o.relationship === 'deferred' && o.phase === 'scheduled',
      ),
    ).toHaveLength(1);
  });

  // T078
  it('次の鳴動がない結果なら、次の鳴動なし・消してよい印つきの結果を返し、info ログに status を出す', async () => {
    ringing();
    alarmMock().resolveAlarmOccurrenceAsync.mockResolvedValueOnce({
      alarmId: 'A',
      resolvedOccurrenceId: 'A',
      outcome: 'deferred',
      status: 'resolvedWithoutNext',
    });

    expect(await processHandoff({ requestId: 'req-1', now: getNow() })).toEqual({
      kind: 'noNext',
      clear: true,
    });
    expect(resolveCalls()).toHaveLength(1);
    expect(logsNamed('smartAlarm.snooze').map((l) => [l.level, l.entry.status])).toEqual([
      ['info', 'resolvedWithoutNext'],
    ]);
  });

  // T089
  it('`trigger: false` の理由はスヌーズする', async () => {
    ringing({ trigger: false });

    expect((await processHandoff({ requestId: 'req-1', now: getNow() })).kind).toBe('snoozed');
  });

  // T079
  it.each([
    ['停止', { action: 'nativeStop' }],
    ['dismiss', { action: 'dismiss' }],
    ['snooze', { action: 'snooze' }],
    ['Android の鳴り始めの記録', { action: 'secondaryOpen', trigger: true }],
  ] as const)('理由が%sなら延期せず「消すだけ」の結果', async (_label, change) => {
    ringing(change);

    expect(await processHandoff({ requestId: 'req-1', now: getNow() })).toEqual({
      kind: 'clearOnly',
      clear: true,
    });
    expect(resolveCalls()).toHaveLength(0);
  });

  // T079
  it('理由がなければ「何もしない」結果', async () => {
    expect(await processHandoff({ requestId: 'req-1', now: getNow() })).toEqual({
      kind: 'none',
      clear: false,
    });
    expect(resolveCalls()).toHaveLength(0);
  });

  // T080
  it('延期が失敗すると、error ログを出して同じエラーを投げる', async () => {
    ringing();
    const failure = new Error('native failure');
    alarmMock().resolveAlarmOccurrenceAsync.mockRejectedValueOnce(failure);

    expect(await caught(() => processHandoff({ requestId: 'req-1', now: getNow() }))).toBe(failure);
    expect(logsNamed('smartAlarm.snooze').map((l) => l.level)).toEqual(['error']);
    expectNoTime(logsNamed('smartAlarm.snooze'), [jst('2026-11-29T07:00'), RING_NOW]);
    expect(alarmMock().clearPendingNativeAlarmHandoffAsync).not.toHaveBeenCalled();
  });

  // T080
  it('鳴動の ID がどちらからも取れなければ、SnoozeOccurrenceNotFoundError を投げる', async () => {
    ringing();
    fakeAlarmState().context = null;
    fakeAlarmState().occurrences = [];

    expect(
      await caught(() => processHandoff({ requestId: 'req-1', now: getNow() })),
    ).toBeInstanceOf(SnoozeOccurrenceNotFoundError);
    expect(alarmMock().clearPendingNativeAlarmHandoffAsync).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(0);
    expect(logsNamed('smartAlarm.snooze').map((l) => l.level)).toEqual(['error']);
    expectNoTime(logsNamed('smartAlarm.snooze'), [jst('2026-11-29T07:00'), RING_NOW]);
  });

  // T080
  it('今の鳴動の読み取りが例外を投げたら、予定に回さず同じエラーを投げる', async () => {
    ringing();
    const failure = new Error('native failure');
    alarmMock().getCurrentAlarmContextAsync.mockRejectedValueOnce(failure);

    expect(await caught(() => processHandoff({ requestId: 'req-1', now: getNow() }))).toBe(failure);
    expect(alarmMock().getAlarmOccurrencesAsync).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(0);
    expect(alarmMock().clearPendingNativeAlarmHandoffAsync).not.toHaveBeenCalled();
    expect(logsNamed('smartAlarm.snooze').map((l) => l.level)).toEqual(['error']);
    expectNoTime(logsNamed('smartAlarm.snooze'), [jst('2026-11-29T07:00'), RING_NOW]);
  });

  // T082
  it.each([
    ['9分59.999秒前', jst('2026-11-29T07:00:10') + 1, 'snoozed'],
    ['10分ちょうど前', jst('2026-11-29T07:00:10'), 'clearOnly'],
    ['それより前', jst('2026-11-29T06:50:00'), 'clearOnly'],
    ['今より後', jst('2026-11-29T07:10:20'), 'snoozed'],
  ])('今 7:10:10 に理由の時刻が%sなら %s', async (_label, timestamp, kind) => {
    ringing({ timestamp });
    setNow(jst('2026-11-29T07:10:10'));

    expect((await processHandoff({ requestId: 'req-1', now: getNow() })).kind).toBe(kind);
    expect(resolveCalls()).toHaveLength(kind === 'snoozed' ? 1 : 0);
  });

  // T083
  it('理由の読み取りが失敗すると、延期せずに error ログを出して同じエラーを投げる', async () => {
    ringing();
    const failure = new Error('native failure');
    alarmMock().getPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(failure);

    expect(await caught(() => processHandoff({ requestId: 'req-1', now: getNow() }))).toBe(failure);
    expect(resolveCalls()).toHaveLength(0);
    expect(logsNamed('smartAlarm.snooze').map((l) => l.level)).toEqual(['error']);
    expectNoTime(logsNamed('smartAlarm.snooze'), [jst('2026-11-29T07:00'), RING_NOW]);
  });

  // T084
  it('理由の消去が失敗すると、error ログを出して同じエラーを投げる', async () => {
    const failure = new Error('native failure');
    alarmMock().clearPendingNativeAlarmHandoffAsync.mockRejectedValueOnce(failure);

    expect(await caught(() => clearHandoff({ requestId: 'req-1' }))).toBe(failure);
    expect(logsNamed('smartAlarm.snooze').map((l) => [l.level, l.entry.requestId])).toEqual([
      ['error', 'req-1'],
    ]);
  });

  it('理由の消去が成功すると理由がなくなり、ログは出ない', async () => {
    ringing();

    await clearHandoff({ requestId: 'req-1' });

    expect(fakeAlarmState().handoff).toBeNull();
    expect(logsNamed('smartAlarm.snooze')).toEqual([]);
  });

  // T128
  it('延期のあと理由が残り、今の鳴動がなくなっていても、すでにある延期の予定をスヌーズ済みとして返す', async () => {
    ringing();
    await processHandoff({ requestId: 'req-1', now: getNow() });
    fakeAlarmState().context = null;
    setNow(jst('2026-11-29T07:05:00'));

    const second = await processHandoff({ requestId: 'req-2', now: getNow() });

    expect(resolveCalls()).toHaveLength(1);
    expect(second).toEqual({ kind: 'snoozed', clear: true, nextAt: jst('2026-11-29T07:09:30') });
  });

  // T147
  it.each([
    ['countdown（スヌーズ済みでまだ鳴っていない）', 'countdown', 'already'],
    ['alerting（鳴っている）', 'alerting', 'resolve'],
  ] as const)('今の鳴動が %s なら', async (_label, state, expected) => {
    ringing();
    if (state === 'countdown') {
      fakeAlarmState().occurrences = [
        {
          occurrenceId: 'A',
          alarmId: 'A',
          scheduledFor: jst('2026-11-29T07:00'),
          relationship: 'primary',
          phase: 'completed',
        },
        {
          occurrenceId: 'A-def-1',
          alarmId: 'A',
          scheduledFor: jst('2026-11-29T07:09:30'),
          relationship: 'deferred',
          phase: 'scheduled',
        },
      ];
      fakeAlarmState().context = { id: 'A', occurrenceId: 'A-def-1', state: 'countdown' };
    } else {
      fakeAlarmState().context = { id: 'A', occurrenceId: 'A', state: 'alerting' };
    }

    const result = await processHandoff({ requestId: 'req-1', now: getNow() });

    if (expected === 'already') {
      expect(resolveCalls()).toHaveLength(0);
      expect(result).toEqual({ kind: 'snoozed', clear: true, nextAt: jst('2026-11-29T07:09:30') });
    } else {
      expect(resolveCalls().map((c) => c[0])).toEqual(['A']);
    }
  });

  // T154
  it('今の鳴動が countdown で延期の予定もなければ、延期を呼ばずに SnoozeOccurrenceNotFoundError', async () => {
    ringing();
    fakeAlarmState().occurrences = [];
    fakeAlarmState().context = { id: 'A', occurrenceId: 'A-def-1', state: 'countdown' };

    expect(
      await caught(() => processHandoff({ requestId: 'req-1', now: getNow() })),
    ).toBeInstanceOf(SnoozeOccurrenceNotFoundError);
    expect(resolveCalls()).toHaveLength(0);
  });

  // T085
  it('理由を消さずにもう一度処理しても、同じ idempotencyKey を渡し、最初の結果が返る', async () => {
    ringing();
    await processHandoff({ requestId: 'req-1', now: getNow() });
    setNow(jst('2026-11-29T07:01:00'));

    const second = await processHandoff({ requestId: 'req-2', now: getNow() });

    expect(resolveCalls().map((c) => [c[0], c[1].idempotencyKey])).toEqual([
      ['A', 'snooze:A'],
      ['A', 'snooze:A'],
    ]);
    expect(second).toEqual({ kind: 'snoozed', clear: true, nextAt: jst('2026-11-29T07:09:30') });
    expect(fakeAlarmState().occurrences.filter((o) => o.relationship === 'deferred')).toHaveLength(
      1,
    );
  });
});

describe('openSettings（設定を開く）', () => {
  const fns = {
    alarm: 'openAlarmSettingsAsync',
    fullScreen: 'openFullScreenIntentSettingsAsync',
  } as const;
  const other = { alarm: 'fullScreen', fullScreen: 'alarm' } as const;

  // T086
  it.each([['alarm'], ['fullScreen']] as const)(
    '%s：開く関数が例外を投げると、err つきの error ログを出して投げる（もう一方は呼ばない）',
    async (kind) => {
      const failure = new Error('native failure');
      alarmMock()[fns[kind]].mockRejectedValueOnce(failure);

      expect(await caught(() => openSettings({ kind, requestId: 'req-1' }))).toBe(failure);
      expect(alarmMock()[fns[other[kind]]]).not.toHaveBeenCalled();
      expect(logsNamed('smartAlarm.openSettings').map((l) => [l.level, l.entry])).toEqual([
        [
          'error',
          {
            name: 'smartAlarm.openSettings',
            requestId: 'req-1',
            err: expect.objectContaining({ message: 'native failure' }),
          },
        ],
      ]);
    },
  );

  // T087
  it.each([['alarm'], ['fullScreen']] as const)(
    '%s：開く関数が false なら、opened: false の error ログを出し、失敗の結果を返す',
    async (kind) => {
      alarmMock()[fns[kind]].mockResolvedValueOnce(false);

      expect(await openSettings({ kind, requestId: 'req-1' })).toBe(false);
      expect(logsNamed('smartAlarm.openSettings').map((l) => [l.level, l.entry])).toEqual([
        ['error', { name: 'smartAlarm.openSettings', requestId: 'req-1', opened: false }],
      ]);
    },
  );

  // T088
  it.each([['alarm'], ['fullScreen']] as const)('%s：開けたら成功で、ログなし', async (kind) => {
    expect(await openSettings({ kind, requestId: 'req-1' })).toBe(true);
    expect(alarmMock()[fns[kind]]).toHaveBeenCalledTimes(1);
    expect(logsNamed('smartAlarm.openSettings')).toEqual([]);
  });
});
