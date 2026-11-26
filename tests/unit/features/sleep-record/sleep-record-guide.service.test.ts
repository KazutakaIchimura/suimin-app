import { buildGuides } from '@/features/sleep-record/sleep-record-guide.service';
import type { AccessStatus, Guide, HealthOs } from '@/features/sleep-record/sleep-record.types';

const NO_DATA_IOS =
  '睡眠データがありません。許可していない場合は、設定 → ヘルスケア → データアクセスとデバイス → suimin-app で睡眠を許可してください。SOXAI アプリのヘルスケア連携も確認してください';
const NO_DATA_ANDROID =
  '睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください';

/** `ready` 以外の連携状態ごとの案内（3.1 の表） */
const ACCESS_GUIDES: [HealthOs, AccessStatus, Guide][] = [
  [
    'ios',
    'unavailable',
    { kind: 'access', message: 'この端末ではヘルスケア連携を使えません', buttons: [] },
  ],
  [
    'ios',
    'notRequested',
    {
      kind: 'access',
      message: null,
      buttons: [{ action: 'requestAccess', label: 'ヘルスケアと連携する' }],
    },
  ],
  [
    'ios',
    'checkFailed',
    {
      kind: 'access',
      message: 'ヘルスケアの状態を確認できませんでした',
      buttons: [{ action: 'retryAccess', label: '再試行' }],
    },
  ],
  [
    'android',
    'unavailable',
    { kind: 'access', message: 'この端末ではヘルスケア連携を使えません', buttons: [] },
  ],
  [
    'android',
    'updateRequired',
    { kind: 'access', message: 'ヘルスコネクトを更新してください', buttons: [] },
  ],
  [
    'android',
    'notGranted',
    {
      kind: 'access',
      message: '許可しなかった場合は、ヘルスコネクトの設定から許可してください',
      buttons: [
        { action: 'requestAccess', label: 'ヘルスコネクトと連携する' },
        { action: 'openSettings', label: '設定を開く' },
      ],
    },
  ],
  [
    'android',
    'checkFailed',
    {
      kind: 'access',
      message: 'ヘルスケアの状態を確認できませんでした',
      buttons: [{ action: 'retryAccess', label: '再試行' }],
    },
  ],
];

const base = { hasSessions: false, syncing: false, syncFailed: false };

// T113
it.each(ACCESS_GUIDES)(
  '睡眠なしで %s の %s なら、その状態の案内1つだけ',
  (os, status, expected) => {
    const guides = buildGuides({ ...base, os, status });

    expect(guides).toEqual([expected]);
    expect(JSON.stringify(guides)).not.toContain('睡眠データがありません');
  },
);

const BOTH_OS: HealthOs[] = ['ios', 'android'];
const NO_DATA: Record<HealthOs, Guide> = {
  ios: { kind: 'noData', message: NO_DATA_IOS, buttons: [] },
  android: { kind: 'noData', message: NO_DATA_ANDROID, buttons: [] },
};
const SYNC_FAILED: Guide = {
  kind: 'syncFailed',
  message: '睡眠データの取り込みに失敗しました',
  buttons: [{ action: 'retrySync', label: '再試行' }],
};

// T114
it.each(BOTH_OS)('%s の ready で睡眠ありなら案内なし', (os) => {
  expect(buildGuides({ ...base, os, status: 'ready', hasSessions: true })).toEqual([]);
});

// T115
it.each(BOTH_OS)('%s の ready で睡眠なし・同期中でないなら、その OS の睡眠なしの案内', (os) => {
  expect(buildGuides({ ...base, os, status: 'ready' })).toEqual([NO_DATA[os]]);
});

// T116
it.each(BOTH_OS)('%s の ready で睡眠なし・同期失敗なら、失敗の表示と睡眠なしの案内の2つ', (os) => {
  expect(buildGuides({ ...base, os, status: 'ready', syncFailed: true })).toEqual([
    SYNC_FAILED,
    NO_DATA[os],
  ]);
});

// T117
it('ready で睡眠あり・同期失敗なら、失敗の表示だけ', () => {
  expect(
    buildGuides({ ...base, os: 'ios', status: 'ready', hasSessions: true, syncFailed: true }),
  ).toEqual([SYNC_FAILED]);
});

// T118
it.each(ACCESS_GUIDES)('睡眠ありで %s の %s なら、その状態の案内だけ', (os, status, expected) => {
  expect(buildGuides({ ...base, os, status, hasSessions: true })).toEqual([expected]);
});

// T188
describe.each([
  ['睡眠なし', false],
  ['睡眠あり', true],
])('前回の同期失敗あり・同期中でない・%s', (_label, hasSessions) => {
  it.each(ACCESS_GUIDES)(
    '%s の %s なら、失敗の表示は出ずその状態の案内だけ',
    (os, status, expected) => {
      expect(buildGuides({ ...base, os, status, hasSessions, syncFailed: true })).toEqual([
        expected,
      ]);
    },
  );
});

const IMPORTING: Guide = {
  kind: 'importing',
  message: '睡眠データを取り込んでいます',
  buttons: [],
};
const SYNCING: Guide = { kind: 'syncing', message: null, buttons: [] };

// T119・T120
describe.each([
  ['前回の同期失敗なし', false],
  ['前回の同期失敗あり', true],
])('ready・同期中・%s', (_label, syncFailed) => {
  it.each(BOTH_OS)('%s で睡眠なしなら「睡眠データを取り込んでいます」だけ', (os) => {
    expect(buildGuides({ ...base, os, status: 'ready', syncing: true, syncFailed })).toEqual([
      IMPORTING,
    ]);
  });

  it.each(BOTH_OS)('%s で睡眠ありなら同期中の表示だけ', (os) => {
    expect(
      buildGuides({ ...base, os, status: 'ready', hasSessions: true, syncing: true, syncFailed }),
    ).toEqual([SYNCING]);
  });
});
