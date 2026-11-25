# 睡眠記録（ヘルスケア連携）

## 1. 概要
- iOS は Apple ヘルスケア、Android はヘルスコネクトから睡眠データ（就寝・起床時刻、睡眠ステージ）を読み取り、端末内DB（SQLite）に保存する
- 保存した睡眠を「日付の一覧」と「1日の詳細」の2画面で表示する
  - 一覧：日ごとの合計睡眠時間・主睡眠の就寝／起床時刻・昼寝の件数
  - 詳細：主睡眠の就寝／起床時刻・睡眠時間・ステージ内訳（分と割合）、昼寝の一覧
- ヘルスケアの読み取り許可がない・使えない場合は、状態に応じた案内を出す
- あわせて、機能横断の基盤（共通ログ `src/lib/logger.ts`、DB接続、マイグレーションの適用、現在時刻の取得）を作る

## 2. 背景
- 要件「主要な機能 1. 睡眠記録（ヘルスケア連携）」のうち、取り込み・1日ごとの表示・許可の案内に対応する。週・月のグラフは別機能（02）に分ける
- スマートアラーム（要件の機能2）は、本人の実績から入眠時間・サイクル長を推定する。その元データとなる過去の主睡眠を、この機能が DB に貯めておく（他機能に返す関数は、スマートアラームの設計で追加する）
- ヘルスコネクトは標準の権限では「許可した日の30日前」より古いデータを読めない。DB に貯めておくことで、連携後の履歴を失わずに使い続けられる
- 非機能要件：データは端末内にのみ保存し外部へ送らない。ヘルスケアへは読み取りのみ

## 3. 詳細設計

### 3.1 用語と業務ルール

| 用語 | 定義 |
| --- | --- |
| セグメント | ヘルスケアから読んだ「ある時間帯のステージ」1件。iOS は睡眠サンプル1件、Android は SleepSession のステージ1件 |
| 睡眠（セッション） | 一続きの睡眠1回分。就寝時刻＝含まれるセグメントの開始の最小値、起床時刻＝含まれるセグメントの終了の最大値。Android でステージの範囲が SleepSession の `startTime`/`endTime` とずれていても、セグメント（ステージ）の範囲を使う |
| ステージ区間 | 睡眠内のセグメントを、重なりを解消して並べ直したもの（後述の「同じ睡眠内の重なり」）。区間どうしは重ならない |
| 睡眠時間 | 睡眠内の「覚醒」以外のステージ区間の合計を、分に**切り捨て**たもの |
| 帰属日 | 起床時刻の、端末のタイムゾーンでの日付（`YYYY-MM-DD`） |
| 主睡眠 | 帰属日が同じ睡眠のうち、睡眠時間が最も長いもの。同じ長さなら就寝が早いほう |
| 昼寝 | 帰属日が同じ睡眠のうち、主睡眠以外のもの |
| 合計睡眠時間 | その日の主睡眠と昼寝の睡眠時間の合計 |

#### ステージの共通化
アプリ内のステージは `awake`（覚醒）・`light`（浅い）・`deep`（深い）・`rem`（REM）・`unspecified`（ステージ不明の睡眠）の5種にそろえる。

| アプリ内 | iOS（`CategoryValueSleepAnalysis`） | Android（`SleepStageType`） |
| --- | --- | --- |
| `awake` | `awake` | `AWAKE`、`OUT_OF_BED` |
| `light` | `asleepCore` | `LIGHT` |
| `deep` | `asleepDeep` | `DEEP` |
| `rem` | `asleepREM` | `REM` |
| `unspecified` | `asleepUnspecified` | `SLEEPING`、`UNKNOWN` |
| （読み捨て） | `inBed` | — |

- Android でステージを持たない SleepSession は、セッション全体を1件の `unspecified` セグメントとして扱う
- Android でステージはあるが、すべてが長さ0以下で捨てられた SleepSession も、ステージを持たないものとして同じに扱う
- ID・記録元が欠けたデータ（Android の `metadata.id`・`metadata.dataOrigin` は型で省略可能。iOS の UUID・bundle identifier も空文字がありうる）は捨てずに、代わりの値を付ける（1件のために同期が毎回制約違反で失敗し続けないようにする）
  - 記録元が `undefined`・空文字 → `"unknown"`
  - 睡眠・サンプルの ID が `undefined`・空文字 → `"<記録元>:<開始のUNIXミリ秒>:<終了のUNIXミリ秒>"`（同じ記録なら毎回同じ値になる）
- 表にない値（ライブラリ・OS の新しい版で増えた値など）は `unspecified` として扱う（睡眠を落とさず、DB の値域制約にも違反しないようにする）。ヘルスケアのリポジトリは変換したセグメントと一緒に未知の値の件数を返し、同期サービスが1件以上なら `sleepRecord.fetchFromHealth` の warn ログ（`requestId`・件数）を出す（値そのものは出さない）
- 「ステージあり」＝ `light`・`deep`・`rem` のいずれかを1件以上含む睡眠

#### セグメントから睡眠への組み立て（純粋関数）
0. 長さ0以下（`end <= start`）のセグメントは最初に捨てる（DB の `end_at > start_at` 制約に違反する行を作らないため）
1. Android：同じ SleepSession のセグメントを1つの睡眠にまとめる
2. iOS：同じ記録元（`sourceRevision.source.bundleIdentifier`）のセグメントを開始時刻順に並べ、それまでにまとめたセグメントの最も遅い終了から次の開始までの空きが **30分以下**（ちょうど30分を含む）なら同じ睡眠にまとめる。重なっている（空きが負の）場合も同じ睡眠にする
3. 同じ睡眠内の重なり：セグメントが時間的に重なる部分は、優先度の高いステージ1つだけを採用してステージ区間にする（睡眠時間とステージ内訳を二重に数えないため）。優先度は `deep` ＞ `rem` ＞ `light` ＞ `awake` ＞ `unspecified`（具体的なステージを「不明」より優先する）。重なりの解消で長さ0になった区間は捨て、隣り合う同じステージの区間は1つにつなぐ
4. 睡眠時間（切り捨て後）が **0分** の睡眠は捨てる（覚醒だけ、または覚醒以外が1分未満）。DB の `asleep_minutes > 0` 制約に違反する行を作らないため
5. 睡眠どうしの重なりの排除：時間が1ミリ秒でも重なる睡眠どうしは1つだけ残す（記録元が同じか違うかは問わない。Android で同じアプリが重なる SleepSession を書いた場合も含む）
   - 全部の睡眠を次の順に並べ、先頭から順に「すでに残した睡眠と重ならなければ残す」を繰り返す（3つ以上が連なって重なっても結果が1通りに決まるようにするため）
     1. ステージありを先
     2. 睡眠時間が長いほうを先
     3. 記録元IDの辞書順で先
     4. 就寝が早いほうを先
     5. 睡眠 `id` の辞書順で先
   - 終了と開始がちょうど同じ時刻なら、重なりとみなさない
6. 帰属日を付ける

#### 同期（取り込み）のルール
- 契機：アプリ起動時、アプリが前面に戻ったとき、一覧画面を下に引いたとき（手動更新）、同期失敗時の「再試行」。バックグラウンド同期はしない
- 同期中に次の契機が来たら（契機の種類を問わない）、新しい同期は始めずに実行中のものの完了を待って終わる。同期が終われば（成功・失敗とも）、次の契機で新しく同期できる
- 同期の失敗表示は、次の同期が成功したら消す
- 連携状態の取得のあとは、どの契機でも（起動・前面復帰・下に引く・`checkFailed` の再試行・許可の要求のあと）、`ready` なら続けて同期する。`ready` 以外で下に引いたときは連携状態の取得だけをして、引っ張り中の表示を止める。`ready` で下に引いたときは、同期が成功・失敗のどちらで終わっても引っ張り中の表示を止める
- 「前面に戻った」は、`AppState` が `background` から `active` に変わったときだけを指す（`inactive` から `active` は含めない。iOS では許可のシートを閉じたときにも `inactive`→`active` が起き、許可の要求中に同期が割り込むため）
- 同期は連携状態が `ready` のときだけ行う。それ以外の状態では、どの契機でも同期しない
- 取り込み範囲（`now` は同期開始時刻）
  - 初回（同期記録なし）：`now − 90日` 〜 `now`
  - 2回目以降：開始 ＝ `min(前回の同期開始時刻, now − 7日)`。ただし `now − 90日` より前にはしない（`max` を取る）
  - 前回の同期開始時刻が未来（端末の時計を戻した）の場合も、上の式のとおり `now − 7日` からになる
