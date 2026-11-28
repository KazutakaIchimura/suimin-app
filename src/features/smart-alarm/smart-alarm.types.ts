// スマートアラームの型・データ定義と、仕様の定数（設計書 docs/features/03_smart-alarm.md の 3.1・3.2）。
// 定数は要件と人間の判断で決めた仕様の値で、利用者や運用で変える値ではないため、設定テーブルに置かない（3.2）

const MINUTE_MS = 60 * 1000;

/** 標準値：入眠時間（分） */
export const STANDARD_ONSET_MINUTES = 14;
/** 標準値：サイクル長（分） */
export const STANDARD_CYCLE_MINUTES = 90;
/** 実績に切り替えるのに要る、値のある日数 */
export const REQUIRED_DAYS = 14;
/** 推定の元データの日数（今日の29日前〜今日） */
export const ESTIMATE_RANGE_DAYS = 30;
/** その日の入眠時間として使う上限（切り捨て前。これ以下を使う） */
export const MAX_ONSET_MS = 60 * MINUTE_MS;
/** レムをつなぐ空きの上限（これ未満ならつなぐ） */
export const REM_MERGE_GAP_MS = 30 * MINUTE_MS;
/** その日のサイクル長として使う、レム期の終わりの間隔の範囲（分。両端を含む） */
export const CYCLE_MIN_MINUTES = 60;
export const CYCLE_MAX_MINUTES = 150;
/** スヌーズの間隔（秒） */
export const SNOOZE_SECONDS = 9 * 60;
/** Android で誰も止めないときに鳴り止むまで（秒） */
export const RING_MAX_SECONDS = 5 * 60;
/** アプリを開いた理由を古いとみなして捨てるまで（これ以上前なら捨てる） */
export const STALE_HANDOFF_MS = 10 * MINUTE_MS;

/** 使う値の出どころ。標準値なら、切り替えまでに足りない日数も持つ */
export type ParamSource = { kind: 'estimated' } | { kind: 'standard'; missingDays: number };

/** 区切りの計算に使う値（入眠時間・サイクル長） */
export type CycleParams = {
  onsetMinutes: number;
  onsetSource: ParamSource;
  cycleMinutes: number;
  cycleSource: ParamSource;
};

/** 候補の種類：n サイクル目の区切り、または希望の時刻 */
export type CandidateKind = { kind: 'cycle'; cycles: number } | { kind: 'desired' };

/** アラームを鳴らす時刻の候補 */
export type AlarmCandidate = {
  /** 鳴らす時刻（UNIX ミリ秒。秒以下は 0） */
  at: number;
  /** 基準（今・就寝予定時刻。分に切り捨て）から候補までの分 */
  minutesFromBase: number;
} & CandidateKind;

/**
 * アラームの許可の結果（ライブラリ `react-native-alarm-scheduler` の `AlarmPermissionResponse` を写したもの。
 * サービス層・受け口層がライブラリの型に頼らないように）
 */
export type AlarmPermission = {
  platform: 'android' | 'ios';
  status: 'authorized' | 'denied' | 'notDetermined' | 'unavailable' | 'unknown';
  canScheduleExactAlarms: boolean;
  canOpenSettings: boolean;
  /** Android 14 以降の全画面表示の許可。省略は真とみなす */
  canUseFullScreenIntent?: boolean;
  /** Android 13 以降の通知の許可。案内には使わない（省略は真とみなす） */
  canPostNotifications?: boolean;
};

// ---- リポジトリが返す形（ライブラリの型のうち使うものを写したもの。サービス層がライブラリの型に頼らないように） ----

/** 鳴動の予定（ライブラリの `AlarmOccurrence` のうち使うもの） */
export type AlarmOccurrenceRecord = {
  occurrenceId: string;
  alarmId: string;
  scheduledFor: number;
  relationship: 'primary' | 'deferred' | 'followUp';
  phase: 'scheduled' | 'ringing' | 'completed' | 'cancelled';
};

/** アプリを開いた理由（ライブラリの `AlarmAction` のうち使うもの） */
export type AlarmHandoff = {
  alarmId: string;
  action: 'nativeStop' | 'secondaryOpen' | 'snooze' | 'dismiss';
  timestamp: number;
  trigger: boolean;
};

/** 今の鳴動（ライブラリの `AlarmContext` のうち使うもの） */
export type AlarmContextRecord = {
  id: string;
  occurrenceId: string | undefined;
  /** 鳴動の状態（`alerting`＝鳴っている、`countdown`＝スヌーズ中など）。ライブラリが省略することもある */
  state: string | undefined;
};

/** 延期の結果 */
export type SnoozeRecord = {
  status: 'resolved' | 'resolvedWithoutNext';
  nextAt: number | null;
};

/** 時刻ピッカーの「起きたい時刻」の既定（時・分） */
export const DEFAULT_WAKE = { hour: 7, minute: 0 } as const;

/** 開く設定の種類：正確なアラーム／全画面表示 */
export type AlarmSettingsKind = 'alarm' | 'fullScreen';

/** 許可の結果から決めた、設定するかと案内 */
export type AlarmGuide = {
  schedule: boolean;
  /** 案内の文言。なければ `null` */
  message: string | null;
  /** 「設定を開く」で開く設定。ボタンを出さないなら `null` */
  settings: AlarmSettingsKind | null;
};

/** 設定中のアラーム */
export type NextAlarm = {
  /** 鳴る時刻（UNIX ミリ秒） */
  at: number;
  /** スヌーズで予約した次の鳴動か */
  snoozed: boolean;
};

/** 設定中のアラームの読み取りの状態 */
export type NextAlarmState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; next: NextAlarm | null };

/** 設定の結果 */
export type SetAlarmResult =
  | { kind: 'blocked'; guide: AlarmGuide }
  | { kind: 'past' }
  /** 押した時刻が有限の数でない（設定しない） */
  | { kind: 'invalid' }
  | { kind: 'scheduled'; at: number; guide: AlarmGuide };

/** 予約のあとの取り消し（または取り消す ID を集める読み取り）が失敗した。新しいアラームは残っている */
export class CancelAfterScheduleError extends Error {
  readonly at: number;
  constructor(at: number, cause: unknown) {
    super('前のアラームを取り消せませんでした', { cause });
    this.name = 'CancelAfterScheduleError';
    this.at = at;
  }
}

/** スヌーズする鳴動の ID が、今の鳴動からも予定からも取れなかった */
export class SnoozeOccurrenceNotFoundError extends Error {
  constructor() {
    super('スヌーズする鳴動が見つかりませんでした');
    this.name = 'SnoozeOccurrenceNotFoundError';
  }
}

/**
 * アプリを開いた理由の処理の結果。`clear` は理由を消してよいか（store が `clearHandoff` を呼ぶ）
 * - none：理由がない
 * - clearOnly：スヌーズ以外・古い理由。何もせず消す
 * - snoozed：スヌーズした（次の鳴動の時刻）
 * - noNext：延期はできたが次の鳴動がない（`resolvedWithoutNext`）
 */
export type HandoffResult =
  | { kind: 'none'; clear: false }
  | { kind: 'clearOnly'; clear: true }
  | { kind: 'snoozed'; clear: true; nextAt: number }
  | { kind: 'noNext'; clear: true };
