// 許可の結果から、設定するかと案内を決める（設計書 docs/features/03_smart-alarm.md の 3.1「許可」の表）。純粋関数。
// 表の上の行から順に当て、最初に当たった行を使う。どの行でも設定を開けない端末ならボタンを出さない
import type {
  AlarmGuide,
  AlarmPermission,
  AlarmSettingsKind,
} from '@/features/smart-alarm/smart-alarm.types';

/** 許可の結果から、設定するかと案内を決める */
export function guideOf(permission: AlarmPermission): AlarmGuide {
  const button = (kind: AlarmSettingsKind) => (permission.canOpenSettings ? kind : null);
  if (permission.status === 'unavailable') {
    return { schedule: false, message: 'この端末ではアラームを使えません', settings: null };
  }
  if (permission.status !== 'authorized' || !permission.canScheduleExactAlarms) {
    return {
      schedule: false,
      message: 'アラームの許可がありません。設定で許可してください',
      settings: button('alarm'),
    };
  }
  // 省略（Android 以外）は真とみなす
  if (permission.canUseFullScreenIntent === false) {
    return {
      schedule: true,
      message: 'ロック中の画面にアラームを大きく出すには、設定で許可してください',
      settings: button('fullScreen'),
    };
  }
  return { schedule: true, message: null, settings: null };
}