- ヘルスケアからは「取り込み範囲の開始 − 24時間」〜 `now` の期間と**重なる**セグメントを読む（iOS は `filter.date` の `startDate`/`endDate`、Android は `timeRangeFilter` の `between` を使う。どちらも期間と重なる記録を返す前提で、I3 で渡す引数を確かめ、実機の挙動は E2E で確かめる）。24時間さかのぼるのは、範囲の開始をまたぐ睡眠を途中で切らずに組み立てるため
- 組み立てた睡眠のうち、起床時刻が取り込み範囲の開始**以降**（開始ちょうどを含む）のものだけを採用する
- 「セグメントの件数」は、有効なセグメント（ステージへの変換で `inBed` を読み捨て、長さ0以下を捨てたあと）で数える。`inBed` だけ・長さ0のものだけが返ったときは0件として扱う
- セグメントが1件以上あれば、組み立て後に採用する睡眠が0件（24時間さかのぼった部分にしかない・覚醒だけ など）でも入れ替えを行う。範囲内の DB の睡眠は消え、同期記録は更新される（ヘルスケアから正しく読めており、範囲内に睡眠がないことが確かなため）
- ヘルスケアから読んだセグメントが0件なら、DB の入れ替えも同期記録の更新もしない（成功扱いで終える）。iOS は許可を取り消されても例外にならず0件を返すため、貯めた履歴を消さないようにする。代わりに、ヘルスケア側で取り込み範囲の睡眠を全部消した場合は反映されない（スコープ外に記載）
- 連携状態の取得・同期の実行と重複防止は store の操作が持ち、連携状態・許可・設定・同期のサービスを呼ぶのは store の操作だけにする（一覧・詳細の読み取りの窓口は、それぞれのフックが呼ぶ）。1回の操作（`sync()` など）の中では同じ `requestId` を使う。操作の中身は次のとおり
  - `refreshAccess()`：連携状態を取得して store に入れる。取得中にもう一度呼ばれたら、実行中のものの完了を待って終わる（同時に2回取得しない）
  - `sync()`：`refreshAccess()` を呼び、`ready` なら同期サービスを呼ぶ。同期中にもう一度呼ばれたら、実行中のものの完了を待って終わる。起動・前面復帰・下に引く・同期の再試行・`checkFailed` の再試行は、すべてこれを呼ぶ
  - `requestAccess()`：許可を要求し、成功したら新しい `sync()` を始める。そのとき実行中の `sync()` があれば、合流せずに完了を待ってから、改めて連携状態の取得から始める（許可の前に読んだ古い連携状態で終わらないようにするため）。連携状態の取得はこの新しい `sync()` の中の1回だけ
  - `openSettings()` は Android だけで使う。iOS では案内にボタンを出さない。iOS で呼ばれたら、ヘルスケアのリポジトリが例外を投げ、サービスが `sleepRecord.openSettings` の error ログを出して投げ直し、store が「設定を開けませんでした」の状態にする（他の失敗と同じ経路）
  - `openSettings()`：設定を開く
- フック `use-sleep-record-sync` は契機（起動・前面復帰）を受けて `sync()` を呼ぶだけ、画面は下に引く・再試行・ボタンで store の操作を呼ぶだけにする
- アプリ全体で1つの `SleepRecordSyncProvider`（`src/app/_layout.tsx` が描画する）が `use-sleep-record-sync` を動かす。起動時に連携状態を取得して store に入れ、`ready` なら同期する。前面復帰時も同じ。こうすると、どの画面から起動しても（詳細の URL を直接開いても）起動時の同期が1回走る
- 同期が成功すると store のデータの版番号が上がり、一覧・詳細のフックはそれを見て DB から読み直す（詳細を開いている間に同期が終わっても、詳細が新しくなる）
- DB の入れ替え（1トランザクション）
  1. 次のどれかに当たる DB の睡眠を削除する（ステージは CASCADE で消える）
     - 起床時刻が取り込み範囲の開始以降（開始ちょうどを含む）
     - 採用する睡眠と同じ `id`（ヘルスケア側の修正で、起床時刻が範囲の前から範囲内へ動いた睡眠の主キー衝突を防ぐ）
     - 採用する睡眠と時間が重なる（iOS でまとめ方が変わり `id` が変わった同じ睡眠を、二重に残さないため）。このときは組み立ての順位づけ（ステージあり優先など）は使わず、常に今回ヘルスケアから読んだ睡眠を残す（ヘルスケアの最新の状態を正とするため）。重なりの判定は組み立てと同じく、終了と開始がちょうど同じ時刻なら重ならないとみなす（`DB.start_at < 採用.end_at AND DB.end_at > 採用.start_at`）
  2. 採用した睡眠とステージ区間を挿入する
  3. 同期記録の `last_synced_at` を今回の同期開始時刻にする
- Android のページ送りの途中で読み取りが失敗したら、途中まで読んだ分も使わず、同期全体を失敗にする（一部だけで入れ替えると、範囲内の睡眠が消えるため）
- ヘルスケアの読み取りや DB の入れ替えに失敗したら、DB と同期記録は変更しない（それまでのデータを表示し続け、次回も同じ範囲から取り込み直す）
- Android は追加の権限（過去データの読み取り）を求めない。30日より古いデータが読めないぶんは、そのまま受け入れる
- 90日・7日・24時間・30分の値は、利用者が変える業務設定ではなく取り込み・組み立ての固定値のため、設定テーブルにせず、使うサービスのファイル内に名前付き定数として置く

#### 連携状態と案内

| 状態 | 判定 | 画面の案内 |
| --- | --- | --- |
| `unavailable` | iOS：`isHealthDataAvailable()` が false。Android：`getSdkStatus()` が `SDK_UNAVAILABLE`（表にない値は、リポジトリが例外を投げて `checkFailed` にする） | 「この端末ではヘルスケア連携を使えません」 |
| `updateRequired` | Android：`getSdkStatus()` が `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED` | 「ヘルスコネクトを更新してください」 |
| `notRequested` | iOS：`getRequestStatusForAuthorization` が `shouldRequest` | 「ヘルスケアと連携する」ボタン |
| `notGranted` | Android：`initialize()` が true を返したあとの `getGrantedPermissions()` に睡眠の読み取りがない | 「ヘルスコネクトと連携する」ボタン＋「許可しなかった場合は、ヘルスコネクトの設定から許可してください」と設定を開くボタン |
| `ready` | iOS：上記以外（拒否されたかは判別できない）。Android：睡眠の読み取りが許可済み | 同期して一覧を表示 |
| `checkFailed` | 連携状態の取得が失敗した（判定に使う関数 `isHealthDataAvailable`・`getRequestStatusForAuthorization`・`getSdkStatus`・`initialize`・`getGrantedPermissions` が例外を投げた、または Android の `initialize()` が false を返した）。この状態はサービスではなく受け口層の store が、届いたエラーから作る | 「ヘルスケアの状態を確認できませんでした」＋「再試行」ボタン（連携状態の取得からやり直す） |

- Android の `notGranted` は、「まだ一度も許可を求めていない」と「拒否した」を区別できない（`getGrantedPermissions` では判別できない）。どちらも同じ案内にし、2回拒否して OS の許可画面が出なくなった人も設定ボタンから許可できるようにする
- 「連携する」ボタンで許可の要求（iOS：`requestAuthorization`、Android：`requestPermission`）が例外を投げたときは、「連携の要求に失敗しました」を表示し、ボタンは押せるまま残す（連携状態は取得し直さない）。要求が成功したあとは連携状態を取得し直す
- 「連携の要求に失敗しました」「設定を開けませんでした」の表示は、次にそのボタンを押したときに消す
- 許可の要求中は「連携する」ボタンを押せなくする（要求を重ねて出さない）
- 許可の要求の戻り値（iOS の `requestAuthorization` の真偽値、Android の `requestPermission` が返す許可の一覧）は判定に使わない。例外を投げなければ要求は成功とみなし、そのあと連携状態を取得し直した結果で判断する（iOS は false でも拒否とは限らず、判定は状態の取得に一本化するため）
- 連携状態の確認（iOS の `getRequestStatusForAuthorization`）に渡す種類は、許可の要求と同じ（睡眠の読み取りだけ）にする。違うと判定がずれるため
- 許可の要求で求めるのは睡眠の読み取りだけにする（iOS：`toRead` は `HKCategoryTypeIdentifierSleepAnalysis` だけで `toShare` は空、Android：`{ accessType: 'read', recordType: 'SleepSession' }` だけ）。要件の「ヘルスケアへは読み取りのみ」を守るため
- 「設定を開く」（Android：`openHealthConnectSettings`）が例外を投げたときは、「ヘルスコネクトの設定を開けませんでした。設定アプリからヘルスコネクトを開いてください」を表示する
- 読み込み中の表示
  - 連携状態がまだ一度も取れていないとき、または一覧・詳細を**初めて** DB から読んでいる間だけ、「読み込み中」の表示だけを出す（案内・空の表示は出さない）。2回目以降の連携状態の取得・読み直し（前面復帰・下に引く・同期後の版番号の更新）の間は、それまでの表示を出したままにする
  - `ready` で DB に睡眠がなく同期中なら、「睡眠データを取り込んでいます」を出し、下の「睡眠データがありません」の案内は出さない（初回同期の途中に誤った案内を出さないため）
  - DB に睡眠があって同期中なら、一覧を表示したまま上部に同期中の表示を出す
  - 同期中は、前回の同期の失敗表示を出さない（再試行を押したら、結果が出るまでは同期中の表示だけにする）。失敗表示は同期が失敗で終わったときに出し、次の同期が成功したら消す
