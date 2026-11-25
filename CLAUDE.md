
## テーマ
[要相談]

## 技術スタック

[要相談]

- 技術スタックを確定してから、その言語・フレームワークの標準構造に合わせて、本ファイルの「ディレクトリ構成」、`.claude/rules/architecture.md`、`.claude/rules/testing.md`、`.claude/rules/logging.md` を修正する
- 技術スタックが未確定のあいだは、`src/` `tests/` 配下のフォルダ・ファイルを作成しない

## ディレクトリ構成

- `.claude/rules/` — 開発ルール。作業前に該当ファイルを読むこと
- `docs/prompt/` — プロンプトテンプレ。関係ないので、一切読まないこと。
- `docs/features/` — 機能ごとの設計書。1機能1ファイル（例：`01_login.md`）で、要件・設計・タスクを1枚にまとめる
- `docs/pr/` — PR本文の下書き（create-pr スキルが作成し、投稿前に人間が承認する。`.gitignore` で除外しており、コミットしない）
- `src/features/` — 機能ごとのコード
- `src/lib/` — 機能横断の共通処理 (ログなど)
- `tests/` — 単体テスト (unit/)、中間テスト (integration/)、E2Eテスト (e2e/)

## 主要コマンド

テスト実行
- [要相談]

ビルド
- [要相談]

リント
- [要相談]

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