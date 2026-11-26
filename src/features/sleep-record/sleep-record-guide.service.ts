// 表示する案内の判定（設計書 3.1「連携状態と案内」「読み込み中の表示」）
import type {
  AccessStatus,
  Guide,
  GuideButton,
  HealthOs,
} from '@/features/sleep-record/sleep-record.types';

const RETRY: GuideButton = { action: 'retryAccess', label: '再試行' };

/** `ready` で睡眠がなく同期中でないときの案内 */
const NO_DATA_MESSAGE: Record<HealthOs, string> = {
  ios: '睡眠データがありません。許可していない場合は、設定 → ヘルスケア → データアクセスとデバイス → suimin-app で睡眠を許可してください。SOXAI アプリのヘルスケア連携も確認してください',
  android: '睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください',
};

/** `ready` 以外の連携状態の案内 */
function accessGuide(os: HealthOs, status: Exclude<AccessStatus, 'ready'>): Guide {
  switch (status) {
    case 'unavailable':
      return { kind: 'access', message: 'この端末ではヘルスケア連携を使えません', buttons: [] };
    case 'updateRequired':
      return { kind: 'access', message: 'ヘルスコネクトを更新してください', buttons: [] };
    case 'notRequested':
      return {
        kind: 'access',
        message: null,
        buttons: [{ action: 'requestAccess', label: connectLabel(os) }],
      };
    case 'notGranted':
      return {
        kind: 'access',
        message: '許可しなかった場合は、ヘルスコネクトの設定から許可してください',
        buttons: [
          { action: 'requestAccess', label: connectLabel(os) },
          { action: 'openSettings', label: '設定を開く' },
        ],
      };
    case 'checkFailed':
      return {
        kind: 'access',
        message: 'ヘルスケアの状態を確認できませんでした',
        buttons: [RETRY],
      };
  }
}

function connectLabel(os: HealthOs): string {
  return os === 'ios' ? 'ヘルスケアと連携する' : 'ヘルスコネクトと連携する';
}

/**
 * 連携状態・OS・睡眠の有無・同期中か・同期失敗の有無から、表示する案内を上から順に返す
 */
export function buildGuides(input: {
  os: HealthOs;
  status: AccessStatus;
  hasSessions: boolean;
  syncing: boolean;
  syncFailed: boolean;
}): Guide[] {
  // 同期できない状態では、同期の失敗より状態の案内のほうが次にすることにつながる
  if (input.status !== 'ready') return [accessGuide(input.os, input.status)];
  // 同期中は前回の失敗も睡眠なしの案内も出さない（初回同期の途中に誤った案内を出さない）
  if (input.syncing) {
    return [
      input.hasSessions
        ? { kind: 'syncing', message: null, buttons: [] }
        : { kind: 'importing', message: '睡眠データを取り込んでいます', buttons: [] },
    ];
  }
  const guides: Guide[] = [];
  if (input.syncFailed) {
    guides.push({
      kind: 'syncFailed',
      message: '睡眠データの取り込みに失敗しました',
      buttons: [{ action: 'retrySync', label: '再試行' }],
    });
  }
  if (!input.hasSessions) {
    guides.push({ kind: 'noData', message: NO_DATA_MESSAGE[input.os], buttons: [] });
  }
  return guides;
}
