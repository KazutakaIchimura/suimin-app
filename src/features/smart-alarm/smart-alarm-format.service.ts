// スマートアラームの画面の文言（設計書 docs/features/03_smart-alarm.md の 3.4）。純粋関数。
// 時刻・日付・時間の書き方は 01 の整形サービスに合わせる（他機能のサービス層なので参照してよい）
import {
  formatDate,
  formatMinutes,
  formatTime,
} from '@/features/sleep-record/sleep-record-format.service';
import { localDate } from '@/features/sleep-record/sleep-record-period.service';
import type {
  AlarmCandidate,
  CycleParams,
  NextAlarm,
  NextAlarmState,
  ParamSource,
} from '@/features/smart-alarm/smart-alarm.types';

/**
 * 候補のボタンの文字。今から寝る「5:14 4サイクル（6時間14分後）」、
 * 起床時刻を指定「4:44 4サイクル（6時間14分）」「7:00 希望の時刻（8時間30分）」
 */
export function formatCandidate(candidate: AlarmCandidate, mode: 'now' | 'wake'): string {
  const kind = candidate.kind === 'cycle' ? `${candidate.cycles}サイクル` : '希望の時刻';
  const suffix = mode === 'now' ? '後' : '';
  return `${formatTime(candidate.at)} ${kind}（${formatMinutes(candidate.minutesFromBase)}${suffix}）`;
}

/** 使う値の説明 */
export function formatParams(params: CycleParams): string {
  return `入眠 ${params.onsetMinutes}分${sourceNote(params.onsetSource)}・1サイクル ${params.cycleMinutes}分${sourceNote(params.cycleSource)}`;
}

function sourceNote(source: ParamSource): string {
  return source.kind === 'estimated'
    ? '（あなたの記録）'
    : `（標準値。あと ${source.missingDays}日分の記録で切り替わります）`;
}

/** 設定中のアラームの時刻。今日でなければ日付を付け、スヌーズなら「（スヌーズ）」を付ける */
function formatAlarmTime(next: NextAlarm, now: Date): string {
  const date = localDate(new Date(next.at));
  const day = date === localDate(now) ? '' : `${formatDate(date, now)} `;
  return `${day}${formatTime(next.at)}${next.snoozed ? '（スヌーズ）' : ''}`;
}

/** アラームの画面の「次のアラーム 6:58」。なければ「アラームは設定されていません」 */
export function formatNextAlarm(next: NextAlarm | null, now: Date): string {
  return next === null
    ? 'アラームは設定されていません'
    : `次のアラーム ${formatAlarmTime(next, now)}`;
}

/** 一覧の入口の文字。読み込み中・読み取りの失敗は「アラーム」だけ（「未設定」にしない） */
export function formatEntry(state: NextAlarmState, now: Date): string {
  if (state.kind !== 'loaded') return 'アラーム';
  return state.next === null ? 'アラーム 未設定' : `アラーム ${formatAlarmTime(state.next, now)}`;
}

/** 設定に成功したときの文言 */
export const formatScheduled = (at: number) => `${formatTime(at)} にアラームを設定しました`;

/** 予約に成功したあとの取り消しが失敗したときの文言 */
export const formatScheduledButNotCancelled = (at: number) =>
  `${formatTime(at)} にアラームを設定しましたが、前のアラームを取り消せませんでした`;

/** スヌーズしたときの文言 */
export const formatSnoozed = (at: number) => `${formatTime(at)} にもう一度鳴ります`;

/** 推定の元データを読めなかったときに、使う値の説明に添える文言 */
export const PARAMS_FAILED_MESSAGE = '睡眠の記録を読み込めなかったため、標準値を使っています';
/** 操作の結果の文言（時刻を含まないもの） */
export const RESULT_MESSAGES = {
  past: 'その時刻は過ぎています',
  scheduleFailed: 'アラームを設定できませんでした',
  cancelled: 'アラームを解除しました',
  cancelFailed: 'アラームを解除できませんでした',
  openSettingsFailed: '設定を開けませんでした',
  snoozeFailed: 'スヌーズを設定できませんでした',
  loadNextFailed: 'アラームの状態を読み込めませんでした',
} as const;

/** 時刻の入力のボタンの文字「就寝予定 23:34」 */
export const formatBedtimeLabel = (at: number) => `就寝予定 ${formatTime(at)}`;

/** 時刻の入力のボタンの文字「起きたい時刻 7:00」 */
export const formatWakeLabel = (at: number) => `起きたい時刻 ${formatTime(at)}`;
