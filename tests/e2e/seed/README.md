# E2E（Maestro）のシードと実行の手順

設計書：`docs/features/01_sleep-record.md` の 3.3「E2E」と、テストリストの手順16（T176〜T179）。

- このコンテナでは E2E を実行できない（エミュレータがないため）。ここに書いた手順は、エミュレータのある環境で行う
- ヘルスコネクトへのシードは、テスト用の**シードアプリ**（`seeder-app/`）を Maestro から操作して入れる。本体のアプリは読み取り専用のまま
- iOS はシードアプリがなく、シミュレータのヘルスケアへの投入方法も決まっていないため、まだ実行しない（`deny-ios.yaml` だけを書いてある）

## ファイル

| パス                                                            | 内容                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sleep-seed.js`                                                 | シードの定義（「睡眠なし」「数日分」「14日分」）。実行日から逆算し、日本時間で計算する。シードアプリと Maestro の `runScript` の両方が使う |
| `seeder-app/`                                                   | シードアプリ（Android だけ。別の Expo プロジェクト。パッケージ名 `dev.suimin.e2eseeder`、権限は睡眠の書き込みだけ）                        |
| `../subflows/seed.yaml`                                         | シードアプリで環境変数 `SEED` のシードを入れる                                                                                             |
| `../subflows/reset-app.yaml`                                    | 本体のデータを消して起動し直し、睡眠の読み取りの許可を `READ_SLEEP`（`allow`／`deny`）にする                                               |
| `../subflows/restore.yaml`                                      | 後始末（シードを「数日分」に、読み取りを許可に戻す）                                                                                       |
| `../sleep-flow.yaml`・`../deny-android.yaml`・`../no-data.yaml` | Android のフロー（E1・E2・E3）                                                                                                             |
| `../chart-flow.yaml`                                            | Android のフロー（02 の E4。一覧から「週・月の推移」を開き、最新日の詳細へ）                                                               |
| `../alarm-flow.yaml`・`../alarm-ring.yaml`                      | Android のフロー（03 の E5・E6。アラームの設定と解除、鳴動の停止とスヌーズ）。準備と後始末に `subflows/clear-alarm.yaml`                   |
| `../deny-ios.yaml`                                              | iOS のフロー（E2。まだ実行しない）                                                                                                         |

「14日分」は 03 の E5（スマートアラームの推定）で使う。どの日も深い睡眠から始まりレムは1晩に1回なので、入眠は実績の 0分、サイクル長は標準値の 90分になる（`sleep-seed.js` の `expectedAlarmParams`）。

## 実行前の準備

1. エミュレータ（Android 14 以上、ヘルスコネクト入り）の言語を**日本語**、タイムゾーンを **Asia/Tokyo** にする。エミュレータとパソコンの時計をそろえる
   - シードアプリ（エミュレータの時計）と `runScript`（パソコンの時計）が、それぞれの現在時刻から日付を逆算するため
2. エミュレータに、ほかのアプリの睡眠データを入れない（シードアプリは自分が書いたデータしか消せないため。E3 が「睡眠なし」にならなくなる）
3. 本体の開発ビルドを入れる：`eas build --profile development --platform android`（リポジトリの直下で）
4. シードアプリの APK を作って入れる。開発ビルドどうしだと、どちらも Metro の同じポートにつなぎに行くので、シードアプリは JS を同梱した preview の APK にする
   ```sh
   cd tests/e2e/seed/seeder-app
   npm install
   eas build --profile preview --platform android
   # できた APK をエミュレータに入れる
   adb install <ダウンロードした APK>
   ```
5. 本体の開発サーバーを起動しておく：`npx expo start`（リポジトリの直下で）

## 実行

```sh
# （最初の実行で確かめた結果、必要なら）本体の睡眠の読み取りの許可の印を消す。maestro test の前に1度だけ流す
# adb shell pm clear-permission-flags dev.suimin.app android.permission.health.READ_SLEEP user-set user-fixed

maestro test --include-tags=android tests/e2e
```

- 0時（日本時間）をまたぐ時間帯には実行しない（シードの日付と、期待する表示の日付がずれるため）
- 各フローは、前のフローの結果に左右されない（準備は `onFlowStart`、後始末は `onFlowComplete` で、フローが失敗しても後始末は走る）。実行の順序は問わない

## 最初の実行で確かめること（結果をここに書き足す）

まだ一度も実行していないので、次の点は確かめていない。確かめたら、この節に結果と、変えた手順を書く。

- `launchApp` の `permissions` に `android.permission.health.READ_SLEEP: deny`／`allow` を指定して効くか（Maestro のドキュメントに、ヘルスコネクトの許可を指定できるかは書かれていない）。効かなければ、ヘルスコネクトの設定画面を Maestro で操作して切り替える部品フローに置き換える
- `clearState: true` で、ヘルスコネクトの許可が消えるか残るか
- 本体の開発ビルドの `AndroidManifest.xml` に `android:allowBackup="false"` が入っているか（睡眠の DB を Google ドライブへバックアップしないため）。あわせて、機種変更時の端末間の直接転送で DB が移るか（Android の版による）
- `deny-android.yaml` で「許可しない」を繰り返したとき（2回拒否すると OS の許可画面が出なくなる）、`reset-app.yaml` で拒否の回数が戻るか。戻らなければ、上の「実行」の `adb shell pm clear-permission-flags` を有効にする
- ヘルスコネクトの許可画面のボタンの文字（日本語）：`seed.yaml`・`sleep-flow.yaml` の「すべて許可」「許可」、`deny-android.yaml` の「許可しない」が合っているか
- 本体の `metro.config.js` の `resolver.blockList`（シードアプリのフォルダを本体のバンドルから外す）が効いているか（`npx expo start` でバンドルが通ること）
- シードアプリの `metro.config.js` の `watchFolders` で、フォルダの外の `../sleep-seed.js` を読めるか

- 03 のスマートアラーム（E5・E6）
  - アラームの許可の確認が出るか、出るならボタンの文字（`alarm-flow.yaml`・`subflows/set-ring-in-two-minutes.yaml` の「許可」）。`USE_EXACT_ALARM` でインストール時に許可されていれば出ない
  - 時刻ピッカー（Android のダイアログ）をキーボード入力に切り替えるボタン・時と分の入力欄・「OK」の id と文字（`subflows/set-ring-in-two-minutes.yaml`。`android:id/toggle_mode`・`input_hour`・`input_minute` は推測）。切り替えられなければ、文字盤を押して選ぶ手順に変える。どちらもできなければ止めて相談する
  - ライブラリの鳴動の画面の「停止」「スヌーズ」の文字（`alarm-ring.yaml`。アプリが渡したボタンの文字が出るはず）
  - 停止のあとアプリを開き直したとき「アラームは設定されていません」になるか（鳴ったあとの予定の `phase`。設計書 3.6）。落ちたら止めて相談する
  - スヌーズを押したとき、`launchUri` なしでアプリの最初の画面が開き、アラームの画面へ移るか（設計書 3.6）
  - `clearState: true` のあとに、ライブラリのアラーム（端末の中のネイティブの保存先）が残るか。残っても `clear-alarm.yaml` で解除する

## iOS

- シードアプリは Android だけ。シミュレータのヘルスケアへの投入方法と、HealthKit の許可を「未要求」に戻す方法が決まるまで、iOS のフローは実行しない
- それまで PR 本文に「iOS の E2E は未実行」と書く
