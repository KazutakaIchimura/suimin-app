import {
  computeSyncRange,
  healthReadStartAt,
  isAdopted,
} from '@/features/sleep-record/sleep-record-sync-range.service';

const NOW = new Date('2026-11-25T12:00:00+09:00').getTime();
const D = 24 * 60 * 60 * 1000;

describe('computeSyncRange', () => {
  // T087
  it('同期記録がなければ now − 90日 〜 now', () => {
    expect(computeSyncRange(NOW, null)).toEqual({ startAt: NOW - 90 * D, endAt: NOW });
  });

  // T088〜T093
  it.each([
    ['T088 前回 now − 3D', NOW - 3 * D, NOW - 7 * D],
    ['T089 前回 now − 7D', NOW - 7 * D, NOW - 7 * D],
    ['T089 前回 now − 7D − 1ms', NOW - 7 * D - 1, NOW - 7 * D - 1],
    ['T090 前回 now − 20D', NOW - 20 * D, NOW - 20 * D],
    ['T091 前回 now − 90D', NOW - 90 * D, NOW - 90 * D],
    ['T091 前回 now − 90D + 1ms', NOW - 90 * D + 1, NOW - 90 * D + 1],
    ['T091 前回 now − 90D − 1ms', NOW - 90 * D - 1, NOW - 90 * D],
    ['T092 前回 now − 120D', NOW - 120 * D, NOW - 90 * D],
    ['T093 前回 now + 2D（未来）', NOW + 2 * D, NOW - 7 * D],
  ])('%s なら開始は期待どおりで、終了は now', (_label, lastSyncedAt, expectedStart) => {
    expect(computeSyncRange(NOW, lastSyncedAt)).toEqual({ startAt: expectedStart, endAt: NOW });
  });
});

describe('healthReadStartAt', () => {
  // T094
  it('前回 now − 20D なら、読み取り開始は範囲の開始の24時間前の now − 21D', () => {
    const range = computeSyncRange(NOW, NOW - 20 * D);

    expect(healthReadStartAt(range.startAt)).toBe(NOW - 21 * D);
  });
});

describe('isAdopted', () => {
  const R = NOW - 7 * D;

  // T095
  it.each([
    ['範囲の開始ちょうど', true, R],
    ['範囲の開始の1ミリ秒前', false, R - 1],
  ])('起床が%sなら採用は %s', (_label, expected, endAt) => {
    expect(isAdopted({ endAt }, R)).toBe(expected);
  });
});