- `ready` で DB に睡眠が1件もなく、同期中でないとき
  - iOS：「睡眠データがありません。許可していない場合は、設定 → ヘルスケア → データアクセスとデバイス → suimin-app で睡眠を許可してください。SOXAI アプリのヘルスケア連携も確認してください」
  - Android：「睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください」
- 同期に失敗したとき：画面上部に「睡眠データの取り込みに失敗しました」と「再試行」ボタンを出し、DB にあるデータは表示し続ける。DB が空なら、失敗の表示と「睡眠データがありません」の案内を両方出す
- 連携状態が `ready` 以外でも、DB に睡眠があれば一覧・詳細は表示する（案内は一覧の上に出す）。Android で後から許可を取り消した場合なども、貯めた履歴を見られるようにする
- DB からの読み取り（一覧・詳細）に失敗したとき：「睡眠データを読み込めませんでした」と「再試行」ボタン（読み取りをやり直す）を出す
- OS の判定（`Platform.OS`）は受け口層（フック・store）だけが読み、サービス層の関数へ引数（`os: 'ios' | 'android'`）で渡す。サービス層はそれをヘルスケアのリポジトリへ渡し、リポジトリはその値で iOS／Android の実装を切り替える（architecture.md の「サービス層・リポジトリ層は `react-native` を import しない」と「リポジトリ層の中で OS により切り替える」を両方満たすため）
- 例外の扱い：リポジトリは失敗をそのまま投げる（Android の `initialize()` が false のときも、リポジトリが例外を投げる）。サービスはすべての失敗（連携状態の取得・許可の要求・設定を開く・同期・読み取り）について、ログを出して投げ直す。連携状態・許可の要求・設定を開く・同期のエラーは store が、一覧・詳細の読み取りのエラーはそれぞれのフックが受け取り、画面の状態（`checkFailed`・失敗の表示）にする（logging.md のルール3「記録したあと必ず投げ直す」に従う）

### 3.2 テーブル定義（`src/features/sleep-record/sleep-record.schema.ts`）

`sleep_sessions`（睡眠1回分）

| 列 | 型 | 制約 | 内容 |
| --- | --- | --- | --- |
| `id` | text | PK | iOS：先頭セグメントのサンプル UUID。Android：SleepSession の `metadata.id` |
| `source_id` | text | NOT NULL | 記録元ID（iOS：bundle identifier、Android：`metadata.dataOrigin`）。重なり排除の順位づけに使う |
| `start_at` | integer | NOT NULL | 就寝時刻（UNIX ミリ秒） |
| `end_at` | integer | NOT NULL、CHECK `end_at > start_at` | 起床時刻（UNIX ミリ秒） |
| `wake_date` | text | NOT NULL、CHECK `wake_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'` | 帰属日 `YYYY-MM-DD` |
| `asleep_minutes` | integer | NOT NULL、CHECK `asleep_minutes > 0` | 睡眠時間（分、切り捨て） |
| `has_stages` | integer | NOT NULL、CHECK `has_stages IN (0, 1)` | ステージありか |

- インデックス：`wake_date`、`end_at`（一覧の取得と、同期での範囲削除に使う）

`sleep_stages`（睡眠内のステージ区間）

| 列 | 型 | 制約 | 内容 |
| --- | --- | --- | --- |
| `id` | integer | PK（自動採番） | |
| `session_id` | text | NOT NULL、FK → `sleep_sessions.id`（ON DELETE CASCADE） | |
| `stage` | text | NOT NULL、CHECK `stage IN ('awake','light','deep','rem','unspecified')` | |
| `start_at` | integer | NOT NULL | |
| `end_at` | integer | NOT NULL、CHECK `end_at > start_at` | |

- インデックス：`session_id`

`sleep_sync_state`（同期記録。1行だけ）

| 列 | 型 | 制約 | 内容 |
| --- | --- | --- | --- |
| `id` | integer | PK、CHECK `id = 1` | 常に1 |
| `last_synced_at` | integer | NOT NULL | 前回成功した同期の開始時刻（UNIX ミリ秒） |

- DB 制約で守るもの：時刻の前後関係・ステージの値域・睡眠時間が正・帰属日の形式（一覧と詳細の検索キーのため）・睡眠とステージの参照整合・同期記録が1行であること（UIを通らない書き込みでも壊れてはいけないため）
- アプリで守るもの：重なりの排除・主睡眠の判定・0分の睡眠を作らないこと（業務ルールのため）
- 外部キーを効かせるため、DB 接続時に `PRAGMA foreign_keys = ON` を実行する
- マイグレーションは `npx drizzle-kit generate` で `drizzle/` に生成する（手で編集しない）

### 3.3 ファイル構成と責務

#### 設定・依存
| パス | 変更 |
| --- | --- |
| `app.json` | `plugins` に次を追加する。`@kingstinct/react-native-healthkit`（`NSHealthShareUsageDescription` に日本語の説明、`NSHealthUpdateUsageDescription: false`、`background: false`）、`react-native-health-connect`、`expo-build-properties`（`android.compileSdkVersion: 36`・`targetSdkVersion: 36`・`minSdkVersion: 26`。`react-native-health-connect` v4 の README の Expo 設定例どおり）。`android.permissions` に `android.permission.health.READ_SLEEP` を追加する。Expo 構成では `MainActivity` の変更は要らない（同梱の Expo モジュールが許可結果の受け取りを登録する） |
| `tsconfig.json`・`jest.config.js` | パス別名 `@/drizzle/*` → `drizzle/*` を、既存の `@/*` → `src/*` より優先して解決されるように追加する（`src/lib/migration-gate.tsx` が `drizzle/migrations.js` を `@/` から始まるパスで import するため。architecture.md の「import は `@/` から始める」に合わせる） |
| `jest.config.js`・`tests/setup/global-setup.js` | `globalSetup` で `process.env.TZ = 'Asia/Tokyo'` にし、日付の扱いをテスト環境で固定する（`npm test` 以外で jest を起動しても効くように、スクリプトではなく設定で行う） |
| `package.json` | 開発用に `better-sqlite3`・`@types/better-sqlite3` を追加（`npx expo install better-sqlite3 @types/better-sqlite3 -- --save-dev`）。`better-sqlite3` のインストール時スクリプトを `npm install-scripts approve` で許可する |
| `drizzle/` | `npx drizzle-kit generate` で生成 |

#### 共通（`src/lib/`）
| パス | 責務 |
| --- | --- |
| `src/lib/logger.ts` | `logger.info` / `warn` / `error(name, fields)` を、`name`・`requestId`・`ms` などのキーを持つ1行の JSON として `console` に出す。`err` は種別・メッセージ・スタックに整形する。マスク処理として、`err` 以外の値は文字列・数値・真偽値・`null` だけを出し、オブジェクト・配列は `"[omitted]"` に置き換える（睡眠データを丸ごと渡しても出力されないようにする）。`undefined` のキーは出さない。スタックのない Error は `stack` を出さない |
| `src/lib/request-id.ts` | 1回の操作の相関ID（ランダムな文字列）を作る |
| `src/lib/clock.ts` | 現在時刻（`Date`）を返す。業務ロジックはこれを直接呼ばず、受け口層から引数で渡す |
| `src/lib/db.ts` | `getDb()` を公開する。初回の呼び出しで `expo-sqlite` の `openDatabaseSync` で DB を開き、以後は同じ接続を使い回す。開くときに`PRAGMA foreign_keys = ON` を実行し、各機能の `*.schema.ts` を集めた Drizzle インスタンスを返す。ネイティブモジュールに依存するためコンテナ内のテストでは確かめない（テストの対象外に記載）。テスト用DBの補助も同じ PRAGMA を実行する |
| `src/lib/migration-gate.tsx` | `drizzle-orm/expo-sqlite/migrator` の `useMigrations` に `@/lib/db` の DB と `@/drizzle/migrations` を渡してマイグレーションを適用し、完了まで子要素を出さない。失敗したら「データベースの準備に失敗しました」と表示し、`app.migrate` の error ログを出す。どの機能にも属さない起動時の基盤なので `src/lib/` に置く |
| `src/lib/db.types.ts` | `@/lib/db` が返す DB の型（同期型の `BaseSQLiteDatabase`）。テストで `@/lib/db` を better-sqlite3 の DB に差し替えても、型が合うようにする |

