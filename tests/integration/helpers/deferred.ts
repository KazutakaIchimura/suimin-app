// テストで Promise を保留にしておき、好きなときに解く（同期中・取得中の状態を作る）

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// この補助が読み込まれた時点の本物の setImmediate。
// テストの中で react-native を読み込み直すと、グローバルの setImmediate が偽装タイマーで動く実装に置き換わるため
const realSetImmediate = setImmediate;

/** 保留中でない Promise の続きを流しきる（本物の setImmediate を数回待つ） */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}
