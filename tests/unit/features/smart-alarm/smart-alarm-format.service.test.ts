import {
  formatCandidate,
  formatEntry,
  formatNextAlarm,
  formatParams,
} from '@/features/smart-alarm/smart-alarm-format.service';
import type { CycleParams } from '@/features/smart-alarm/smart-alarm.types';

/** JST の日時（`2026-11-28T23:59` の形）を UNIX ミリ秒にする */
const jst = (local: string) => new Date(`${local}:00+09:00`).getTime();

describe('formatCandidate', () => {
  // T044
  it('今から寝るは「後」を付け、起床時刻を指定は付けない', () => {
    expect(
      formatCandidate(
        { kind: 'cycle', cycles: 4, at: jst('2026-11-28T05:14'), minutesFromBase: 374 },
        'now',
      ),
    ).toBe('5:14 4サイクル（6時間14分後）');
    expect(
      formatCandidate(
        { kind: 'cycle', cycles: 4, at: jst('2026-11-28T04:44'), minutesFromBase: 374 },
        'wake',
      ),
    ).toBe('4:44 4サイクル（6時間14分）');
    expect(
      formatCandidate(
        { kind: 'desired', at: jst('2026-11-28T07:00'), minutesFromBase: 510 },
        'wake',
      ),
    ).toBe('7:00 希望の時刻（8時間30分）');
  });

  // T053
  it.each([
    [
      { kind: 'cycle', cycles: 1, at: jst('2026-11-28T00:14'), minutesFromBase: 44 },
      '0:14 1サイクル（44分）',
    ],
    [
      { kind: 'desired', at: jst('2026-11-27T23:15'), minutesFromBase: 45 },
      '23:15 希望の時刻（45分）',
    ],
  ] as const)('1時間未満は分だけ：%s', (candidate, expected) => {
    expect(formatCandidate(candidate, 'wake')).toBe(expected);
  });
});

describe('formatParams', () => {
  const standard = (onsetMissing: number, cycleMissing: number): CycleParams => ({
    onsetMinutes: 14,
    onsetSource: { kind: 'standard', missingDays: onsetMissing },
    cycleMinutes: 90,
    cycleSource: { kind: 'standard', missingDays: cycleMissing },
  });

  // T045
  it.each([
    [
      '両方標準値',
      standard(9, 14),
      '入眠 14分（標準値。あと 9日分の記録で切り替わります）・1サイクル 90分（標準値。あと 14日分の記録で切り替わります）',
    ],
    [
      '入眠だけ実績',
      { ...standard(0, 14), onsetMinutes: 8, onsetSource: { kind: 'estimated' } },
      '入眠 8分（あなたの記録）・1サイクル 90分（標準値。あと 14日分の記録で切り替わります）',
    ],
    [
      '両方実績',
      {
        onsetMinutes: 8,
        onsetSource: { kind: 'estimated' },
        cycleMinutes: 95,
        cycleSource: { kind: 'estimated' },
      },
      '入眠 8分（あなたの記録）・1サイクル 95分（あなたの記録）',
    ],
    [
      'サイクルだけ実績',
      { ...standard(1, 0), cycleMinutes: 95, cycleSource: { kind: 'estimated' } },
      '入眠 14分（標準値。あと 1日分の記録で切り替わります）・1サイクル 95分（あなたの記録）',
    ],
  ] as [string, CycleParams, string][])('%s', (_label, params, expected) => {
    expect(formatParams(params)).toBe(expected);
  });
});

describe('formatNextAlarm・formatEntry', () => {
  // T046
  it.each([
    [{ at: jst('2026-11-28T23:59'), snoozed: false }, '次のアラーム 23:59', 'アラーム 23:59'],
    [
      { at: jst('2026-11-29T00:00'), snoozed: false },
      '次のアラーム 11月29日（日） 0:00',
      'アラーム 11月29日（日） 0:00',
    ],
    [
      { at: jst('2026-11-29T07:09'), snoozed: true },
      '次のアラーム 11月29日（日） 7:09（スヌーズ）',
      'アラーム 11月29日（日） 7:09（スヌーズ）',
    ],
    [null, 'アラームは設定されていません', 'アラーム 未設定'],
  ])('今 11/28 23:59 で %p', (next, screen, entry) => {
    const now = new Date(jst('2026-11-28T23:59'));
    expect(formatNextAlarm(next, now)).toBe(screen);
    expect(formatEntry({ kind: 'loaded', next }, now)).toBe(entry);
  });

  // T047
  it('今 11/29 0:00 で 0:00 のアラームは今日なので日付なし', () => {
    const now = new Date(jst('2026-11-29T00:00'));
    const next = { at: jst('2026-11-29T00:00'), snoozed: false };
    expect(formatNextAlarm(next, now)).toBe('次のアラーム 0:00');
    expect(formatEntry({ kind: 'loaded', next }, now)).toBe('アラーム 0:00');
  });

  // T009
  it('今日のスヌーズは日付なしで「（スヌーズ）」を付ける', () => {
    const now = new Date(jst('2026-11-29T07:00'));
    const next = { at: jst('2026-11-29T07:09'), snoozed: true };
    expect(formatNextAlarm(next, now)).toBe('次のアラーム 7:09（スヌーズ）');
    expect(formatEntry({ kind: 'loaded', next }, now)).toBe('アラーム 7:09（スヌーズ）');
  });

  // T048
  it.each([[{ kind: 'loading' }], [{ kind: 'failed' }]] as const)(
    '%p の入口は「アラーム」だけ',
    (state) => {
      expect(formatEntry(state, new Date(jst('2026-11-28T23:59')))).toBe('アラーム');
    },
  );
});