#### 睡眠記録（`src/features/sleep-record/`）
| パス | 層 | 責務 |
| --- | --- | --- |
| `src/features/sleep-record/sleep-record.types.ts` | 型 | セグメント・睡眠・ステージ区間・日ごとの要約・1日の詳細・連携状態・案内の型。Android のセグメントは、所属する SleepSession の ID と `startTime`/`endTime` も持つ（ステージがすべて捨てられたときに、セッション全体を `unspecified` にするため） |
| `src/features/sleep-record/sleep-record.schema.ts` | テーブル | 3.2 のテーブル定義 |
| `src/features/sleep-record/sleep-record-health-ios.repository.ts` | リポジトリ | HealthKit の連携状態の取得・許可の要求・睡眠サンプルの読み取り（`queryCategorySamples` に `limit: 0` を渡して全件、読み取り期間と重なるもの）と、共通セグメントへの変換 |
| `src/features/sleep-record/sleep-record-health-android.repository.ts` | リポジトリ | ヘルスコネクトの初期化・連携状態の取得・許可の要求・設定画面を開く・SleepSession の読み取り（`pageToken` で全ページ。`pageToken` がない・空文字なら打ち切る）と、共通セグメントへの変換 |
| `src/features/sleep-record/sleep-record-health.repository.ts` | リポジトリ | 引数の `os` で iOS／Android の実装を選び、同じ形の関数を返す（`react-native` は import しない） |
| `src/features/sleep-record/sleep-record.repository.ts` | リポジトリ | `@/lib/db` から DB を取得して読み書きする：睡眠の入れ替え（3.1 の削除条件・挿入・同期記録の更新を1トランザクション）、同期記録の読み取り、日ごとの睡眠の取得、帰属日を指定した睡眠とステージ区間の取得、睡眠の有無 |
| `src/features/sleep-record/sleep-record-session.service.ts` | サービス（純粋） | セグメントから睡眠を組み立てる（まとめる・同じ睡眠内の重なりを解消する・0分を捨てる・睡眠どうしの重なりを排除する・帰属日と睡眠時間を付ける） |
| `src/features/sleep-record/sleep-record-day.service.ts` | サービス（純粋） | 睡眠の一覧から、日ごとの要約（一覧用）と1日の詳細（主睡眠・昼寝・ステージ内訳）を作る |
| `src/features/sleep-record/sleep-record-date.service.ts` | サービス（純粋） | 詳細画面の日付パラメータを検証し、正しい帰属日（`YYYY-MM-DD`）か不正かを返す |
| `src/features/sleep-record/sleep-record-guide.service.ts` | サービス（純粋） | 連携状態・OS・睡眠の有無・同期中か・同期失敗の有無から、表示する案内の一覧を決める |
| `src/features/sleep-record/sleep-record-format.service.ts` | サービス（純粋） | 表示用の整形（分→「7時間32分」、時刻→「23:14」、日付→「11月25日（火）」） |
| `src/features/sleep-record/sleep-record-sync-range.service.ts` | サービス（純粋） | 取り込み範囲（開始・ヘルスケアの読み取り開始）の計算と、起床時刻による採用の判定 |
| `src/features/sleep-record/sleep-record-sync.service.ts` | サービス | 同期の実行（範囲の計算 → ヘルスケアの読み取り → 組み立て → DB の入れ替え）。`os`・`requestId`・現在時刻を返す関数 `getNow`（受け口層が `@/lib/clock` を渡す）を引数で受け取る。同期開始時刻とログの `ms` は `getNow` で測る |
| `src/features/sleep-record/sleep-record-access.service.ts` | サービス | 連携状態の取得・許可の要求・設定を開く、の窓口（失敗はログを出して投げ直す） |
| `src/features/sleep-record/sleep-record-query.service.ts` | サービス | 画面用の読み取りの窓口（日ごとの要約一覧・1日の詳細）。他機能（スマートアラーム）が過去の主睡眠を使うときもここを呼ぶ |
| `src/features/sleep-record/sleep-record.store.ts` | 受け口 | 画面をまたいで共有する状態（連携状態・同期中か・最後の同期エラー・許可の要求／設定を開くの失敗・データの版番号）と、その操作（`refreshAccess`・`sync`・`requestAccess`・`openSettings`）。サービスを呼び、届いたエラーを画面の状態にする。同期中の重複実行を防ぐ。`Platform.OS` を読み、操作ごとに `requestId` を作ってサービスに渡す |
| `src/features/sleep-record/use-sleep-record-sync.ts` | 受け口 | 起動時・前面復帰時（`AppState`）に store の `sync()` を呼ぶ |
| `src/features/sleep-record/sleep-record-sync-provider.tsx` | 受け口 | `use-sleep-record-sync` を1回だけ動かすコンポーネント。`src/app/_layout.tsx` が子要素を包んで描画する。起動時の同期は睡眠記録の業務なので `src/lib/` ではなく機能フォルダに置き、`src/app/` は画面コンポーネントと同じく描画するだけにする |
| `src/features/sleep-record/use-sleep-record-list.ts` | 受け口 | store の連携状態と DB の睡眠から、案内・日ごとの要約一覧を画面用の状態にする。表示用の整形（整形サービス。「今年」の判定に使う現在日は `@/lib/clock` から渡す）もここで呼び、画面には整形済みの文字列を渡す。版番号が変わったら読み直す。`Platform.OS` を読み、`requestId` を作ってサービスに渡す |
| `src/features/sleep-record/use-sleep-record-detail.ts` | 受け口 | 日付パラメータを検証（日付の検証サービス）し、指定日の詳細を整形済みの画面用の状態にする。版番号が変わったら読み直す。`requestId` を作ってサービスに渡す |
| `src/features/sleep-record/sleep-record-list-screen.tsx` | 受け口 | 一覧画面。案内・同期エラー・読み取りエラー・日ごとの行（タップで詳細へ）・下に引いて更新 |
| `src/features/sleep-record/sleep-record-detail-screen.tsx` | 受け口 | 詳細画面。主睡眠・ステージ内訳・昼寝の一覧・日付不正／データなし／読み取りエラーの表示 |
| `src/features/sleep-record/sleep-record-access-guide.tsx` | 受け口 | 連携状態に応じた案内文とボタン。一覧画面の部品で、表示する案内と押したときの操作を props で受け取る（サービス・store を直接呼ばない） |

- サービス層はリポジトリを通常の import で使う。DB 接続（`@/lib/db`）を import するのは DB リポジトリ（`sleep-record.repository.ts`）と `src/lib/migration-gate.tsx` だけにし、サービス層は DB に触れない。依存を外から注入する仕組みは作らない
- テストでは次の外部I/Oの境界だけを `jest.mock` で差し替える
  - ネイティブライブラリ（`@kingstinct/react-native-healthkit`・`react-native-health-connect`）→ テスト用の実装
  - `@/lib/db` → better-sqlite3 に実際のマイグレーションを適用した DB（中身は本物の SQL）
  - `react-native` の `Platform.OS`・`AppState`（OS の切り替え・前面復帰の再現。読むのはフックと store だけ）
  - `@/drizzle/migrations` → 適用できない壊れた SQL を含むマイグレーション（I4-11 でマイグレーションの失敗を起こすときだけ。DB への入力データの差し替えであり、アプリのロジックは差し替えない）
- I4 では `jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })` と `jest.setSystemTime()` で現在時刻を固定する（`@/lib/clock` は実時計を返すため、取り込み範囲とシードの起床時刻が実行日で変わらないようにする。Promise と RNTL の `waitFor`・`findBy*` が止まらないよう、`Date` とタイマー以外は偽装しない）
- 「同期サービスが何回呼ばれたか」「同期中」は、アプリ内のサービスを差し替えずに確かめる。回数はネイティブライブラリの読み取り関数（`queryCategorySamples`・`readRecords`）が呼ばれた回数で数え、同期中の状態はそのモックが返す Promise を保留にして作る
- 画面遷移と起動時の URL は `expo-router/testing-library` の `renderRouter` で、実際の `src/app/` のルートを読み込んで確かめる
- DB の読み取り失敗は、テスト用DB（一時ファイルの SQLite）を閉じて起こし、再試行の前に同じファイルを開き直す。DB リポジトリは呼び出しのたびに `@/lib/db` から DB を取得する（保持し続けない）ので、開き直した DB が使われる
- `drizzle-orm/expo-sqlite/migrator` の `useMigrations` が better-sqlite3 の DB で動くかは、手順12の最初に確かめる。動かなければ作業を止めて、I4-11 の確かめ方を相談する

