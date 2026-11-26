import { parseWakeDate } from '@/features/sleep-record/sleep-record-date.service';

describe('parseWakeDate', () => {
  // T062
  it.each([
    '2026-11-25',
    '2028-02-29',
    '2000-02-29',
    '2026-11-30',
    '2026-12-31',
    '2026-01-01',
    '2026-02-28',
  ])('%s は正しく、同じ文字列の帰属日が返る', (param) => {
    expect(parseWakeDate(param)).toBe(param);
  });

  // T063
  it.each([
    '2026-02-29',
    '2100-02-29',
    '2026-02-30',
    '2026-11-31',
    '2026-12-32',
    '2026-00-10',
    '2026-13-01',
    '2026-11-00',
  ])('%s は実在しない日付なので不正', (param) => {
    expect(parseWakeDate(param)).toBeNull();
  });

  // T064
  it.each(['abc', '2026-1-5', '2026-11-250', '2026-11-25T00:00', ''])(
    '「%s」は形式違いなので不正',
    (param) => {
      expect(parseWakeDate(param)).toBeNull();
    },
  );

  // T065
  it.each([
    ['undefined', undefined],
    ['配列', ['2026-11-25']],
  ])('%s は不正', (_label, param) => {
    expect(parseWakeDate(param)).toBeNull();
  });
});
