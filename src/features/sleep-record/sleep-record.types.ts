// 睡眠記録の型・データ定義（設計書 docs/features/01_sleep-record.md の 3.1・3.4）

/** OS。受け口層が `Platform.OS` から作り、サービス層・リポジトリ層へ引数で渡す */
export type HealthOs = 'ios' | 'android';

/** アプリ内のステージ（3.1「ステージの共通化」） */
export type Stage = 'awake' | 'light' | 'deep' | 'rem' | 'unspecified';

/**
 * ヘルスケアから読んだセグメント1件（共通の形）。
 * ID・記録元は欠けていることがあり（`undefined`・空文字）、組み立てサービスが代わりの値を付ける。
 */
export type IosSegment = {
  os: 'ios';
  /** サンプルの UUID */
  sampleId: string | undefined;
  /** 記録元（bundle identifier） */
  sourceId: string | undefined;
  stage: Stage;
  /** UNIX ミリ秒 */
  startAt: number;
  endAt: number;
};

export type AndroidSegment = {
  os: 'android';
  /** SleepSession の `metadata.id` */
  sessionId: string | undefined;
  /** SleepSession の `metadata.dataOrigin` */
  sourceId: string | undefined;
  /** SleepSession の `startTime`/`endTime`（ステージがすべて捨てられたときに使う） */
  sessionStartAt: number;
  sessionEndAt: number;
  stage: Stage;
  startAt: number;
  endAt: number;
};

export type HealthSegment = IosSegment | AndroidSegment;

/** ヘルスケアのリポジトリが返す読み取り結果 */
export type HealthReadResult = {
  segments: HealthSegment[];
  /** 表にないステージ値の件数（値そのものは返さない） */
  unknownStageCount: number;
};

/** 睡眠内のステージ区間（重ならない） */
export type StageInterval = {
  stage: Stage;
  startAt: number;
  endAt: number;
};

/** 睡眠1回分（`sleep_sessions` の1行とそのステージ区間） */
export type SleepSession = {
  id: string;
  sourceId: string;
  startAt: number;
  endAt: number;
  /** 帰属日 `YYYY-MM-DD` */
  wakeDate: string;
  /** 睡眠時間（分、切り捨て） */
  asleepMinutes: number;
  hasStages: boolean;
  stages: StageInterval[];
};

/** ステージ区間を除いた睡眠（一覧用の取得結果） */
export type SleepSessionSummary = Omit<SleepSession, 'stages'>;

/** 一覧の1行（日ごとの要約） */
export type DaySummary = {
  wakeDate: string;
  totalAsleepMinutes: number;
  mainStartAt: number;
  mainEndAt: number;
  napCount: number;
};

/** ステージ内訳の1行 */
export type StageBreakdownRow = {
  stage: Stage;
  minutes: number;
  /** 割合（%、四捨五入） */
  percent: number;
};

/** 1日の詳細 */
export type DayDetail =
  | { kind: 'none' }
  | {
      kind: 'found';
      main: SleepSession;
      /** ステージなしの睡眠は `null`。ステージありで出す行がないときは `[]` */
      breakdown: StageBreakdownRow[] | null;
      /** 就寝の早い順 */
      naps: SleepSession[];
    };

/** 連携状態（3.1「連携状態と案内」）。`checkFailed` は store が作る */
export type AccessStatus =
  'unavailable' | 'updateRequired' | 'notRequested' | 'notGranted' | 'ready' | 'checkFailed';

/** リポジトリ・サービスが返す連携状態（`checkFailed` は含まない） */
export type CheckedAccessStatus = Exclude<AccessStatus, 'checkFailed'>;

/** 案内のボタンが行う操作 */
export type GuideAction = 'requestAccess' | 'openSettings' | 'retryAccess' | 'retrySync';

/** 案内のボタン */
export type GuideButton = { action: GuideAction; label: string };

/**
 * 画面に出す案内1つ（3.1「連携状態と案内」）。
 * - `access`：`ready` 以外の連携状態の案内
 * - `syncFailed`：同期の失敗表示
 * - `noData`：`ready` で睡眠がないときの案内
 * - `importing`：睡眠がなく同期中のとき（「睡眠データを取り込んでいます」）
 * - `syncing`：睡眠があり同期中のとき（文言なし。画面は `testID` で出す）
 */
export type Guide = {
  kind: 'access' | 'syncFailed' | 'noData' | 'importing' | 'syncing';
  message: string | null;
  buttons: GuideButton[];
};
