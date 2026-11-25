---
paths:
  - "src/**"
---

# 構造化・要約・秘密値禁止

- ロギングライブラリ：使わない（`console` を包む自前の共通ログ関数を使う）
- 共通ログ関数の置き場所：`src/lib/logger.ts`（`logger.info` / `logger.warn` / `logger.error`）
- 直接使用を禁止する関数：`console.log` / `console.info` / `console.warn` / `console.error` / `console.debug`（ESLint の `no-console` で検出し、`src/lib/logger.ts` だけを例外にする）

## ルール
1. 業務コードで標準出力・標準エラー出力へ直接書き込まない（上記の `console` 系を呼ばない）。ログは `src/lib/logger.ts` の共通ログ関数を経由する
   （直書きすると相関IDの付与とマスク処理を迂回してしまうため）
2. ラップするのは外部IO・副作用・失敗しうる処理だけ（DB、ヘルスケアの読み取り、アラームの登録）。純粋関数はラップしない（ノイズになるだけ）
3. エラーは記録したあと必ず呼び出し元へ伝播させる（`throw` し直す）。握りつぶして正常形を返さない
4. 引数は要約だけを記録する（ID・件数・期間など）。オブジェクトを丸ごと渡さない
5. info を出すのは外部連携の成功・1秒を超える処理・重要イベント（アラームの登録・解除など）だけ。それ以外の成功は黙る（ログのノイズを増やさない）

## 標準キー
| キー | 内容 |
| --- | --- |
| name | domain.function 形式（例：sleepRecord.fetchFromHealth） |
| requestId | 1回の操作単位の相関ID |
| err | エラー種別・メッセージ・スタックトレースに整形 |
| ms | 所要時間 |

（ユーザー登録がないアプリのため userId は持たない）

## 秘密値・健康情報をログに渡さない
APIキー・トークン、および睡眠データそのもの（就寝・起床時刻、睡眠ステージ、心拍など）は健康情報なので、いかなるログにも書かない。件数・期間などの要約だけを記録する

```ts
// ✕ console へ直接、睡眠データそのものを書き出す
console.log('fetched sleep data', sleepSessions); // ← 健康情報がログに残る

// ☑ 共通ログ関数経由で、要約だけを記録する
logger.info('sleepRecord.fetchFromHealth', {
  count: sleepSessions.length,
  days: rangeDays,
  ms: Date.now() - startedAt,
});
```

```ts
// ☑ エラーは記録してから伝播させる
try {
  await healthRepository.fetchSleep(range);
} catch (err) {
  logger.error('sleepRecord.fetchFromHealth', { err });
  throw err;
}
```