#### 画面ルート（`src/app/`）
| パス | 内容 |
| --- | --- |
| `src/app/_layout.tsx` | `MigrationGate` の中に `SleepRecordSyncProvider`、その中に `Stack` を入れて描画するだけ（処理は書かない） |
| `src/app/index.tsx` | `SleepRecordListScreen` を描画するだけにする |
| `src/app/sleep/[date].tsx` | `date` パラメータを渡して `SleepRecordDetailScreen` を描画するだけ |

### 3.4 表示の仕様
- 時間は「7時間32分」「45分」「0分」（1時間以上なら分が0でも「1時間0分」）、時刻は「23:14」「0:05」（24時間表記、時は0埋めなし、分は2桁。端末のタイムゾーン）、日付は「11月25日（火）」で表示する。今年（端末の現在日の年）以外の日付は「2025年11月25日（火）」と年を付ける（履歴が1年を超えても見分けられるようにする）
- 一覧：帰属日の新しい順。睡眠がない日は行を出さない。各行に日付・合計睡眠時間・主睡眠の就寝〜起床・昼寝がある日は「昼寝 n件」
- 詳細
  - 主睡眠：就寝〜起床、睡眠時間
  - ステージ内訳（主睡眠だけ。昼寝は含めない）：深い・浅い・REM・覚醒・不明の順に、分（切り捨て）と割合。割合の分母はステージ区間の合計時間（iOS でまとめた空きの時間は含めない）。割合は小数点以下を四捨五入（.5 は切り上げ）するため、合計が100%にならないことがある。0分（1分未満）のステージは出さないが、分母には含める（そのぶん表示される割合の合計はさらに100%から離れることがあり、それでよい）。ステージなしの睡眠は「ステージ情報なし」と表示する
  - 昼寝：就寝の早い順に、就寝〜起床と睡眠時間
- 詳細画面の日付パラメータ
  - `YYYY-MM-DD` 形式で、実在する日付（例：`2026-02-30`・うるう年でない年の `02-29` は不可）でなければ「日付が正しくありません」
  - expo-router のパラメータは `string | string[] | undefined` になりうる。文字列1つ以外（未指定・配列）も「日付が正しくありません」
  - 正しい日付で睡眠がない（URL を直接開いた・同期で消えた）ときは「この日の睡眠データはありません」

### 3.5 ログ
| name | レベル | 出すとき | 記録する値 |
| --- | --- | --- | --- |
| `sleepRecord.sync` | info | 同期の成功（ヘルスケアから0件で入れ替えなかった場合も含む） | `requestId`・取り込み範囲の日数・読んだセグメント数・保存した睡眠数・入れ替えたか（真偽値）・`ms` |
| `sleepRecord.sync` | error | 同期の失敗 | `requestId`・`err` |
| `sleepRecord.fetchFromHealth` | warn | 表にないステージ値があった | `requestId`・未知の値の件数 |
| `sleepRecord.checkAccess` | error | 連携状態の取得の失敗 | `requestId`・`err` |
| `sleepRecord.requestAccess` | info | 許可の要求が例外なく終わった | `requestId`（要求後の連携状態は、続く `sync()` の中で取得する） |
| `sleepRecord.requestAccess` | error | 許可の要求の失敗 | `requestId`・`err` |
| `sleepRecord.openSettings` | error | 設定を開くの失敗 | `requestId`・`err` |
| `sleepRecord.loadList` | error | 一覧の読み取りの失敗 | `requestId`・`err` |
| `sleepRecord.loadDetail` | error | 詳細の読み取りの失敗 | `requestId`・`err`（日付は出さない） |
| `app.migrate` | error | マイグレーションの失敗 | `err` |

- 睡眠データそのもの（時刻・ステージ・帰属日）はログに出さない。件数と日数だけ
- エラーは記録したあと呼び出し元へ投げ直す。受け口層（store・フック。3.1 の「例外の扱い」）が受け取って画面の状態にする

## 4. テスト影響範囲
- 既存のテストはない（`tests/` は空）ため、影響を受けるテストはない
- `src/app/index.tsx`・`src/app/_layout.tsx` を置き換えるが、これらを対象にしたテストはない

## 5. 新規テストケース

### 単体（`tests/unit/`）
- U1 睡眠の組み立て（`sleep-record-session.service.ts`）
  - U1-1 iOS：同じ記録元で空きがちょうど30分のセグメントは1つの睡眠、30分1ミリ秒なら別の睡眠になる
  - U1-2 iOS：同じ記録元で時間が重なるセグメントは1つの睡眠になる。就寝はセグメントの開始の最小値、起床は終了の最大値になる（後ろのセグメントが前のセグメントに含まれる場合も）
  - U1-2b iOS：記録元が違うセグメントは、空きが30分以下でもまとめない
  - U1-0 長さ0（`start == end`）・前後が逆（`start > end`）のセグメントは捨てられ、残りから睡眠が組み立てられる
  - U1-3 Android：同じ SleepSession のセグメントは、空きがあっても1つの睡眠になる。就寝・起床は SleepSession の `startTime`/`endTime` ではなくステージの範囲になる
  - U1-3b Android：ステージが全部長さ0以下の SleepSession は、セッション全体の `unspecified` 1件として組み立てられる。SleepSession 自体が長さ0以下なら捨てられる
  - U1-3c `awake` と `unspecified` だけの睡眠は「ステージなし」、`light`・`deep`・`rem` のどれか1件でもあれば「ステージあり」になる
  - U1-4 同じ睡眠内でセグメントが重なる部分は優先度の高いステージ1つになり、睡眠時間が二重に数えられない（例：`unspecified` と `deep` の重なりは `deep`、`deep` と `rem` は `deep`、`rem` と `light` は `rem`）
  - U1-4b `awake` と `unspecified` が重なる部分は `awake` になり、その分は睡眠時間に入らない
  - U1-4c 重なりの解消で長さ0になる区間はできない（例：`deep` に完全に覆われた `unspecified` は区間として残らない）。隣り合う同じステージの区間は1つになる
  - U1-5 睡眠時間は覚醒を除いた合計を分に切り捨てたもの（例：7時間32分59秒 → 452分）
  - U1-6 睡眠時間が0分の睡眠は捨てる：覚醒だけ、覚醒以外が59秒 → 捨てる。覚醒以外がちょうど60秒 → 1分で残る
  - U1-7 重なる睡眠は、ステージありを残す
  - U1-8 両方ステージあり（またはなし）なら睡眠時間の長いほう、同じ長さなら記録元IDの辞書順で先、それも同じなら就寝が早いほう、それも同じなら睡眠 `id` の辞書順で先を残す（基準ごとに1ケース）
  - U1-9 同じ記録元の重なる睡眠（Android の重なる SleepSession）も1つだけ残す
  - U1-10 3つ連なって重なる（A–B、B–C が重なり A–C は重ならない）とき、B が最優先なら B だけ、A が最優先なら A と C が残る
  - U1-11 終了と開始がちょうど同じ時刻の睡眠は両方残す。1ミリ秒だけ重なる睡眠は片方だけ残す
  - U1-12 帰属日は起床時刻の日付になる（23:30就寝→6:30起床は起床日、23:59:59.999 の起床はその日、0:00ちょうどの起床は新しい日）
  - U1-13 セグメントが0件なら睡眠も0件
  - U1-15 記録元が `undefined`・空文字なら `source_id` は `"unknown"`、ID が `undefined`・空文字なら `"<記録元>:<開始>:<終了>"` になり、同じ入力なら毎回同じ値になる
  - U1-14 睡眠の `id` と `source_id`：iOS でまとめた睡眠の `id` は開始が最も早いセグメントの UUID（開始が同じなら UUID の辞書順で先）、Android は SleepSession の `metadata.id`。`source_id` は iOS が bundle identifier、Android が `dataOrigin`
