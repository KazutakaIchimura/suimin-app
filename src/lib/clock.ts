// 現在時刻を返す。業務ロジックはこれを直接呼ばず、受け口層から引数で受け取る
export function now(): Date {
  return new Date();
}
