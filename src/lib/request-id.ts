// 1回の操作の相関ID（ログの requestId）を作る。ランダムな文字列で、意味は持たせない
export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
