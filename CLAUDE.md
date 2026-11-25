
## テーマ
スマートリングの睡眠データ（ヘルスケア連携）を振り返り、睡眠サイクルに合わせて起こすスマホアプリ。要件は `docs/requirement.md`

## 技術スタック

- フレームワーク：Expo SDK 58（React Native）＋ TypeScript。iOS・Android 両対応
- 画面遷移：`expo-router`
- 状態管理：Zustand
- ヘルスケア連携（読み取りのみ）：iOS は `@kingstinct/react-native-healthkit`、Android は `react-native-health-connect`
- 端末内DB：`expo-sqlite` ＋ Drizzle ORM（マイグレーションは `drizzle-kit` で生成）
- アラーム：[要相談]（iOS はアプリを閉じていても鳴らし続ける仕組みに制約があるため、設計時に方式を決める）
- グラフ：`victory-native`
- ログ：ライブラリは使わず、`src/lib/logger.ts` の共通ログ関数を使う
- テスト：単体・中間は Jest（`jest-expo`）＋ React Native Testing Library、E2E は Maestro
- リント・フォーマット：ESLint（`eslint-config-expo`）＋ Prettier
- ビルド：EAS Build（クラウド）

### 実行環境の制約
- ヘルスケア連携を使うため、標準の Expo Go アプリでは動かない。動作確認には専用の開発ビルド（development build）が要る
- Mac がないため、iOS のビルドは EAS Build（クラウド）で行う。iPhone 実機に入れるには Apple Developer Program（年 $99）の登録が要る（登録するかは[要相談]）
- 開発コンテナで行うのは、コードの作成・単体テスト・中間テスト・静的解析まで。ヘルスケア・アラームはエミュレータ・実機でしか確かめられないため、E2E はコンテナ内では実行しない
- パッケージの追加は `npm install` ではなく `npx expo install <パッケージ名>` を使う（Expo SDK と互換性のあるバージョンが選ばれるため）

## ディレクトリ構成

- `.claude/rules/` — 開発ルール。作業前に該当ファイルを読むこと
- `docs/prompt/` — プロンプトテンプレ。関係ないので、一切読まないこと。
- `docs/features/` — 機能ごとの設計書。1機能1ファイル（例：`01_login.md`）で、要件・設計・タスクを1枚にまとめる
- `docs/pr/` — PR本文の下書き（create-pr スキルが作成し、投稿前に人間が承認する。`.gitignore` で除外しており、コミットしない）
- `src/app/` — expo-router の画面ルート（URLに対応するファイル）。features の画面を呼ぶだけの薄いファイルにする
- `src/features/` — 機能ごとのコード
- `src/lib/` — 機能横断の共通処理（ログ・DB接続など）
- `drizzle/` — drizzle-kit が生成するマイグレーション（手で編集しない）
- `tests/` — 単体テスト（`unit/`）、中間テスト（`integration/`）、E2Eテスト（`e2e/`、Maestro のフロー）

## 主要コマンド

依存パッケージの取得
- `npm install`

開発サーバーの起動（開発ビルドを入れた端末から接続する）
- `npx expo start`

テスト実行
- 単体・中間：`npm test`（単体だけなら `npm test -- tests/unit`）
- E2E：`maestro test tests/e2e`（開発ビルドを入れたエミュレータ・実機を接続した環境で実行）

ビルド
- 開発ビルド：`eas build --profile development --platform ios`（Android は `--platform android`）

リント・型チェック
- `npm run lint`
- `npx tsc --noEmit`

マイグレーションの生成（テーブル定義を変更したとき）
- `npx drizzle-kit generate`

## 外部サービス連携（要対応）

- Sentry MCP サーバーを接続・認証すること（`sentry-debug-issue` スキルの前提。未接続のあいだは同スキルを使えない）
  - 接続前に Sentry の導入（プロジェクト作成・アプリへの SDK 組み込み）が要る。SDK の組み込みは技術スタック確定後に行う
  - 接続が済んだら、この項目を削除する

## 開発ルールの適用

ファイルを読む・変更する・レビューするときは、対象パスに一致するルールを先に読む。
複数一致した場合はすべて適用する。

| 対象 | 必ず読むルール |
| --- | --- |
| 新規機能の設計時 | `docs/requirement.md`、`.claude/rules/plannedDocument.md`、`.claude/rules/architecture.md`、`.claude/rules/database.md`、`.claude/rules/testing.md`|
| 既存機能の修正時 | `docs/features/` の該当設計書（探し方は `.claude/rules/plannedDocument.md`）、`.claude/rules/plannedDocument.md` |
| データベース設計時、実装時| `.claude/rules/database.md` |
| `src/**/*` | `.claude/rules/architecture.md` , `.claude/rules/logging.md`|
| `tests/**/*`, テストの追加・変更、テストケース設計時、レビュー実行時 | `.claude/rules/testing.md` |
| ファイル・フォルダの作成・名前変更時、ブランチ作成時 | `.claude/rules/naming.md` |

- ルールと仕様書が矛盾した場合は、推測で進めず作業を止めて矛盾を報告する

## 開発の流れ

AI相互レビュー（`ai-review` スキル）は3段階それぞれで実施し、P0・P1がゼロになるまで次へ進まない。
各段階の合格ごとに、レビュー記録の追記を含めてコミットする（`ai-review` スキル手順6）。

0. 設計書の番号・ファイル名を決め、main から機能ブランチを作る（番号の決め方は `.claude/rules/plannedDocument.md`、命名は `.claude/rules/naming.md` の「ブランチ名」）
1. 設計書を作る・修正する（`.claude/rules/plannedDocument.md`）
2. `ai-review` plan — 設計書をレビュー → 合格したらコミット
3. `tdd` 手順1 — 設計書の「新規テストケース」から、設計書の「テストリスト」節を作る
4. `ai-review` test — テストリストをレビュー → 合格したらコミット
5. `tdd` 手順2〜5 — 1件ずつ Red → Green → Refactor
6. `ai-review` impl — 実装・テストの差分をレビュー → 合格したらコミット
7. `create-pr` — PR本文を下書きし、承認後に投稿