- U2 日ごとの要約と詳細（`sleep-record-day.service.ts`）
  - U2-1 帰属日が同じ睡眠のうち、睡眠時間が最長のものが主睡眠、残りが昼寝になる。同じ長さなら就寝が早いほうが主睡眠。昼寝は就寝の早い順に並ぶ
  - U2-2 合計睡眠時間は主睡眠と昼寝の合計
  - U2-3 一覧は帰属日の新しい順で、睡眠のない日は含まない。睡眠が0件なら一覧は空
  - U2-4 ステージ内訳は主睡眠だけについて、深い・浅い・REM・覚醒・不明の順に、分（切り捨て）と割合を返し、0分のステージを含まない（59秒のステージは出さない、ちょうど60秒は1分で出す）。割合の分母はステージ区間の合計時間（出さないステージの時間も含む）
  - U2-4b iOS でまとめた空き（ステージ区間のない時間）がある睡眠では、割合の分母に空きの時間が入らない（例：区間の合計6時間・空き20分なら分母は6時間）
  - U2-5 割合の四捨五入：12.5% → 13%、12.4% → 12%
  - U2-6 ステージなしの睡眠は内訳なしになる
  - U2-7 指定日の睡眠がなければ「データなし」を返す
  - U2-8 日付パラメータの検証（`sleep-record-date.service.ts`）：`2026-11-25`・`2028-02-29`（うるう年）・`2000-02-29`（400で割り切れる年）は正しい。`abc`・`2026-1-5`・`2026-13-01`・`2026-02-30`・`2026-02-29`・`2100-02-29`（100で割り切れ400で割り切れない年）・`2026-00-10`・`2026-11-00`（月・日の0）・`2026-11-31`・`2026-12-32`（月末の次の日）・`2026-11-250`・`2026-11-25T00:00`（余分な文字）・空文字・`undefined`・配列（`['2026-11-25']`）は不正
- U3 取り込み範囲（`sleep-record-sync-range.service.ts`）
  - U3-1 同期記録なし → `now − 90日` 〜 `now`
  - U3-2 前回が3日前 → `now − 7日` から
  - U3-3 前回がちょうど7日前 → `now − 7日` から。7日と1ミリ秒前 → 前回の同期開始時刻から
  - U3-4 前回が20日前 → 前回の同期開始時刻から
  - U3-5 前回がちょうど90日前 → `now − 90日` から。90日より1ミリ秒新しい → 前回の同期開始時刻から
  - U3-6 前回が120日前 → `now − 90日` から
  - U3-7 前回が未来（時計を戻した）→ `now − 7日` から
  - U3-8 ヘルスケアの読み取り開始は、取り込み範囲の開始の24時間前
  - U3-9 採用の判定：起床が範囲の開始ちょうど → 採用、開始の1ミリ秒前 → 採用しない
- U4 案内の判定（`sleep-record-guide.service.ts`）
  - U4-1 睡眠なしの前提で、連携状態ごとに 3.1 の表どおりの案内だけになり、「睡眠データがありません」は出ない（`unavailable`・`updateRequired`・`notRequested`・`notGranted`・`checkFailed`）
  - U4-2 `ready` で睡眠ありなら案内なし
  - U4-3 `ready` で睡眠なしなら、iOS は許可の確認手順つき、Android は SOXAI の連携確認の案内
  - U4-4 `ready` で睡眠なしかつ同期失敗なら、失敗の表示と睡眠なしの案内の両方
  - U4-5 `ready` で睡眠ありかつ同期失敗なら、失敗の表示だけ
  - U4-6 `ready` 以外で睡眠ありなら、その状態の案内だけ（睡眠なしの案内は出ない）
  - U4-7 `ready` で睡眠なしかつ同期中なら「睡眠データを取り込んでいます」だけ（睡眠なしの案内は出ない）。睡眠ありかつ同期中なら同期中の表示だけ
  - U4-8 同期中かつ前回の同期が失敗していたら、失敗表示は出さず、同期中の表示（睡眠なしなら「睡眠データを取り込んでいます」）だけ
- U5 表示の整形（`sleep-record-format.service.ts`）
  - U5-1 分を「7時間32分」「1時間0分」「45分」「0分」に整形する。59分 →「59分」、60分 →「1時間0分」（切り替わりの両側）
  - U5-2 時刻を「23:14」「0:05」に整形する（TZ 固定の環境で、UNIX ミリ秒から）
  - U5-3 日付を「11月25日（火）」に整形する。今年以外は「2025年11月25日（火）」（現在日は引数で渡す。12月31日と翌年1月1日の境界を含む）
- U6 共通ログ（`src/lib/logger.ts`）
  - U6-1 `name` と渡した値を1行の JSON で、レベルに対応する `console` の関数（info→`console.info`、warn→`console.warn`、error→`console.error`）に出す
  - U6-2 `err` に Error を渡すと、種別・メッセージ・スタックに整形される。Error 以外（文字列など）を渡してもメッセージとして出る
  - U6-3 `err` 以外のオブジェクト・配列の値は `"[omitted]"` に置き換わり、中身が出力に含まれない
  - U6-4 `null` の値は `null` として出て、`undefined` の値のキーは出ない。スタックのない Error は `stack` なしで出る

### 中間（`tests/integration/`）
- I1 DB リポジトリ（better-sqlite3 に実際のマイグレーションを適用）
  - I1-1 入れ替えで、起床が範囲の開始以降（開始ちょうどを含む）の睡眠が消えて入れ直され、それより前は残る
  - I1-2 入れ替えで、範囲より前の睡眠でも、採用する睡眠と同じ `id` のものは消えて入れ直される（主キー衝突しない）
  - I1-3 入れ替えで、範囲より前の睡眠でも、採用する睡眠と時間が重なるものは消える。終了が採用する睡眠の開始とちょうど同じ睡眠は残る
  - I1-4 睡眠を消すと、そのステージ区間も消える（CASCADE）
  - I1-5 `sleep_sessions`・`sleep_stages` それぞれの `end_at <= start_at`・値域外のステージ・`asleep_minutes = 0`・`has_stages = 2`・形式の誤った `wake_date`（`2026/11/25`）・NOT NULL 列の NULL・`id ≠ 1` の同期記録・存在しない睡眠を指すステージは、制約で挿入に失敗する
  - I1-6 入れ替えの途中で失敗したら、睡眠・ステージ区間・同期記録のどれも入れ替え前のまま（トランザクション）
  - I1-7 日ごとの取得・帰属日指定の取得・睡眠の有無が正しく返る。睡眠が0件のときは空・「なし」が返る
- I2 同期（DB は本物、ヘルスケアのネイティブライブラリはテスト用の実装に差し替え）
  - I2-1 初回同期で90日分を取り込み、同期記録に同期開始時刻が書かれる
  - I2-2 2回目の同期で、ヘルスケア側で削除・修正された直近の睡眠が反映され、範囲外の古い睡眠は残る
  - I2-3 ヘルスケアの読み取りが失敗したら、エラーが呼び出し元に届き、DB の睡眠と同期記録は変わらない
  - I2-3b Android で1ページ目の `readRecords` は成功し、2ページ目が例外を投げたら、途中まで読んだ分で入れ替えず、DB の睡眠と同期記録は変わらず、`sleepRecord.sync` の error ログが出る
  - I2-3c Android（`os: 'android'`）で同期すると、SleepSession がそれぞれ1つの睡眠として保存される
  - I2-3d 2回目以降の同期で、`min(前回の同期開始時刻, now − 7日) − 24時間` 〜 `now` がヘルスケアの読み取り関数に渡る
  - I2-3e `metadata.id`・`dataOrigin` のない SleepSession が含まれていても、同期は成功し、代わりの値で保存される
  - I2-4 同期の成功・失敗のログに睡眠の時刻・ステージ・帰属日が含まれず、件数・日数だけが出る。成功ログの取り込み範囲の日数・読んだセグメント数・保存した睡眠数が、テストで用意したデータどおりの値になる
  - I2-5 DB に睡眠がある状態で、ヘルスケアから0件が返ったら、DB の睡眠と同期記録は変わらず、`sleepRecord.sync` の info ログに「入れ替えなし」（`replaced: false`）が出る
  - I2-6 DB の入れ替えが失敗したら（テスト用DBに、`sleep_stages` への挿入を必ず `RAISE(ABORT)` で失敗させるトリガーを作って起こす。睡眠の削除と挿入が済んだあとに失敗するので、ロールバックまで確かめられる）、エラーが呼び出し元に届き、`sleepRecord.sync` の error ログが出て、DB の睡眠と同期記録は変わらない
  - I2-7 同期ログの `ms` は、渡した `getNow` の開始と終了の差になる
  - I2-8 取り込み範囲の開始より前に寝て開始より後に起きた睡眠（例：開始の2時間前に就寝、6時間後に起床。iOS のサンプルが範囲の開始の前後に分かれている）が、元の就寝時刻のまま1件で保存される
  - I2-9 初回同期でヘルスケアから0件が返ったら、同期記録は書かれず、次の同期も90日分を読む
  - I2-12 DB に睡眠がある状態で、iOS のヘルスケアから `inBed` だけ（または長さ0のものだけ）が返ったら、0件として扱われ、DB の睡眠と同期記録は変わらない
  - I2-11 セグメントは1件以上あるが採用する睡眠が0件のとき（24時間さかのぼった部分にしかない、覚醒だけ）、範囲内の DB の睡眠が消え、同期記録が更新される
  - I2-10 ヘルスケアのリポジトリが未知のステージ値の件数を1以上返したら、`sleepRecord.fetchFromHealth` の warn ログ（`requestId`・件数）が出て、値そのものは出ない
