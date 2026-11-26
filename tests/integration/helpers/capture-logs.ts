// 共通ログ関数が console に出した1行の JSON を、出力の境界（console）で受け取る（設計書「テストリスト」共通の前提）

export type CapturedLog = {
  level: 'info' | 'warn' | 'error';
  /** console に渡った文字列そのまま */
  line: string;
  /** `line` を JSON.parse したもの */
  entry: Record<string, unknown>;
};

/**
 * console.info／warn／error を spyOn し、出たログを返す配列に積む。`beforeEach` で呼び、`afterEach` で `jest.restoreAllMocks()` する
 */
export function captureLogs() {
  const logs: CapturedLog[] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      logs.push({ level, line, entry: JSON.parse(line) });
    });
  }
  return {
    logs,
    named: (name: string) => logs.filter((l) => l.entry.name === name),
  };
}
