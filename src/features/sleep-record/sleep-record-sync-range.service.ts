// 取り込み範囲の計算と、起床時刻による採用の判定（設計書 3.1「同期（取り込み）のルール」）。純粋関数

const DAY_MS = 24 * 60 * 60 * 1000;

/** 初回に取り込む日数（取り込み範囲の上限） */
const MAX_RANGE_DAYS = 90;

/** 2回目以降に少なくともさかのぼる日数（ヘルスケア側の修正を取り込み直すため） */
const MIN_RANGE_DAYS = 7;

/** ヘルスケアの読み取りで、範囲の開始よりさかのぼる時間 */
const READ_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * 取り込み範囲（終了は now）。初回は now − 90日 から。
 * 2回目以降は min(前回, now − 7日) から（ただし now − 90日 より前にはしない）。
 * `lastSyncedAt` は前回成功した同期の開始時刻（同期記録がなければ `null`）
 */
export function computeSyncRange(
  now: number,
  lastSyncedAt: number | null,
): { startAt: number; endAt: number } {
  const earliest = now - MAX_RANGE_DAYS * DAY_MS;
  if (lastSyncedAt === null) return { startAt: earliest, endAt: now };
  // 前回の同期開始時刻が未来（時計を戻した）でも、min により now − 7日 からになる
  const startAt = Math.max(Math.min(lastSyncedAt, now - MIN_RANGE_DAYS * DAY_MS), earliest);
  return { startAt, endAt: now };
}

/** ヘルスケアの読み取り開始（範囲の開始をまたぐ睡眠を途中で切らないよう、24時間さかのぼる） */
export function healthReadStartAt(rangeStartAt: number): number {
  return rangeStartAt - READ_LOOKBACK_MS;
}

/** 起床時刻が範囲の開始以降（開始ちょうどを含む）の睡眠だけを採用する */
export function isAdopted(session: { endAt: number }, rangeStartAt: number): boolean {
  return session.endAt >= rangeStartAt;
}