- I3 ヘルスケアのリポジトリと連携状態の窓口（ネイティブライブラリを `jest.mock` で差し替え）
  - I3-1 iOS：睡眠サンプルが 3.1 の表どおりのステージに変換され、`inBed` は捨てられ、表にない値は `unspecified` になって未知の値の件数が返る。`queryCategorySamples` に全件取得（`limit: 0`）と読み取り期間（開始・終了）が渡る
  - I3-1b iOS の連携状態：`getRequestStatusForAuthorization` に渡る引数が、許可の要求と同じ睡眠の読み取りだけ（`toShare` なし）。`isHealthDataAvailable` が false → `unavailable`。`getRequestStatusForAuthorization` が `shouldRequest` → `notRequested`、`unnecessary` → `ready`、`unknown` → `ready`（1値ずつ）
  - I3-2 Android：ステージが表どおりに変換され、ステージなしの SleepSession は `unspecified` 1件になり、表にない値は `unspecified` になって未知の値の件数が返る。`pageToken` があれば次のページも読み、`undefined`・空文字なら打ち切る。`timeRangeFilter` に `between` と読み取り期間が渡る
  - I3-2b Android の連携状態：`getSdkStatus` が `SDK_UNAVAILABLE` → `unavailable`、`SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED` → `updateRequired`、`SDK_AVAILABLE` で睡眠の読み取りが許可済み → `ready`、未許可 → `notGranted`、表にない値 → 例外（1値ずつ）
  - I3-3 `os` 引数で iOS／Android の実装が切り替わる
  - I3-4 連携状態の取得に使う関数が例外を投げると、窓口（`sleep-record-access.service.ts`）から呼び出し元にエラーが届き、`sleepRecord.checkAccess` の error ログが出る。1関数ずつ確かめる：iOS は `isHealthDataAvailable`・`getRequestStatusForAuthorization`、Android は `getSdkStatus`・`initialize`・`getGrantedPermissions`。Android で `initialize()` が false を返したときも同じくエラーが届く
  - I3-5 （iOS の `requestAuthorization`・Android の `requestPermission` のそれぞれで）許可の要求が例外を投げると、エラーが呼び出し元に届き、`sleepRecord.requestAccess` の error ログが出る。例外なく終われば（iOS で false が返っても）成功として info ログが出る。要求に渡る引数が睡眠の読み取りだけ（iOS：`toRead` が睡眠のみで `toShare` なし、Android：`accessType: 'read'`・`recordType: 'SleepSession'` の1件のみ）
  - I3-6 「設定を開く」で Android の `openHealthConnectSettings` が呼ばれる。例外を投げると、エラーが呼び出し元に届き、`sleepRecord.openSettings` の error ログが出る。iOS で呼ぶと例外になる
- I4 画面・フック（React Native Testing Library。ネイティブライブラリは差し替え、DB は本物）
  - I4-1 一覧に日ごとの行が新しい順に出て、タップするとその日の詳細へ移る。各行の日付・合計睡眠時間・就寝〜起床が、テストで入れたデータから期待される文字列（例：「11月25日（火）」「7時間32分」「23:14〜6:46」）と一致する。昼寝がある日だけ「昼寝 n件」が出て、ない日は出ない
  - I4-2 連携状態ごとに案内が出て、「連携する」を押すと許可の要求が呼ばれ、許可されたら同期して一覧が出る
  - I4-2b Android で許可しなかったら `notGranted` の案内のままで同期しない。「設定を開く」を押すと `openHealthConnectSettings` が呼ばれる。それが例外を投げると「ヘルスコネクトの設定を開けませんでした。…」が出て、もう一度押すと表示が消える
  - I4-3 許可の要求が失敗すると「連携の要求に失敗しました」が出て、ボタンは押せるまま。連携状態は取得し直されない（連携状態の取得関数が呼ばれない）。もう一度押すと表示が消えて要求し直す。要求中はボタンを押せない
  - I4-4 連携状態の取得が失敗すると「ヘルスケアの状態を確認できませんでした」と「再試行」が出て、「再試行」で取得し直す
  - I4-5 （フック単体）`use-sleep-record-sync` を描画すると、連携状態の取得と同期が1回走る
  - I4-6 （store 単体）同期中に `sync` をもう一度呼んでも（下に引く・起動時の同期中の前面復帰の再現）、同期サービスは1回だけ呼ばれ、2回目の呼び出しは1回目の完了を待ってから終わる。同期が成功して終わったあとも、失敗して終わったあとも、`sync` を呼ぶと新しく同期サービスが呼ばれる。連携状態の取得中に `refreshAccess` をもう一度呼んでも、取得は1回だけ
  - I4-6c （store 単体）連携状態の取得のあと `ready` なら続けて同期する（`checkFailed` の再試行・許可の要求のあとを含む）。`ready` 以外で `sync` を呼ぶと連携状態の取得だけをして終わる。同期が成功すると、前回の同期エラーが消える
  - I4-6b （一覧画面）`ready` で下に引くと同期が走り、同期が成功しても失敗しても引っ張り中の表示が止まる。`ready` 以外で下に引くと、同期せず（ネイティブの読み取り関数が呼ばれず）、引っ張り中の表示が止まる
  - I4-6d （store 単体）同期の実行中に許可の要求が成功すると、実行中の同期の完了後に、連携状態の取得からもう一度同期が走る（合流しない）
  - I4-6e （フック単体）`AppState` が `inactive`→`active` に変わっても同期は走らず、`background`→`active` のときだけ走る
  - I4-7 （フック単体）アプリが前面に戻ると、連携状態の取得と同期が走る
  - I4-8 同期に失敗すると失敗の表示と「再試行」が出て、DB のデータは表示されたまま。「再試行」で同期し直す
  - I4-9 一覧の読み取りが失敗すると（テスト用DBを閉じて起こし、再試行の前に開き直す）「睡眠データを読み込めませんでした」と「再試行」が出て、`sleepRecord.loadList` の error ログが出る。「再試行」で読み直して一覧が出る
  - I4-9b 詳細の読み取りが失敗すると（I4-9 と同じ起こし方）「睡眠データを読み込めませんでした」と「再試行」が出て、`sleepRecord.loadDetail` の error ログが出る。ログに日付が含まれない。「再試行」で読み直して詳細が出る
  - I4-10 詳細に主睡眠（就寝〜起床・睡眠時間）・ステージ内訳（各ステージの分と割合）・昼寝が、テストで入れたデータから期待される文字列で出る。ステージなしは「ステージ情報なし」、データのない日は「この日の睡眠データはありません」、不正な日付は「日付が正しくありません」
  - I4-11 マイグレーションが失敗すると「データベースの準備に失敗しました」が出て、`app.migrate` の error ログが出る（失敗は、`@/drizzle/migrations` を適用できない壊れた SQL を含むマイグレーションに差し替えて起こす。アプリのロジックはモックしない）
  - I4-11b （`_layout.tsx` を通して）マイグレーションが失敗すると、同期も始まらない（ネイティブの読み取り関数が呼ばれない）
  - I4-12 （フック単体・store 単体）連携状態が `ready` 以外（`notRequested`・`notGranted`・`unavailable`・`updateRequired`・`checkFailed`）なら、起動・前面復帰・`sync` の呼び出しのどれでも同期サービスが呼ばれない
  - I4-12b （store 単体）連携状態の取得でエラーが届くと、連携状態が `checkFailed` になる
  - I4-13 連携状態が `ready` 以外でも DB に睡眠があれば、案内と一緒に一覧が出て、詳細も開ける
  - I4-13b （store 単体）1回の `sync()` で出る `sleepRecord.checkAccess`（失敗時）と `sleepRecord.sync` のログが、同じ `requestId` を持つ
  - I4-14 詳細の URL を直接開いて起動しても、起動時の同期が1回走る
  - I4-15 詳細を表示している間に同期が終わると、詳細が読み直されて新しい内容になる
  - I4-17 DB に睡眠がある状態で同期中は、一覧を表示したまま上部に同期中の表示が出る
  - I4-16 DB が空で初回同期の途中は「睡眠データを取り込んでいます」が出て「睡眠データがありません」は出ず、同期が終わると一覧が出る。一覧・詳細とも、初めて DB を読んでいる間は「読み込み中」が出る。一覧が出たあとの前面復帰・下に引く・同期後の読み直しの間は、一覧が出たままで「読み込み中」に置き換わらない
