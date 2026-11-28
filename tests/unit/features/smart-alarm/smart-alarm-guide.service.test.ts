import { guideOf } from '@/features/smart-alarm/smart-alarm-guide.service';
import type { AlarmPermission } from '@/features/smart-alarm/smart-alarm.types';

/** 既定の許可（iOS の形。全画面表示・通知の値は省略） */
const IOS: AlarmPermission = {
  platform: 'ios',
  status: 'authorized',
  canScheduleExactAlarms: true,
  canOpenSettings: true,
};
/** Android の形ですべて許可あり */
const ANDROID: AlarmPermission = {
  ...IOS,
  platform: 'android',
  canUseFullScreenIntent: true,
  canPostNotifications: true,
};

const NO_PERMISSION = 'アラームの許可がありません。設定で許可してください';
const FULL_SCREEN = 'ロック中の画面にアラームを大きく出すには、設定で許可してください';

describe('guideOf', () => {
  // T040
  it('使えない端末なら設定せず、ボタンなしで案内する', () => {
    expect(guideOf({ ...IOS, status: 'unavailable' })).toEqual({
      schedule: false,
      message: 'この端末ではアラームを使えません',
      settings: null,
    });
  });

  // T040
  it.each([
    ['denied', { status: 'denied' }],
    ['notDetermined', { status: 'notDetermined' }],
    ['unknown', { status: 'unknown' }],
    ['canScheduleExactAlarms が偽', { canScheduleExactAlarms: false }],
  ] as const)('%s なら設定せず、正確なアラームの設定を開く案内', (_label, change) => {
    expect(guideOf({ ...IOS, ...change })).toEqual({
      schedule: false,
      message: NO_PERMISSION,
      settings: 'alarm',
    });
  });

  // T041
  it('設定を開けない端末なら、許可がない案内にボタンを付けない', () => {
    expect(guideOf({ ...IOS, status: 'denied', canOpenSettings: false })).toEqual({
      schedule: false,
      message: NO_PERMISSION,
      settings: null,
    });
  });

  // T042
  it('全画面表示の許可だけがなければ、設定して全画面表示の設定を開く案内', () => {
    expect(guideOf({ ...ANDROID, canUseFullScreenIntent: false })).toEqual({
      schedule: true,
      message: FULL_SCREEN,
      settings: 'fullScreen',
    });
  });

  // T043
  it.each([
    ['iOS の形（値の省略は真とみなす）', IOS],
    ['Android の形ですべて許可あり', ANDROID],
    ['Android で通知の許可だけがない', { ...ANDROID, canPostNotifications: false }],
  ])('%s なら設定して案内なし', (_label, permission) => {
    expect(guideOf(permission)).toEqual({ schedule: true, message: null, settings: null });
  });

  // T049
  it('正確なアラームと全画面表示の両方がなければ、上の行（許可がない）を使う', () => {
    expect(
      guideOf({ ...ANDROID, canScheduleExactAlarms: false, canUseFullScreenIntent: false }),
    ).toEqual({ schedule: false, message: NO_PERMISSION, settings: 'alarm' });
  });

  // T049
  it('全画面表示の案内でも、設定を開けない端末ならボタンを付けない', () => {
    expect(guideOf({ ...ANDROID, canUseFullScreenIntent: false, canOpenSettings: false })).toEqual({
      schedule: true,
      message: FULL_SCREEN,
      settings: null,
    });
  });
});