- I5 読み取りの窓口（`sleep-record-query.service.ts`。DB は本物）
  - I5-1 日ごとの要約一覧と1日の詳細が、DB の睡眠から作られて返る
  - I5-2 DB の読み取りが失敗したら（DB を閉じて起こす）、`sleepRecord.loadList`／`sleepRecord.loadDetail` の error ログ（`requestId` 付き、日付なし）が出て、エラーが呼び出し元に届く

### E2E（`tests/e2e/`、Maestro。コンテナ内では実行しない）
- E1 許可して表示：未連携で起動 → 「連携する」→ OS の許可画面で許可 → シードの睡眠が一覧に出る → 行をタップして詳細が出る
- E2 拒否したときの案内：Android で許可しない → 設定を開く案内が出る。iOS で許可しない → 許可の確認手順つきの案内が出る
- E3 睡眠なし：シード「睡眠実績がない状態」で、睡眠なしの案内が出る
- シードは `tests/e2e/seed/` に1つの定義ファイルで置く（睡眠なし・数日分・14日分）。日付は固定せず、実行日から逆算した相対日（例：実行日の1〜14日前）で定義する（ヘルスコネクトは許可の30日前より古いデータを読めないため）。エミュレータのヘルスコネクト／シミュレータのヘルスケアへの投入手順も同じ場所に書く
- iOS の E2E：Mac がなく、iOS シミュレータでのヘルスケアのシード投入・許可の取り消しをこのプロジェクトではまだ行えない。iOS のフローも書いておくが、実行は iOS を確かめられる環境（EAS のクラウド実行や実機）が決まってからとし、それまでは PR 本文に「iOS の E2E は未実行」と書く。Android の E2E はエミュレータで実行する
- 準備と後始末：各フローの冒頭で `launchApp`（`clearState: true`）によりアプリのデータ（DB）を消す。「未連携」の前提が要るフロー（E1・E2）は、冒頭で許可を取り消す。E3 は冒頭で端末のヘルスケアの睡眠データを「睡眠なし」のシードにする。取り消し・投入の手順（OS ごとのコマンド・操作）はシードの手順と同じ場所に書く。後始末（変更した許可を元に戻し、ヘルスケアの睡眠データを既定のシード（数日分）に入れ直す）は、フローが途中で失敗しても走るように Maestro の `onFlowComplete` に置く。準備も `onFlowStart` に置き、前のフローの結果に左右されないようにする

### テストの対象外
- 認可（他人のデータを見られないこと）：アカウントがなく、データは端末内の本人のものだけなので該当しない
- `src/lib/db.ts`：`expo-sqlite` のネイティブモジュールに依存し、コンテナ内では動かせない。外部キーの効き方（PRAGMA）は、同じ PRAGMA を実行するテスト用DBで I1-4・I1-5 として確かめる
- `src/lib/request-id.ts`・`src/lib/clock.ts`：判定や計算を持たない薄い包み（乱数・現在時刻を返すだけ）のため、単体テストを書かない。使う側のテストでは引数で差し替える

## 6. 実装順
各手順で「失敗するテスト → 最小の実装 → リファクタ」を回す。

1. 設定：`app.json` のプラグイン・権限、開発用の `better-sqlite3`、jest の TZ 固定、パス別名 `@/drizzle/*`
2. 共通ログ：U6 → `src/lib/logger.ts`。あわせて薄い包みの `src/lib/request-id.ts`・`src/lib/clock.ts`（テストの対象外）
3. 型：`sleep-record.types.ts`（テーブル定義 `sleep-record.schema.ts` は手順4で、テストのあとに作る）
4. DB 接続とテスト用DB：`src/lib/db.ts`・`src/lib/db.types.ts`、テスト用に better-sqlite3 へマイグレーションを適用し `PRAGMA foreign_keys = ON` を実行する補助（`tests/integration/helpers/`）。先に I1-4・I1-5 を書き、テーブルがない（マイグレーションがない）状態で失敗するのを確かめる。そのあと制約（CHECK・FK）まで入れたテーブル定義で `npx drizzle-kit generate` を1回だけ実行してマイグレーションを作る（列だけの版と制約つきの版に分けて生成すると、テーブルを作り直すマイグレーションが余計に残るため）
5. 睡眠の組み立て：U1 → `sleep-record-session.service.ts`
6. 日ごとの要約と詳細・日付の検証・整形：U2 → `sleep-record-day.service.ts`・`sleep-record-date.service.ts`、U5 → `sleep-record-format.service.ts`
7. DB リポジトリ：I1（I1-4・I1-5 以外）→ `sleep-record.repository.ts`
8. ヘルスケアのリポジトリ：I3-1〜I3-3 → iOS・Android・切り替えの3ファイル
9. 同期：U3 → `sleep-record-sync-range.service.ts`、I2 → `sleep-record-sync.service.ts`
10. 連携状態と案内：U4 → `sleep-record-guide.service.ts`、I3-4〜I3-6 → `sleep-record-access.service.ts`
11. 読み取りの窓口：I5 → `sleep-record-query.service.ts`
12. マイグレーションの適用：（最初に `useMigrations` が better-sqlite3 で動くか確かめる）I4-11 → `src/lib/migration-gate.tsx`
13. 同期の受け口（画面なし。store は直接、フックは `renderHook` で確かめる）：I4-5・I4-6・I4-6c・I4-6d・I4-6e・I4-7・I4-12・I4-12b → `sleep-record.store.ts`・`use-sleep-record-sync.ts`・`sleep-record-sync-provider.tsx`
14. 一覧と案内：I4-1（詳細へ移ることの確認は、手順15で詳細のルートを作ってから足す）・I4-11b・I4-13b・I4-2・I4-2b・I4-3・I4-4・I4-6b・I4-8・I4-9・I4-13・I4-16・I4-17 → `sleep-record-access-guide.tsx`・`use-sleep-record-list.ts`・`sleep-record-list-screen.tsx`・`src/app/index.tsx`・`src/app/_layout.tsx`
15. 詳細：I4-9b・I4-10・I4-14・I4-15 → `use-sleep-record-detail.ts`・`sleep-record-detail-screen.tsx`・`src/app/sleep/[date].tsx`
16. E2E：シード定義と E1〜E3 のフローを書く（実行はエミュレータ・実機のある環境で行う）

## 7. コミット前テスト実行
- `npm test`（単体・中間）
- `npm run lint`
- `npx tsc --noEmit`
- `npx drizzle-kit generate` を実行して、`drizzle/` に差分が出ないこと（テーブル定義とマイグレーションのずれがないこと）
- E2E（`maestro test tests/e2e`）は、開発ビルドを入れたエミュレータ・実機で、マージ前に実行できる環境があれば実行する。実行できなかった場合は PR 本文にその旨を書く

## 8. スコープ外
- 週・月のグラフ（02 で別に設計する）
- バックグラウンドでの同期
- ヘルスケアへの書き込み
- 記録元を選ぶ設定画面（重なりは「ステージありを優先」で自動的に選ぶ）
- Android の過去データ読み取り権限（`READ_HEALTH_DATA_HISTORY`）の要求
- 90日より古いデータの削除（DB に貯めたものは消さない）
- 取り込み範囲より前の睡眠の、ヘルスケア側での修正・削除の反映（ただし、範囲内で今回読んだ睡眠と同じ `id`・時間が重なるものは、入れ替えで消える）
- ヘルスケア側で取り込み範囲の睡眠を全部消した場合の反映（0件のときは入れ替えないため）
- 他機能（スマートアラーム）向けの「過去の主睡眠を返す」関数。スマートアラームの設計で `sleep-record-query.service.ts` に追加する
- 心拍・呼吸数など睡眠ステージ以外のデータ
- 旅行などでタイムゾーンが変わったときの帰属日の再計算（保存時のタイムゾーンで付けた帰属日を使い続ける）
- 一覧のページ送り（表示件数が増えても全件を表示する）

## テストリスト
<!-- tdd スキル手順1で記入する。1項目に「種別（単体/中間/E2E）・前提・操作・期待結果・対応する新規テストケース」 -->

## レビュー記録
<!-- ai-review スキルが合格時に1行ずつ追記する（例：- 2026-11-18 plan 合格（1ラウンド）） -->
- 2026-11-25 plan 合格（9ラウンド。9ラウンド目の P1 4件を修正後、再レビューせず人間の判断で合格。9ラウンド目の P2 のうち未対応の6件（テスト番号の並び、単体テストのファイルパス、詳細画面の日付見出し・案内、並べ替えのケース、`start_at` のインデックス）は test 段階で扱う）

## 修正履歴
<!-- 既存機能の修正時に1行ずつ追記する（例：- 2026-12-01 ログイン失敗時のロック回数を5回に変更） -->
