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
- ヘルスケアからは「取り込み範囲の開始 − 24時間」〜 `now` の期間と**重なる**セグメントを読む（iOS は `filter.date` の `startDate`/`endDate`、Android は `timeRangeFilter` の `between` を使う。どちらも期間と重なる記録を返す前提で、I3 で渡す引数を確かめる。重なりの扱いで結果が変わるのは、読み取り開始の24時間さかのぼりを超える長さ（24時間超）の睡眠だけで、それは想定しないため、実機での確認は E2E の対象にしない）。24時間さかのぼるのは、範囲の開始をまたぐ睡眠を途中で切らずに組み立てるため
- 組み立てた睡眠のうち、起床時刻が取り込み範囲の開始**以降**（開始ちょうどを含む）のものだけを採用する
- 「セグメントの件数」は、有効なセグメント（ステージへの変換で `inBed` を読み捨て、長さ0以下を捨てたあと）で数える。`inBed` だけ・長さ0のものだけが返ったときは0件として扱う。ただし Android で、ステージがすべて長さ0以下の SleepSession は、上の「ステージの共通化」のとおりセッション全体を1件の `unspecified` セグメントとして扱うため、そのセッション自体の長さが0より大きければ1件と数える（取り込み漏れを防ぐ。2026-11-26 に人間が判断）。セッション自体も長さ0以下なら0件。件数は組み立てサービス（`sleep-record-session.service.ts`）の純粋関数 `countValidSegments` が、組み立てと同じ規則（iOS は長さ0以下を捨てた数、Android はセッションごとにまとめ、ステージがすべて捨てられたセッションは長さが0より大きければ1件）で数え、同期サービスはその値を使う
- セグメントが1件以上あれば、組み立て後に採用する睡眠が0件（24時間さかのぼった部分にしかない・覚醒だけ など）でも入れ替えを行う。範囲内の DB の睡眠は消え、同期記録は更新される（ヘルスケアから正しく読めており、範囲内に睡眠がないことが確かなため）
- ヘルスケアから読んだセグメントが0件なら、DB の入れ替えも同期記録の更新もしない（成功扱いで終える）。iOS は許可を取り消されても例外にならず0件を返すため、貯めた履歴を消さないようにする。代わりに、ヘルスケア側で取り込み範囲の睡眠を全部消した場合は反映されない（スコープ外に記載）
- 連携状態の取得・同期の実行と重複防止は store の操作が持ち、連携状態・許可・設定・同期のサービスを呼ぶのは store の操作だけにする（一覧・詳細の読み取りの窓口は、それぞれのフックが呼ぶ）。1回の操作（`sync()` など）の中では同じ `requestId` を使う。`requestAccess()` と、そのあとに始める `sync()` は別の操作として、それぞれ `requestId` を作る。操作の中身は次のとおり
  - `refreshAccess()`：連携状態を取得して store に入れる。取得中にもう一度呼ばれたら、実行中のものの完了を待って終わる（同時に2回取得しない）
  - `sync()`：`refreshAccess()` を呼び、`ready` なら同期サービスを呼ぶ。同期中の印（`syncing`）は `sync()` を始めたとき（連携状態の取得の前）に立て、`sync()` が終わるとき（`ready` 以外で取得だけをして終わるときを含む）に下ろす。`ready` 以外で終わるときは、連携状態と同じ1回の更新で下ろす（`sync()` の途中に「`ready`・同期中でない」状態ができると、DB が空のとき「睡眠データがありません」が一瞬出うるため。単独の `refreshAccess()` に合流したときも同じ）。同期中にもう一度呼ばれたら、実行中のものの完了を待って終わる。起動・前面復帰・下に引く・同期の再試行・`checkFailed` の再試行は、すべてこれを呼ぶ
  - `requestAccess()`：許可を要求し、成功したら新しい `sync()` を始める。要求中の印（`requestingAccess`。「連携する」ボタンを押せなくする）は、実行中の `sync()` の完了を待つ間も含め、続く `sync()` で連携状態を取り直し終えた時点（取り直しの成功・失敗を問わない。同期の完了は待たない）まで立てたままにする。要求中にもう一度呼ばれたら、何もせずすぐに終わる（取り直すまでの間に「連携する」を二重に押せないようにするため）。実行中の `sync()` が終わってから新しい `sync()` が始まるまでの間に「`ready`・同期中でない」状態が一瞬できるのは許す（`ready` のときは「連携する」ボタンが出ないので、画面からこの経路に入ることはない）。そのとき実行中の `sync()` があれば、合流せずに完了を待ってから、改めて連携状態の取得から始める（許可の前に読んだ古い連携状態で終わらないようにするため）。連携状態の取得はこの新しい `sync()` の中の1回だけ
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
  - 連携状態がまだ一度も取れていないときだけ、「読み込み中」の表示だけを出す（案内・空の表示は出さない）。一覧・詳細の DB の読み取りは同期関数なので、フックは描画の中で読み（版番号・再試行の回数が変わったときだけ読み直す）、「DB を読んでいる間」の表示の状態を持たない。こうして、読み終える前の誤った案内・空の表示が出ないことを作りで守る（impl レビューで確認）。2回目以降の連携状態の取得・読み直し（前面復帰・下に引く・同期後の版番号の更新）の間は、それまでの表示を出したままにする
  - `ready` で DB に睡眠がなく同期中なら、「睡眠データを取り込んでいます」を出し、下の「睡眠データがありません」の案内は出さない（初回同期の途中に誤った案内を出さないため）
  - DB に睡眠があって同期中なら、一覧を表示したまま上部に同期中の表示を出す
  - 同期中は、前回の同期の失敗表示を出さない（再試行を押したら、結果が出るまでは同期中の表示だけにする）。失敗表示は同期が失敗で終わったときに出し、次の同期が成功したら消す
- `ready` で DB に睡眠が1件もなく、同期中でないとき
  - iOS：「睡眠データがありません。許可していない場合は、設定 → ヘルスケア → データアクセスとデバイス → suimin-app で睡眠を許可してください。SOXAI アプリのヘルスケア連携も確認してください」
  - Android：「睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください」
- 同期に失敗したとき：画面上部に「睡眠データの取り込みに失敗しました」と「再試行」ボタンを出し、DB にあるデータは表示し続ける。DB が空なら、失敗の表示と「睡眠データがありません」の案内を両方出す
- 同期の失敗表示は、連携状態が `ready` のときだけ出す。同期の失敗のあと連携状態が `ready` 以外に変わったら、その状態の案内だけを出す（同期できない状態では、案内のほうが次にすることにつながるため）
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
| `app.json`（impl レビューで追加） | `android.allowBackup: false` を追加する。Android の自動バックアップで、睡眠の DB（健康情報）が Google ドライブへ送られないようにする（要件「データは端末内にのみ保存し、外部サーバーへ送信しない」）。バックアップから復元できなくなるが、睡眠はヘルスケアから取り直せる（iOS は90日分、Android は許可の30日前まで）。iOS の iCloud・端末のバックアップから DB を外す方法は、実機で確かめる必要があるため TODO とする |
| `tsconfig.json`・`jest.config.js` | パス別名 `@/drizzle/*` → `drizzle/*` を、既存の `@/*` → `src/*` より優先して解決されるように追加する（`src/lib/migration-gate.tsx` が `drizzle/migrations.js` を `@/` から始まるパスで import するため。architecture.md の「import は `@/` から始める」に合わせる） |
| `jest.config.js`・`tests/setup/global-setup.js` | `globalSetup` で `process.env.TZ = 'Asia/Tokyo'` にし、日付の扱いをテスト環境で固定する（`npm test` 以外で jest を起動しても効くように、スクリプトではなく設定で行う） |
| `package.json` | 開発用に `better-sqlite3`・`@types/better-sqlite3` を追加（`npx expo install better-sqlite3 @types/better-sqlite3 -- --save-dev`）。`better-sqlite3` のインストール時スクリプト（ソースからのビルド）は `npm install-scripts deny` で実行しない（開発コンテナの Python ではビルドが失敗するため。パッケージに同梱のビルド済みバイナリ `prebuilds/linux-x64.node` を使う） |
| `drizzle/` | `npx drizzle-kit generate` で生成 |

#### 共通（`src/lib/`）
| パス | 責務 |
| --- | --- |
| `src/lib/logger.ts` | `logger.info` / `warn` / `error(name, fields)` を、`name`・`requestId`・`ms` などのキーを持つ1行の JSON として `console` に出す。`err` は種別・メッセージ・スタックに整形する（Error の判定は `instanceof` に頼らず、`name` と `message` がどちらも文字列なら Error として扱う。ネイティブのモジュールなど別の実行環境で作られたエラーも整形するため。`stack` は文字列のときだけ出す。`err` が文字列ならそのままメッセージに、数値・真偽値なら文字列にしてメッセージに、`null` なら `null` のまま、`undefined` ならキーを出さず、それ以外（Error の形でないオブジェクト・配列・BigInt・関数・シンボル）ならメッセージを `"[omitted]"` にする）。ログ関数そのものは例外を投げない（整形の途中で例外が起きたら、`name` と `logFailed: true` だけの1行を出す）。マスク処理として、`err` 以外の値は文字列・数値・真偽値・`null` だけを出し、それ以外（オブジェクト・配列・BigInt・関数・シンボル）は `"[omitted]"` に置き換える（睡眠データを丸ごと渡しても出力されないようにする）。`undefined` のキーは出さない。スタックのない Error は `stack` を出さない |
| `src/lib/request-id.ts` | 1回の操作の相関ID（ランダムな文字列）を作る |
| `src/lib/clock.ts` | 現在時刻（`Date`）を返す。業務ロジックはこれを直接呼ばず、受け口層から引数で渡す |
| `src/lib/db.ts` | `getDb()` を公開する。初回の呼び出しで `expo-sqlite` の `openDatabaseSync` で DB を開き、以後は同じ接続を使い回す。開くときに`PRAGMA foreign_keys = ON` を実行し、各機能の `*.schema.ts` を集めた Drizzle インスタンスを返す。ネイティブモジュールに依存するためコンテナ内のテストでは確かめない（テストの対象外に記載）。テスト用DBの補助も同じ PRAGMA を実行する |
| `src/lib/migration-gate.tsx` | `drizzle-orm/expo-sqlite/migrator` の `useMigrations` に `@/lib/db` の DB と `@/drizzle/migrations` を渡してマイグレーションを適用し、完了まで子要素を出さない。失敗したら「データベースの準備に失敗しました」と表示し、`app.migrate` の error ログを出す。DB を開けない（`getDb()` が例外を投げる）ときも同じ表示とログにする（描画の外へ例外を出してアプリを落とさない）。ログはエラーが変わったときに1回だけ出す。開けなかったあとは開き直さず、アプリを起動し直すまで失敗の表示のままにする。どの機能にも属さない起動時の基盤なので `src/lib/` に置く |
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
| `src/features/sleep-record/sleep-record-session.service.ts` | サービス（純粋） | セグメントから睡眠を組み立てる。あわせて、組み立てと同じ規則で有効なセグメントの件数を数える（`countValidSegments`。3.1 の「セグメントの件数」）（まとめる・同じ睡眠内の重なりを解消する・0分を捨てる・睡眠どうしの重なりを排除する・帰属日と睡眠時間を付ける） |
| `src/features/sleep-record/sleep-record-day.service.ts` | サービス（純粋） | 睡眠の一覧から、日ごとの要約（一覧用）と1日の詳細（主睡眠・昼寝・ステージ内訳）を作る |
| `src/features/sleep-record/sleep-record-date.service.ts` | サービス（純粋） | 詳細画面の日付パラメータを検証し、正しい帰属日（`YYYY-MM-DD`）か不正かを返す |
| `src/features/sleep-record/sleep-record-guide.service.ts` | サービス（純粋） | 連携状態・OS・睡眠の有無・同期中か・同期失敗の有無から、表示する案内の一覧を決める |
| `src/features/sleep-record/sleep-record-format.service.ts` | サービス（純粋） | 表示用の整形（分→「7時間32分」、時刻→「23:14」、日付→「11月25日（水）」）。02 で、期間の見出し・軸の分の時刻・グラフの日付の文字・日ごとのボタンの読み上げの説明を追加（`docs/features/02_sleep-chart.md`） |
| `src/features/sleep-record/sleep-record-sync-range.service.ts` | サービス（純粋） | 取り込み範囲（開始・ヘルスケアの読み取り開始）の計算と、起床時刻による採用の判定 |
| `src/features/sleep-record/sleep-record-sync.service.ts` | サービス | 同期の実行（範囲の計算 → ヘルスケアの読み取り → 組み立て → DB の入れ替え）。`os`・`requestId`・現在時刻を返す関数 `getNow`（受け口層が `@/lib/clock` を渡す）を引数で受け取る。同期開始時刻とログの `ms` は `getNow` で測る |
| `src/features/sleep-record/sleep-record-access.service.ts` | サービス | 連携状態の取得・許可の要求・設定を開く、の窓口（失敗はログを出して投げ直す） |
| `src/features/sleep-record/sleep-record-query.service.ts` | サービス | 画面用の読み取りの窓口（日ごとの要約一覧・1日の詳細）。他機能（スマートアラーム）が過去の主睡眠を使うときもここを呼ぶ |
| `src/features/sleep-record/sleep-record.store.ts` | 受け口 | 画面をまたいで共有する状態（連携状態・同期中か（`sync()` の実行中）・最後の同期エラー・許可の要求中か・許可の要求／設定を開くの失敗・データの版番号）と、その操作（`refreshAccess`・`sync`・`requestAccess`・`openSettings`）。サービスを呼び、届いたエラーを画面の状態にする。同期中の重複実行を防ぐ。`Platform.OS` を読み、操作ごとに `requestId` を作ってサービスに渡す |
| `src/features/sleep-record/use-sleep-record-sync.ts` | 受け口 | 起動時・前面復帰時（`AppState`）に store の `sync()` を呼ぶ |
| `src/features/sleep-record/sleep-record-sync-provider.tsx` | 受け口 | `use-sleep-record-sync` を1回だけ動かすコンポーネント。`src/app/_layout.tsx` が子要素を包んで描画する。起動時の同期は睡眠記録の業務なので `src/lib/` ではなく機能フォルダに置き、`src/app/` は画面コンポーネントと同じく描画するだけにする |
| `src/features/sleep-record/use-sleep-record-list.ts` | 受け口 | store の連携状態と DB の睡眠から、案内・日ごとの要約一覧を画面用の状態にする。表示用の整形（整形サービス。「今年」の判定に使う現在日は `@/lib/clock` から渡す）もここで呼び、画面には整形済みの文字列を渡す。版番号が変わったら読み直す。`Platform.OS` を読み、`requestId` を作ってサービスに渡す。画面の移動の関数（行のタップで詳細へ移る `openDay`、02 で足した `openChart`）を返す（architecture.md「画面の移動はフックから」） |
| `src/features/sleep-record/use-sleep-record-detail.ts` | 受け口 | 日付パラメータを検証（日付の検証サービス）し、指定日の詳細を整形済みの画面用の状態にする。版番号が変わったら読み直す。`requestId` を作ってサービスに渡す |
| `src/features/sleep-record/sleep-record-list-screen.tsx` | 受け口 | 一覧画面。上部の「週・月の推移」ボタン（02 で追加。フックの `openChart` を呼ぶ）・案内・同期エラー・読み取りエラー・日ごとの行（タップでフックの `openDay` を呼び、詳細へ。各行の要素に `testID` `sleep-record-row` を付ける。中間テストと E2E が行を数え・選ぶのに使う）・下に引いて更新 |
| `src/features/sleep-record/sleep-record-detail-screen.tsx` | 受け口 | 詳細画面。主睡眠・ステージ内訳・昼寝の一覧・日付不正／データなし／読み取りエラーの表示 |
| `src/features/sleep-record/sleep-record-access-guide.tsx` | 受け口 | 連携状態に応じた案内文とボタン。一覧画面の部品で、表示する案内と押したときの操作を props で受け取る（サービス・store を直接呼ばない） |

- サービス層はリポジトリを通常の import で使う。DB 接続（`@/lib/db`）を import するのは DB リポジトリ（`sleep-record.repository.ts`）と `src/lib/migration-gate.tsx` だけにし、サービス層は DB に触れない。依存を外から注入する仕組みは作らない
- テストでは次の外部I/Oの境界だけを `jest.mock` で差し替える
  - ネイティブライブラリ（`@kingstinct/react-native-healthkit`・`react-native-health-connect`）→ テスト用の実装
  - `@/lib/db` → better-sqlite3 に実際のマイグレーションを適用した DB（中身は本物の SQL）。I4-11 だけは、マイグレーションを適用していない空の DB（T130・T131）、または呼ばれると例外を投げる `getDb`（DB を開けない場合。T209）
  - `react-native` の `Platform.OS`・`AppState`（OS の切り替え・前面復帰の再現。読むのはフックと store だけ）
  - `@/drizzle/migrations` → I4-11・I4-11b だけで、次の2通りに差し替える。どちらも DB への入力データの差し替えであり、アプリのロジックは差し替えない
    - 適用できない壊れた SQL を含むマイグレーション（失敗を起こすとき）
    - 中身は本物のマイグレーションのまま、マイグレーション一覧（`journal.entries`）の読み出しをテストが解くまで止めておくもの（適用が終わる前の表示を見るとき。RNTL 14 の `render` は非同期で、`await render(...)` が画面の更新が落ち着くまで待つため、止めないと描画が返った時点で適用が済んでいる）
- I4 では `jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })` と `jest.setSystemTime()` で現在時刻を固定する（`@/lib/clock` は実時計を返すため、取り込み範囲とシードの起床時刻が実行日で変わらないようにする。Promise と RNTL の `waitFor`・`findBy*` が止まらないよう、`Date` とタイマー以外は偽装しない。ただし `renderRouter` は中で既定の設定の `jest.useFakeTimers()` を呼び直すため、手順14・15 の描画のあとはこの限りでない（固定した時刻は引き継がれ、`findBy*` で待てることを 2026-11-26 に確かめた））
- 「同期サービスが何回呼ばれたか」「同期中」は、アプリ内のサービスを差し替えずに確かめる。I4-13b の `requestId` だけは、中身を差し替えない `jest.spyOn`（本物の処理をそのまま動かし、渡った引数を見るだけ）で、連携状態の窓口と同期サービスに渡る値を確かめる。回数はネイティブライブラリの読み取り関数（`queryCategorySamples`・`readRecords`）が呼ばれた回数で数え、同期中の状態はそのモックが返す Promise を保留にして作る
- 画面遷移と起動時の URL は `expo-router/testing-library` の `renderRouter` で、実際の `src/app/` のルートを読み込んで確かめる
- DB の読み取り失敗は、テスト用DB（一時ファイルの SQLite）を閉じて起こし、再試行の前に同じファイルを開き直す。DB リポジトリは呼び出しのたびに `@/lib/db` から DB を取得する（保持し続けない）ので、開き直した DB が使われる
- `drizzle-orm/expo-sqlite/migrator` の `useMigrations` が better-sqlite3 の DB で動くかは、手順12の最初に確かめる。動かなければ作業を止めて、I4-11 の確かめ方を相談する（2026-11-26 に確かめ、動いた）

#### 画面ルート（`src/app/`）
| パス | 内容 |
| --- | --- |
| `src/app/_layout.tsx` | `MigrationGate` の中に `SleepRecordSyncProvider`、その中に `Stack` を入れて描画するだけ（処理は書かない） |
| `src/app/index.tsx` | `SleepRecordListScreen` を描画するだけにする |
| `src/app/sleep/[date].tsx` | `date` パラメータを渡して `SleepRecordDetailScreen` を描画するだけ |

#### E2E（`tests/e2e/`。Maestro のフローと、シードを入れる開発用アプリ）
Maestro にはパソコン側でコマンド（adb など）を実行する命令がなく、このアプリはヘルスケアへ書き込めない（要件「読み取りのみ」）。そのため、ヘルスコネクトへシードを入れる**別の開発用アプリ**（シードアプリ）を作り、フローからそのアプリを操作してシードを入れ替える。シードアプリはテストの道具で、配布しない。本体のアプリは書き込みの許可を持たないまま、読み取り専用を保つ（要件「ヘルスケアからは読み取りのみ」は本体のアプリの要件と解釈する。2026-11-26 に人間が判断し、本体と別のアプリにすることを選んだ）。

| パス | 内容 |
| --- | --- |
| `tests/e2e/seed/sleep-seed.js` | シードの定義（「睡眠なし」「数日分」「14日分」）。日付は実行日から逆算した相対日で持ち、`buildSeed(名前, 現在時刻)` で睡眠とステージ区間の絶対時刻を返す。`expectedLatest(名前, 現在時刻)` で、最新日の日付・合計睡眠時間・就寝〜起床・睡眠時間の表示文字列（3.4 の形）を返す。日付と時刻はどちらも日本時間（+09:00）で計算し、動かす機械のタイムゾーンに左右されないようにする（Maestro の `runScript` はパソコン側で、シードアプリはエミュレータで動くため）。シードアプリと Maestro の `runScript` の両方から使うため、import を使わない素の JavaScript にする（`module` があるときだけ `module.exports` する）。Maestro から使うときは、環境変数 `SEED` で名前を受け、`output.latestDate`・`output.latestTotal`・`output.latestTime`・`output.latestMainTotal` に文字列を入れる。「14日分」は今回のフローでは使わず、スマートアラームの推定（testing.md の「推定に足りる日数」）のために置いておく。日付の文字列は 3.4 のとおり、今年（日本時間の現在日の年）以外なら年を付ける。表示文字列の作り方はアプリの整形サービスを使わず、このファイルに書く（E2E でアプリ内部を使わないため）。02 で、今日を含む週の見出しの文字列・最新日が今週にあるか・最新日のボタンの読み上げの説明を `output` に足す（`docs/features/02_sleep-chart.md`） |
| `tests/e2e/seed/seeder-app/` | シードアプリ（Android だけ。別の Expo プロジェクトで、`package.json`・`app.json`・`tsconfig.json`・`metro.config.js` を持つ。パッケージ名は `dev.suimin.e2eseeder`）。`../sleep-seed.js` はフォルダの外にあるため、`metro.config.js` の `watchFolders` に `tests/e2e/seed/` を入れて読む。依存は `tests/e2e/seed/seeder-app/` で `npm install` して入れる。`app.json` には本体と同じく `react-native-health-connect` と `expo-build-properties`（compileSdk 36 など。3.3「設定・依存」と同じ値）のプラグインを入れる。ビルドは JS を同梱する preview の APK にする（開発ビルドどうしだと、どちらも Metro の同じポートにつなぎに行き、本体の `npx expo start` と同時に動かせないため）。そのため `tests/e2e/seed/seeder-app/eas.json` に `preview` プロファイル（`android.buildType: apk`）を置き、`eas build --profile preview --platform android` で作る。権限は `android.permission.health.WRITE_SLEEP` だけ。画面に「睡眠なし」「数日分」「14日分」のボタンがあり、押すと書き込みの許可を確かめ（なければ要求し）、このアプリが書いた SleepSession を直近60日ぶん消して（`deleteRecordsByTimeRange`。ヘルスコネクトは書いたアプリのデータしか消せない）、そのシードを `insertRecords` で入れる。終わったら「投入完了：<名前>」、失敗したら「投入失敗」を出す。ログ・画面に睡眠の時刻は出さない |
| `tests/e2e/seed/README.md` | 実行前の準備（シードアプリと本体の開発ビルドをエミュレータに入れる・エミュレータの言語を日本語、タイムゾーンを Asia/Tokyo にする・エミュレータに他のアプリの睡眠データを入れない）、実行のコマンド、0時（日本時間）をまたぐ時間帯に実行しないこと、エミュレータとパソコンの時計をそろえること（シードアプリと `runScript` がそれぞれの現在時刻から日付を逆算するため）、許可の取り消し・付け直しの方法（下の確認の結果）、iOS が未対応であること。各フローは前のフローの結果に左右されず、実行の順序は問わない |
| `tests/e2e/subflows/seed.yaml` | シードアプリを起動して、環境変数 `SEED` のボタンを押し、「投入完了：<名前>」を待つ |
| `tests/e2e/subflows/reset-app.yaml` | 本体を `launchApp`（`clearState: true`）で起動し直してデータ（DB）を消し、環境変数 `READ_SLEEP`（`allow`／`deny`）で睡眠の読み取りの許可を設定する |
| `tests/e2e/subflows/restore.yaml` | 後始末。シードを「数日分」に戻し、本体の睡眠の読み取りを許可に戻す |
| `tests/e2e/sleep-flow.yaml`・`deny-android.yaml`・`deny-ios.yaml`・`no-data.yaml` | E1〜E3 のフロー（テストリストの T176〜T179）。Android 用には `tags: [android]`、iOS 用（`deny-ios.yaml`）には `tags: [ios]` を付け、`maestro test --include-tags=android tests/e2e` で Android 用だけを走らせる（部品フローは `tests/e2e/subflows/` に置き、フォルダ直下のフローとしては走らない）。iOS 用は E2 の `deny-ios.yaml` だけを書き、E1・E3 の iOS 用はシミュレータへの投入方法が決まってから書く。表示を待つときは固定時間で待たず、`extendedWaitUntil` で条件が満たされるまで待つ |
| `app.json`（手順16で変更） | Maestro の `appId` に使うため、`android.package` と `ios.bundleIdentifier` を `dev.suimin.app` で追加する |
| `tsconfig.json`・`eslint.config.js`・`jest.config.js`・`metro.config.js`（手順16で変更） | 本体の型チェック・リント・Jest・Metro の対象から `tests/e2e/seed/seeder-app/` を外す（別の Expo プロジェクトで、依存も設定も別のため。`tsconfig.json` の `exclude`、ESLint の `ignores`、Jest の `modulePathIgnorePatterns`、Metro の `resolver.blockList`）。シードアプリはそのフォルダで `npx tsc --noEmit`・`npx expo lint` を走らせる |

- 最初の実行で確かめること（結果は `tests/e2e/seed/README.md` に書く）
  - `launchApp` の `permissions`（または `setPermissions`）に `android.permission.health.READ_SLEEP` を指定して効くか。効かなければ、ヘルスコネクトの設定画面を Maestro で操作して切り替える部品フローに置き換える
  - `clearState: true` でヘルスコネクトの許可が消えるか残るか
  - 本体の開発ビルドの `AndroidManifest.xml` に `android:allowBackup="false"` が入っているか。あわせて、機種変更時の端末間の直接転送で DB が移るか（Android の版による）
  - T177 で「許可しない」を繰り返したとき（3.1 の「2回拒否すると OS の許可画面が出なくなる」）、`reset-app.yaml` で拒否の回数が戻るか。戻らなければ、実行の前にパソコン側で許可の印を消す手順（`adb shell pm clear-permission-flags` など）を README に書き、`maestro test` を1回実行する前に1度だけ流す（Maestro はパソコン側のコマンドを実行できないため、フローの中には入れない。T177 の拒否は1回の実行で1回だけなので、実行の前の1度で足りる）
- シードアプリは単体・中間テストの対象にしない（テストの道具であり、正しく入れられたかは E1 で `sleep-seed.js` から算出した文字列と一致することで分かる）。型チェックとリントは本体と同じく通す
- iOS：シードアプリは Android だけ。iOS のフローは `deny-ios.yaml` だけを書き、シミュレータのヘルスケアへの投入方法と許可の取り消し方法が決まるまで実行しない（それまでは PR 本文に「iOS の E2E は未実行」と書く）

### 3.4 表示の仕様
- 時間は「7時間32分」「45分」「0分」（1時間以上なら分が0でも「1時間0分」）、時刻は「23:14」「0:05」（24時間表記、時は0埋めなし、分は2桁。端末のタイムゾーン）、日付は「11月25日（水）」で表示する。今年（端末の現在日の年）以外の日付は「2025年11月25日（火）」と年を付ける（履歴が1年を超えても見分けられるようにする）
- 一覧：帰属日の新しい順。睡眠がない日は行を出さない。各行に日付・合計睡眠時間・主睡眠の就寝〜起床・昼寝がある日は「昼寝 n件」
- 詳細
  - 主睡眠：就寝〜起床、睡眠時間
  - ステージ内訳（主睡眠だけ。昼寝は含めない）：深い・浅い・REM・覚醒・不明の順に、分（切り捨て）と割合。割合の分母はステージ区間の合計時間（iOS でまとめた空きの時間は含めない）。割合は小数点以下を四捨五入（.5 は切り上げ）するため、合計が100%にならないことがある。0分（1分未満）のステージは出さないが、分母には含める（そのぶん表示される割合の合計はさらに100%から離れることがあり、それでよい）。ステージなしの睡眠は「ステージ情報なし」と表示する。ステージありでも、表示する行（1分以上のステージ）が1つもないとき（例：`light` 59秒＋`deep` 59秒）も「ステージ情報なし」と表示する
  - 昼寝：就寝の早い順に、就寝〜起床と睡眠時間
- 詳細画面の日付パラメータ
  - `YYYY-MM-DD` 形式で、実在する日付（例：`2026-02-30`・うるう年でない年の `02-29` は不可）でなければ「日付が正しくありません」
  - expo-router のパラメータは `string | string[] | undefined` になりうる。文字列1つ以外（未指定・配列）も「日付が正しくありません」
  - 正しい日付で睡眠がない（URL を直接開いた・同期で消えた）ときは「この日の睡眠データはありません」

### 3.5 ログ
| name | レベル | 出すとき | 記録する値 |
| --- | --- | --- | --- |
| `sleepRecord.sync` | info | 同期の成功（ヘルスケアから0件で入れ替えなかった場合も含む） | `requestId`・取り込み範囲の日数・有効なセグメント数（3.1 の「セグメントの件数」の数え方）・保存した睡眠数・入れ替えたか（真偽値）・`ms` |
| `sleepRecord.sync` | error | 同期の失敗 | `requestId`・`err` |
| `sleepRecord.fetchFromHealth` | warn | 表にないステージ値があった | `requestId`・未知の値の件数 |
| `sleepRecord.checkAccess` | error | 連携状態の取得の失敗 | `requestId`・`err` |
| `sleepRecord.requestAccess` | info | 許可の要求が例外なく終わった | `requestId`（要求後の連携状態は、続く `sync()` の中で取得する） |
| `sleepRecord.requestAccess` | error | 許可の要求の失敗 | `requestId`・`err` |
| `sleepRecord.openSettings` | error | 設定を開くの失敗 | `requestId`・`err` |
| `sleepRecord.loadList` | error | 一覧の読み取りの失敗 | `requestId`・`err` |
| `sleepRecord.loadDetail` | error | 詳細の読み取りの失敗 | `requestId`・`err`（日付は出さない） |
| `app.migrate` | error | DB を開けない・マイグレーションの失敗 | `err` |

- 取り込み範囲の日数は、`(now − 取り込み範囲の開始) ÷ 24時間` を小数第1位で四捨五入した数値（例：7日と5時間 → `7.2`、90日 → `90`）
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
  - U1-16 有効なセグメントの件数（`countValidSegments`）：iOS は長さ0以下を除いた数。Android はセッションごとにまとめ、正の長さのステージの数を数え、ステージがすべて長さ0以下のセッションは、セッション自体の長さが0より大きければ1件、0以下なら0件
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
  - U5-3 日付を「11月25日（水）」に整形する。今年以外は「2025年11月25日（火）」（現在日は引数で渡す。12月31日と翌年1月1日の境界を含む）
- U6 共通ログ（`src/lib/logger.ts`）
  - U6-1 `name` と渡した値を1行の JSON で、レベルに対応する `console` の関数（info→`console.info`、warn→`console.warn`、error→`console.error`）に出す
  - U6-2 `err` に Error を渡すと、種別・メッセージ・スタックに整形される。Error 以外（文字列など）を渡してもメッセージとして出る
  - U6-3 `err` 以外のオブジェクト・配列の値は `"[omitted]"` に置き換わり、中身が出力に含まれない
  - U6-4 `null` の値は `null` として出て、`undefined` の値のキーは出ない。スタックのない Error は `stack` なしで出る
  - U6-5 別の実行環境（ネイティブのモジュールなど）で作られ `instanceof Error` が偽になるエラーも、`name`・`message`（文字列）を持てば Error と同じく種別・メッセージ・スタックに整形される。持たないオブジェクトはメッセージが `"[omitted]"` になり、中身が出ない。ログ関数は、整形できない値（null プロトタイプのオブジェクト・`BigInt` など）を渡されても例外を投げずに1行を出す

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
  - I2-4 同期の成功・失敗のログに睡眠の時刻・ステージ・帰属日が含まれず、件数・日数だけが出る。成功ログの取り込み範囲の日数・有効なセグメント数（3.1 の数え方）・保存した睡眠数が、テストで用意したデータどおりの値になる
  - I2-5 DB に睡眠がある状態で、ヘルスケアから0件が返ったら、DB の睡眠と同期記録は変わらず、`sleepRecord.sync` の info ログに「入れ替えなし」（`replaced: false`）が出る
  - I2-6 DB の入れ替えが失敗したら（テスト用DBに、`sleep_stages` への挿入を必ず `RAISE(ABORT)` で失敗させるトリガーを作って起こす。睡眠の削除と挿入が済んだあとに失敗するので、ロールバックまで確かめられる）、エラーが呼び出し元に届き、`sleepRecord.sync` の error ログが出て、DB の睡眠と同期記録は変わらない
  - I2-7 同期ログの `ms` は、渡した `getNow` の開始と終了の差になる
  - I2-8 取り込み範囲の開始より前に寝て開始より後に起きた睡眠（例：開始の2時間前に就寝、6時間後に起床。iOS のサンプルが範囲の開始の前後に分かれている）が、元の就寝時刻のまま1件で保存される
  - I2-9 初回同期でヘルスケアから0件が返ったら、同期記録は書かれず、次の同期も90日分を読む
  - I2-12 DB に睡眠がある状態で、iOS のヘルスケアから `inBed` だけ（または長さ0のものだけ）が返ったら、0件として扱われ、DB の睡眠と同期記録は変わらない
  - I2-12b Android で、ステージがすべて長さ0の SleepSession だけが返ったら、セッション自体の長さが0より大きければ1件と数えて入れ替える。セッション自体も長さ0なら0件として扱い、DB と同期記録は変わらない
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
  - I4-1 一覧に日ごとの行が新しい順に出て、タップするとその日の詳細へ移る。各行の日付・合計睡眠時間・就寝〜起床が、テストで入れたデータから期待される文字列（例：「11月25日（水）」「7時間32分」「23:14〜6:46」）と一致する。昼寝がある日だけ「昼寝 n件」が出て、ない日は出ない
  - I4-2 連携状態ごとに案内が出て、「連携する」を押すと許可の要求が呼ばれ、許可されたら同期して一覧が出る
  - I4-2b Android で許可しなかったら `notGranted` の案内のままで同期しない。「設定を開く」を押すと `openHealthConnectSettings` が呼ばれる。それが例外を投げると「ヘルスコネクトの設定を開けませんでした。…」が出て、もう一度押すと表示が消える
  - I4-3 許可の要求が失敗すると「連携の要求に失敗しました」が出て、ボタンは押せるまま。連携状態は取得し直されない（連携状態の取得関数が呼ばれない）。もう一度押すと表示が消えて要求し直す。要求中（連携状態を取り直し終えるまで）はボタンを押せない
  - I4-4 連携状態の取得が失敗すると「ヘルスケアの状態を確認できませんでした」と「再試行」が出て、「再試行」で取得し直す
  - I4-5 （フック単体）`use-sleep-record-sync` を描画すると、連携状態の取得と同期が1回走る
  - I4-6 （store 単体）同期中に `sync` をもう一度呼んでも（下に引く・起動時の同期中の前面復帰の再現）、同期サービスは1回だけ呼ばれ、2回目の呼び出しは1回目の完了を待ってから終わる。同期が成功して終わったあとも、失敗して終わったあとも、`sync` を呼ぶと新しく同期サービスが呼ばれる。連携状態の取得中に `refreshAccess` をもう一度呼んでも、取得は1回だけ
  - I4-6f （store 単体）`sync()` の途中に「`ready`・同期中でない」状態が一度もできない。許可の要求中の印は、連携状態を取り直し終えた時点（成功・失敗とも）で下り、それまでの間（実行中の同期を待つ間を含む）に `requestAccess()` を呼んでも要求は重ならない
  - I4-6c （store 単体）連携状態の取得のあと `ready` なら続けて同期する（`checkFailed` の再試行・許可の要求のあとを含む）。`ready` 以外で `sync` を呼ぶと連携状態の取得だけをして終わる。同期が成功すると、前回の同期エラーが消える
  - I4-6b （一覧画面）`ready` で下に引くと同期が走り、同期が成功しても失敗しても引っ張り中の表示が止まる。`ready` 以外で下に引くと、同期せず（ネイティブの読み取り関数が呼ばれず）、引っ張り中の表示が止まる
  - I4-6d （store 単体）同期の実行中に許可の要求が成功すると、実行中の同期の完了後に、連携状態の取得からもう一度同期が走る（合流しない）
  - I4-6e （フック単体）`AppState` が `inactive`→`active` に変わっても同期は走らず、`background`→`active` のときだけ走る
  - I4-7 （フック単体）アプリが前面に戻ると、連携状態の取得と同期が走る
  - I4-8 同期に失敗すると失敗の表示と「再試行」が出て、DB のデータは表示されたまま。「再試行」で同期し直す
  - I4-9 一覧の読み取りが失敗すると（テスト用DBを閉じて起こし、再試行の前に開き直す）「睡眠データを読み込めませんでした」と「再試行」が出て、`sleepRecord.loadList` の error ログが出る。「再試行」で読み直して一覧が出る
  - I4-9b 詳細の読み取りが失敗すると（I4-9 と同じ起こし方）「睡眠データを読み込めませんでした」と「再試行」が出て、`sleepRecord.loadDetail` の error ログが出る。ログに日付が含まれない。「再試行」で読み直して詳細が出る
  - I4-10 詳細に主睡眠（就寝〜起床・睡眠時間）・ステージ内訳（各ステージの分と割合）・昼寝が、テストで入れたデータから期待される文字列で出る。ステージなしは「ステージ情報なし」、データのない日は「この日の睡眠データはありません」、不正な日付は「日付が正しくありません」
  - I4-11 マイグレーションが失敗すると「データベースの準備に失敗しました」が出て、`app.migrate` の error ログが出る（失敗は、`@/drizzle/migrations` を適用できない壊れた SQL を含むマイグレーションに差し替えて起こす。アプリのロジックはモックしない）。DB を開けない（`@/lib/db` の `getDb` が例外を投げる）ときも、同じ表示と error ログになり、アプリは落ちない
  - I4-11b （`_layout.tsx` を通して）マイグレーションが失敗すると、同期も始まらない（ネイティブの読み取り関数が呼ばれない）
  - I4-12 （フック単体・store 単体）連携状態が `ready` 以外（`notRequested`・`notGranted`・`unavailable`・`updateRequired`・`checkFailed`）なら、起動・前面復帰・`sync` の呼び出しのどれでも同期サービスが呼ばれない
  - I4-12b （store 単体）連携状態の取得でエラーが届くと、連携状態が `checkFailed` になる
  - I4-13 連携状態が `ready` 以外でも DB に睡眠があれば、案内と一緒に一覧が出て、詳細も開ける
  - I4-13b （store 単体）1回の `sync()` の中で、連携状態の窓口と同期サービスに渡る `requestId` が同じ値で、別の `sync()` とは違う値になる。同期の中で出るログ（`sleepRecord.fetchFromHealth`・`sleepRecord.sync`）も同じ値を持つ
  - I4-14 詳細の URL を直接開いて起動しても、起動時の同期が1回走る
  - I4-15 詳細を表示している間に同期が終わると、詳細が読み直されて新しい内容になる
  - I4-17 DB に睡眠がある状態で同期中は、一覧を表示したまま上部に同期中の表示が出る
  - I4-16 DB が空で初回同期の途中は「睡眠データを取り込んでいます」が出て「睡眠データがありません」は出ず、同期が終わると一覧が出る。「読み込み中」は連携状態がまだ一度も取れていない間だけ出る。一覧・詳細は DB を描画の中で同期的に読み、「DB を読んでいる間」の表示の状態を持たない（3.1。外から見られないため、テストでは確かめず impl レビューでコードを確かめる。テストでは、連携状態の取得中の「読み込み中」と、読み取り後の最終状態を確かめる）。一覧が出たあとの前面復帰・下に引く・同期後の読み直しの間は、一覧が出たままで「読み込み中」に置き換わらない
- I5 読み取りの窓口（`sleep-record-query.service.ts`。DB は本物）
  - I5-1 日ごとの要約一覧と1日の詳細が、DB の睡眠から作られて返る
  - I5-2 DB の読み取りが失敗したら（DB を閉じて起こす）、`sleepRecord.loadList`／`sleepRecord.loadDetail` の error ログ（`requestId` 付き、日付なし）が出て、エラーが呼び出し元に届く

### E2E（`tests/e2e/`、Maestro。コンテナ内では実行しない）
- E1 許可して表示：未連携で起動 → 「連携する」→ OS の許可画面で許可 → シードの睡眠が一覧に出る → 行をタップして詳細が出る
- E2 拒否したときの案内：Android で許可しない → 設定を開く案内が出る。iOS で許可しない → 許可の確認手順つきの案内が出る
- E3 睡眠なし：シード「睡眠実績がない状態」で、睡眠なしの案内が出る
- シードは `tests/e2e/seed/sleep-seed.js` に1つの定義ファイルで置く（睡眠なし・数日分・14日分）。日付は固定せず、実行日から逆算した相対日（例：実行日の1〜14日前）で定義する（ヘルスコネクトは許可の30日前より古いデータを読めないため）。エミュレータのヘルスコネクトへは、シードアプリ（3.3「E2E」）を Maestro から操作して入れる。投入の手順・シミュレータのヘルスケアが未対応であることは `tests/e2e/seed/README.md` に書く
- iOS の E2E：Mac がなく、iOS シミュレータでのヘルスケアのシード投入・許可の取り消しをこのプロジェクトではまだ行えない。iOS のフローも書いておくが、実行は iOS を確かめられる環境（EAS のクラウド実行や実機）が決まってからとし、それまでは PR 本文に「iOS の E2E は未実行」と書く。Android の E2E はエミュレータで実行する
- 準備と後始末：各フローの `onFlowStart` で、シードアプリでその回のシードを入れ（部品フロー `seed.yaml`）、本体のデータ（DB）を消して睡眠の読み取りの許可を設定する（`reset-app.yaml`。「未連携」の前提が要る E1・E2 は `deny`、E3 は `allow`）。後始末（シードを「数日分」に戻し、許可を `allow` に戻す。`restore.yaml`）は、フローが途中で失敗しても走るように `onFlowComplete` に置く。準備も `onFlowStart` に置き、前のフローの結果に左右されないようにする

### テストの対象外
- `app.json` の `android.allowBackup: false`：コンテナ内では確かめられない。開発ビルドで生成された `AndroidManifest.xml` に `android:allowBackup="false"` が入っていることを、エミュレータで確かめる（E2E の README の「最初の実行で確かめること」に書く）
- 認可（他人のデータを見られないこと）：アカウントがなく、データは端末内の本人のものだけなので該当しない
- `src/lib/db.ts`：`expo-sqlite` のネイティブモジュールに依存し、コンテナ内では動かせない。テスト用DBの better-sqlite3 は外部キーが既定で有効（`SQLITE_DEFAULT_FOREIGN_KEYS=1`）なので、`db.ts` の `PRAGMA foreign_keys = ON` の有無はコンテナ内では確かめられない（I1-4・I1-5 で確かめるのは制約の定義だけ）。`expo-sqlite` は既定で無効なため、実機では E2E で睡眠が入れ替わるときに確かめる
- `src/lib/request-id.ts`・`src/lib/clock.ts`：判定や計算を持たない薄い包み（乱数・現在時刻を返すだけ）のため、単体テストを書かない。使う側のテストでは引数で差し替える

## 6. 実装順
各手順で「失敗するテスト → 最小の実装 → リファクタ」を回す。

1. 設定：`app.json` のプラグイン・権限、開発用の `better-sqlite3`、jest の TZ 固定、パス別名 `@/drizzle/*`
2. 共通ログ：U6（U6-5 を含む）→ `src/lib/logger.ts`。あわせて薄い包みの `src/lib/request-id.ts`・`src/lib/clock.ts`（テストの対象外）
3. 型：`sleep-record.types.ts`（テーブル定義 `sleep-record.schema.ts` は手順4で、テストのあとに作る）
4. DB 接続とテスト用DB：`src/lib/db.ts`・`src/lib/db.types.ts`、テスト用に better-sqlite3 へマイグレーションを適用し `PRAGMA foreign_keys = ON` を実行する補助（`tests/integration/helpers/`）。先に I1-4・I1-5 を書き、テーブルがない（マイグレーションがない）状態で失敗するのを確かめる。そのあと制約（CHECK・FK）まで入れたテーブル定義で `npx drizzle-kit generate` を1回だけ実行してマイグレーションを作る（列だけの版と制約つきの版に分けて生成すると、テーブルを作り直すマイグレーションが余計に残るため）
5. 睡眠の組み立て：U1（U1-16 を含む）→ `sleep-record-session.service.ts`
6. 日ごとの要約と詳細・日付の検証・整形：U2 → `sleep-record-day.service.ts`・`sleep-record-date.service.ts`、U5 → `sleep-record-format.service.ts`
7. DB リポジトリ：I1（I1-4・I1-5 以外）→ `sleep-record.repository.ts`
8. ヘルスケアのリポジトリ：I3-1〜I3-3 → iOS・Android・切り替えの3ファイル
9. 同期：U3 → `sleep-record-sync-range.service.ts`、I2（I2-12b を含む）→ `sleep-record-sync.service.ts`
10. 連携状態と案内：U4 → `sleep-record-guide.service.ts`、I3-4〜I3-6 → `sleep-record-access.service.ts`
11. 読み取りの窓口：I5 → `sleep-record-query.service.ts`
12. マイグレーションの適用：（最初に `useMigrations` が better-sqlite3 で動くか確かめる）I4-11 → `src/lib/migration-gate.tsx`
13. 同期の受け口（画面なし。store は直接、フックは `renderHook` で確かめる）：I4-5・I4-6・I4-6c・I4-6d・I4-6e・I4-6f・I4-7・I4-12・I4-12b → `sleep-record.store.ts`・`use-sleep-record-sync.ts`・`sleep-record-sync-provider.tsx`
14. 一覧と案内：I4-1（詳細へ移ることの確認は、手順15で詳細のルートを作ってから足す）・I4-11b・I4-13b・I4-2・I4-2b・I4-3・I4-4・I4-6b・I4-8・I4-9・I4-13・I4-16・I4-17 → `sleep-record-access-guide.tsx`・`use-sleep-record-list.ts`・`sleep-record-list-screen.tsx`・`src/app/index.tsx`・`src/app/_layout.tsx`
15. 詳細：I4-9b・I4-10・I4-14・I4-15 → `use-sleep-record-detail.ts`・`sleep-record-detail-screen.tsx`・`src/app/sleep/[date].tsx`
16. E2E（実行はエミュレータのある環境で行う。コンテナ内では型チェックとリントまで）。各段階で本体の `npm test`・`npm run lint`・`npx tsc --noEmit` が通ることを確かめる
    - 16a 本体の設定：`app.json`（`android.package`・`ios.bundleIdentifier`）、`tsconfig.json`・`eslint.config.js`・`jest.config.js`・`metro.config.js`（シードアプリを外す）
    - 16b シード定義：`tests/e2e/seed/sleep-seed.js`
    - 16c シードアプリ：`tests/e2e/seed/seeder-app/`（そのフォルダで型チェック・リント）
    - 16d フロー：部品フロー・E1〜E3 のフロー・`tests/e2e/seed/README.md`
17. impl レビューの指摘で追加：`app.json` の `android.allowBackup: false`（コンテナ内では確かめられない。テストの対象外に記載）

## 7. コミット前テスト実行
- `npm test`（単体・中間）
- `npm run lint`
- `npx tsc --noEmit`
- `npx drizzle-kit generate` を実行して、`drizzle/` に差分が出ないこと（テーブル定義とマイグレーションのずれがないこと）
- シードアプリ：`tests/e2e/seed/seeder-app/` で `npx tsc --noEmit`・`npx expo lint`
- E2E（`maestro test --include-tags=android tests/e2e`）は、開発ビルドを入れたエミュレータ・実機で、マージ前に実行できる環境があれば実行する。実行できなかった場合は PR 本文にその旨を書く

## 8. スコープ外
- iOS の iCloud・端末のバックアップから DB を外すこと（2026-11-26 に人間が TODO と判断。`NSURLIsExcludedFromBackupKey` などを実機で確かめる必要があるため TODO。それまで iOS では、利用者がバックアップを有効にしていると DB が iCloud に入りうる。PR 本文にも書く）
- Android で `allowBackup: false` にしたことによる、クラウドのバックアップからの復元（復元されない。睡眠はヘルスケアから取り直せるが、ヘルスケアで読める期間（Android は許可の30日前まで）より前の履歴は戻らない。2026-11-26 に人間が判断）。機種変更時の端末間の直接転送（外部サーバーを通らない）まで止まるかは、Android の版によって違う可能性があるため、最初の実行で確かめる
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

- 並びは「6. 実装順」の手順どおり（tdd はこの順に上から1件ずつ Red → Green にする）。項目の ID は `T` ＋ 3桁の通し番号、「対応」は 5 の新規テストケースの番号
- 共通の前提
  - TZ は `Asia/Tokyo`（`globalSetup` で固定）。時刻はテスト内で `new Date('2026-11-25T06:30:00+09:00').getTime()` のように絶対時刻で書き、現在時刻は引数で渡す（I4 は `jest.setSystemTime('2026-11-25T12:00:00+09:00')`）
  - 中間テストの DB は、better-sqlite3 の一時ファイルに `drizzle/` の実際のマイグレーションを適用し `PRAGMA foreign_keys = ON` を実行したもの（`tests/integration/helpers/`）。各テストの `beforeEach` で新しく作り、`afterEach` で閉じて消す
  - 差し替えるのは 3.3 に挙げた外部I/Oの境界だけ（ネイティブライブラリ・`@/lib/db`・`Platform.OS`・`AppState`・I4-11・I4-11b の `@/drizzle/migrations`）
  - ログは `console.info`／`warn`／`error` を `jest.spyOn` で受け、出力の JSON を `JSON.parse` して検証する
- 画面・フック・store（手順13〜15）では、特に書かない限り、起動時などの同期でネイティブの読み取りモックは DB のシードと同じ睡眠になるサンプルを返す（入れ替え後も同じ `id`・同じ表示になり、シードの行が消えない）
- 「同期中の表示」は文言が 3.1 にないため、案内の判定（U4）では案内の種類（例：`{ kind: 'syncing' }`）を、画面では `testID`（`sleep-record-syncing`）で確かめる
- `requestAccess()` と、そのあとに始める `sync()` は別の操作として、それぞれ `requestId` を作る（3.1 の「新しい `sync()` を始める」に従う）
- T180〜 は test レビューで追加した項目で、手順の節の中に置いたが番号は末尾から振った
- 「期待結果」は値まで書く。「〜になる」とあるものは、その値と一致することを `toEqual`／`toBe` で確かめる

### 手順2 共通ログ（単体）：`tests/unit/lib/logger.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T001 | console をスパイ | `logger.info('a.b', { requestId: 'r1', count: 3 })` | `console.info` が1回、引数は1つの文字列で改行なし、`JSON.parse` すると `{ name: 'a.b', requestId: 'r1', count: 3 }` を含む。`console.warn`・`console.error` は呼ばれない | U6-1 |
| T002 | 同上 | `logger.warn('a.b', {})`・`logger.error('a.b', {})` をそれぞれ呼ぶ | warn は `console.warn` だけ、error は `console.error` だけに1回出る。`name` は `'a.b'` | U6-1 |
| T003 | `new TypeError('boom')` | `logger.error('a.b', { err })` | `err` が `{ type: 'TypeError', message: 'boom', stack: <err.stack と同じ文字列> }` | U6-2 |
| T004 | — | `logger.error('a.b', { err: 'just text' })` | `err.message` が `'just text'` | U6-2 |
| T005 | 睡眠らしい値 `{ startAt: 1764000000000, stage: 'deep' }` と配列 `[1, 2]` | `logger.info('a.b', { data: obj, list: arr })` | `data` と `list` が `"[omitted]"`。出力の文字列に `1764000000000`・`deep` が含まれない | U6-3 |
| T006 | — | `logger.info('a.b', { a: null, b: undefined, c: true, d: 'x' })` | `a` は `null`、`b` のキーがない、`c` は `true`、`d` は `'x'` | U6-4 |
| T197 | Node の `vm.runInNewContext` で作った別の実行環境の `TypeError('boom')` と、同じ作り方で `stack` を消したもの（2ケース）。テストの中で `instanceof Error` が偽であることも確かめる | `logger.error('a.b', { err })` | 前者は `err` が `{ type: 'TypeError', message: 'boom', stack: <その stack と同じ文字列> }`、後者は `err` が `{ type: 'TypeError', message: 'boom' }`（`toEqual`。`stack` のキーがない） | U6-5 |
| T201 | Error の形でないオブジェクト（`it.each`）：`{ message: 98765 }`・`{ message: 'secret-msg-x' }`（`name` なし）・`{ name: 'Error', message: 98765 }`・`{ name: 12345, message: 'secret-msg-x' }`・`{ name: 12345, message: 98765 }`・睡眠らしい値 `{ startAt: 1764000000000, stage: 'deep' }` | `logger.error('a.b', { err })` | どれも `err` が `{ message: '[omitted]' }` で、出力の文字列に `98765`・`secret-msg-x`・`12345`・`1764000000000`・`deep` が含まれない。反対側として、普通のオブジェクト `{ name: 'MyError', message: 'm' }` は `err` が `{ type: 'MyError', message: 'm' }` になる | U6-5 |
| T202 | 整形できない値（`it.each`）：`err` に `Object.create(null)`、`err` に `name` を読むと例外を投げる Proxy、フィールドに `BigInt(1)`、`err` に `BigInt(1)` | `logger.error('a.b', { … })` | どれも例外を投げず、`console.error` に1行出る。`Object.create(null)`・`BigInt` の `err` は `{ message: '[omitted]' }`、フィールドの `BigInt` は `"[omitted]"`、Proxy の場合は `{ name: 'a.b', logFailed: true }` | U6-5 |
| T207 | `err` に数値・真偽値・`null`・`undefined`（`it.each`：`404`・`0`・`false`・`null`・`undefined`） | `logger.error('a.b', { err })` | `err.message` が `'404'`・`'0'`・`'false'`、`null` は `err` が `null`、`undefined` は `err` のキーがない | U6-5 |
| T007 | `stack` を `undefined` にした Error | `logger.error('a.b', { err })` | `err` に `type`・`message` はあり、`stack` のキーがない | U6-4 |

### 手順4 テーブル定義と制約（中間）：`tests/integration/features/sleep-record/sleep-record.schema.test.ts`

テーブルがない状態で失敗することを先に確かめる（4. の手順）。各行は、ほかの列を正しい値にしたうえで1か所だけを崩して `INSERT` する。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T008 | 正しい睡眠1件とそのステージ2件 | 正しい値で挿入する（対照） | 例外なく入り、件数が睡眠1・ステージ2 | I1-5 |
| T009 | 同上 | 睡眠を `DELETE` する | その睡眠のステージが0件になる（CASCADE。PRAGMA が効いている） | I1-4 |
| T010 | — | `sleep_sessions` に `end_at = start_at`、`end_at < start_at` をそれぞれ挿入 | どちらも制約違反で失敗し、行が増えない | I1-5 |
| T011 | — | `sleep_sessions` に `asleep_minutes = 0`、`has_stages = 2`、`wake_date = '2026/11/25'` をそれぞれ挿入 | それぞれ制約違反で失敗する。`asleep_minutes = 1`・`has_stages = 0`／`1`・`wake_date = '2026-11-25'` は入る（境界の反対側） | I1-5 |
| T012 | — | `sleep_sessions` の `id`・`source_id`・`start_at`・`end_at`・`wake_date`・`asleep_minutes`・`has_stages` を1列ずつ NULL にして挿入 | 7件とも失敗する（`id` は text の主キーで、SQLite は NOT NULL がないと NULL を受け入れるため、生成されたマイグレーションに `PRIMARY KEY NOT NULL` が入っていることもあわせて確かめる） | I1-5 |
| T013 | 睡眠1件 | `sleep_stages` に `stage = 'inBed'`、`end_at = start_at`、`end_at < start_at`、存在しない `session_id`、`session_id`・`stage`・`start_at`・`end_at` の NULL をそれぞれ挿入 | すべて失敗する。`stage` が5種（`awake`・`light`・`deep`・`rem`・`unspecified`）のときは入る | I1-5 |
| T014 | — | `sleep_sync_state` に `id = 2`、`last_synced_at = NULL` をそれぞれ挿入 | どちらも失敗する。`id = 1` は入り、2行目の `id = 1` は PK で失敗する | I1-5 |

### 手順5 睡眠の組み立て（単体）：`tests/unit/features/sleep-record/sleep-record-session.service.test.ts`

重なり排除の項目（T034〜T045）は、特に書かない限り Android の別々の SleepSession で作る（iOS で同じ記録元だと手順2で1つにまとまり、前提を作れないため）。代わりの ID・記録元（T047・T048・T181）は、ID・記録元が欠けたままのセグメントを受け取った組み立てサービスが付ける（U1-15 の置き場所に合わせる）。セグメントは `{ id, sourceId, stage, startAt, endAt }`（Android は所属する SleepSession の ID・`startTime`/`endTime` つき）で直接作って渡す。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T015 | — | 空の配列を組み立てる | 睡眠0件 | U1-13 |
| T016 | iOS・同じ記録元。`light` 23:00–23:30 と 23:30–23:30（長さ0）と 2:00–1:00（前後が逆）と `deep` 23:30–1:00 | 組み立てる | 睡眠1件、就寝 23:00・起床 1:00、ステージ区間は `light` 23:00–23:30・`deep` 23:30–1:00 の2件（長さ0・逆のものは入らない） | U1-0 |
| T017 | iOS・同じ記録元。A 23:00–1:00、B 1:30–6:00（空きちょうど30分） | 組み立てる | 睡眠1件、就寝 23:00・起床 6:00 | U1-1 |
| T018 | iOS・同じ記録元。A 23:00–1:00、B 1:30:00.001–6:00（空き30分1ミリ秒） | 組み立てる | 睡眠2件（23:00–1:00 と 1:30:00.001–6:00） | U1-1 |
| T019 | iOS・同じ記録元。A 23:00–3:00、B 1:00–6:00（重なる）／A 23:00–6:00、B 1:00–2:00（含まれる） | それぞれ組み立てる | どちらも睡眠1件。前者は就寝 23:00・起床 6:00、後者は就寝 23:00・起床 6:00（B の終了 2:00 ではない） | U1-2 |
| T020 | iOS・同じ記録元。A 23:00–3:00、C 1:00–1:30（A に含まれる）、B 3:20–6:00。直前の C の終了からは空き1時間50分だが、それまでの最も遅い終了（A の 3:00）からは20分 | 組み立てる | 睡眠1件、就寝 23:00・起床 6:00（直前のセグメントの終了で測ると2件に割れる誤りを検出する） | U1-1・U1-2 |
| T021 | iOS・記録元 `a` の 23:00–1:00 と記録元 `b` の 1:10–6:00（空き10分） | 組み立てる | 重なりがないので睡眠2件、記録元はそれぞれ `a`・`b` | U1-2b |
| T022 | T017 と同じセグメントを、配列の順を逆・ばらばらにして渡す | 組み立てる | T017 と同じ結果（睡眠1件、就寝 23:00・起床 6:00、同じステージ区間）。未整列の入力でも開始時刻順に並べてから判定する | U1-1（未整列） |
| T023 | Android・同じ SleepSession（`startTime` 22:00・`endTime` 7:00）に `light` 23:00–1:00 と `deep` 3:00–6:00（空き2時間） | 組み立てる | 睡眠1件、就寝 23:00・起床 6:00（`startTime`/`endTime` ではない）。区間は2件、睡眠時間 300分 | U1-3 |
| T024 | Android・SleepSession 23:00–6:00 のステージが `light` 1:00–1:00 と `deep` 2:00–1:00 だけ | 組み立てる | 睡眠1件、就寝 23:00・起床 6:00、区間は `unspecified` 23:00–6:00 の1件、ステージなし | U1-3b |
| T190 | Android・SleepSession 23:00–6:00 のステージが `light` 23:00–1:00 と `deep` 2:00–2:00（長さ0） | 組み立てる | 区間は `light` 23:00–1:00 の1件だけで、セッション全体の `unspecified` にはしない。就寝 23:00・起床 1:00、ステージあり | U1-3b |
| T025 | Android・ステージなしで SleepSession 自体が 6:00–6:00、もう1件が 6:00–5:00 | 組み立てる | 睡眠0件 | U1-3b |
| T026 | 1つの睡眠（覚醒以外の区間はどれも1時間）に：`awake` 1時間＋`unspecified` 1時間／`unspecified` 1時間＋`rem` 1時間／`light` 1時間だけ／`deep` 1時間だけ | それぞれ組み立てる | 1つ目は `hasStages: false`、残り3つは `hasStages: true`（どれも睡眠1件で残る） | U1-3c |
| T027 | 同じ睡眠で `unspecified` 0:00–2:00 と `deep` 1:00–3:00 | 組み立てる | 区間 `unspecified` 0:00–1:00・`deep` 1:00–3:00、睡眠時間 180分（240分ではない） | U1-4 |
| T028 | 同じ睡眠で `deep` 0:00–2:00 と `rem` 1:00–3:00／`rem` 0:00–2:00 と `light` 1:00–3:00 | それぞれ組み立てる | 前者は `deep` 0:00–2:00・`rem` 2:00–3:00、後者は `rem` 0:00–2:00・`light` 2:00–3:00。どちらも睡眠時間 180分 | U1-4 |
| T029 | 同じ睡眠で `light` 0:00–2:00 と `awake` 1:00–3:00／`unspecified` 0:00–2:00 と `awake` 1:00–3:00 | それぞれ組み立てる | 前者は `light` 0:00–2:00・`awake` 2:00–3:00 で睡眠時間 120分。後者は `unspecified` 0:00–1:00・`awake` 1:00–3:00 で睡眠時間 60分（`awake` が `unspecified` より優先） | U1-4b |
| T030 | 同じ睡眠で `deep` 0:00–3:00 と、それに完全に含まれる `unspecified` 1:00–2:00 | 組み立てる | 区間は `deep` 0:00–3:00 の1件だけ（長さ0の区間がない） | U1-4c |
| T031 | 同じ睡眠で `light` 0:00–1:00 と `light` 1:00–2:00（隣接）、および `light` 0:00–1:00・`deep` 0:30–0:40・`light` 0:40–2:00 | それぞれ組み立てる | 前者は `light` 0:00–2:00 の1件。後者は `light` 0:00–0:30・`deep` 0:30–0:40・`light` 0:40–2:00 の3件（同じステージでも隣接しないものはつながない）。iOS で `light` 0:00–1:00 と `light` 1:10–2:00（空き10分）をまとめた睡眠は、区間が2件のままで睡眠時間 110分（空きを挟んでつながない） | U1-4c |
| T032 | `light` が 7時間32分59秒、`awake` が 30分 | 組み立てる | 睡眠時間 452分 | U1-5 |
| T193 | 1つの睡眠に `awake` 23:00–23:20、`light` 23:20–6:00、`awake` 6:00–6:10 | 組み立てる | 就寝 23:00・起床 6:10（覚醒のセグメントも範囲に入る）、睡眠時間 400分 | U1-5 |
| T033 | `awake` だけの睡眠／`light` 59秒＋`awake` 1時間／`light` ちょうど60秒＋`awake` 1時間 | それぞれ組み立てる | 1つ目・2つ目は睡眠0件。3つ目は睡眠1件で睡眠時間 1分 | U1-6 |
| T034 | 記録元 `a` のステージなし 6時間と、重なる記録元 `b` のステージあり 5時間 | 組み立てる | `b` の睡眠だけ残る（短くてもステージありが先） | U1-7 |
| T035 | 重なる2件、両方ステージあり。X は 301分・記録元 `com.b`・就寝 23:10・`id = 'b'`、Y は 300分・記録元 `com.a`・就寝 23:00・`id = 'a'`（下位の基準はすべて Y が勝つ向き） | 組み立てる | X だけ残る（睡眠時間が記録元・就寝・`id` より先） | U1-8 |
| T036 | 重なる2件、両方ステージなし。T035 と同じ置き方（301分の側が下位の基準ではすべて負ける） | 組み立てる | 301分のほうだけ残る | U1-8 |
| T037 | 重なる2件、両方ステージあり・同じ睡眠時間。X は記録元 `com.a`・就寝 23:10・`id = 'b'`、Y は `com.b`・就寝 23:00・`id = 'a'` | 組み立てる | X（`com.a`）だけ残る（記録元が就寝・`id` より先） | U1-8 |
| T038 | 重なる2件、ステージあり・睡眠時間・記録元が同じ。X は就寝 23:00・`id = 'b'`、Y は就寝 23:10・`id = 'a'` | 組み立てる | X（就寝 23:00）だけ残る（就寝が `id` より先） | U1-8 |
| T039 | 重なる2件、ステージあり・睡眠時間・記録元・就寝が同じで、`id` が `b` と `a` | 組み立てる | `id = 'a'` だけ残る | U1-8 |
| T040 | Android・同じ記録元 `com.soxai` で重なる SleepSession 2件、両方ステージあり。`hc-1` は 300分・就寝 23:00、`hc-2` は 301分・就寝 23:10 | 組み立てる | `id = 'hc-2'` の1件だけ残る（睡眠時間が就寝・`id` より先） | U1-9 |
| T189 | Android・同じ記録元 `com.soxai` の別々の SleepSession 2件、23:00–1:00 と 1:10–6:00（重ならず、空き10分） | 組み立てる | 睡眠2件のまま（30分以内をまとめるのは iOS だけ） | U1-3 |
| T041 | Android の別々の SleepSession（記録元は別）。A 22:00–1:00、B 0:30–3:30、C 3:00–6:00（各180分。A–B・B–C が重なり A–C は重ならない）。ステージありは B だけ | 組み立てる | B だけ残る（B が最優先で、A・C は B と重なる） | U1-10 |
| T042 | 同じく A 22:00–1:00（180分）、B 0:30–3:20（170分）、C 3:00–5:59（179分）。3件ともステージあり | 組み立てる | A と C が残る（順位は A・C・B。B は A と重なるので落ち、C は A と重ならない） | U1-10 |
| T195 | 同じく A 22:00–1:00（180分）、B 0:30–3:29（179分）、C 3:00–5:50（170分）。3件ともステージあり（順位は A・B・C） | 組み立てる | A と C が残る（先頭から順に「残した睡眠と重ならなければ残す」。B は A と重なるので落ち、C は落ちた B とは比べない。「自分より上位と重なれば落とす」方式だと A だけになり、見分けられる） | U1-10 |
| T043 | T041 の3件を配列の順を入れ替えて渡す | 組み立てる | T041 と同じく B だけ残る（入力順に左右されない） | U1-10（未整列） |
| T044 | Android の別々の SleepSession、記録元が違う A 23:00–3:00 と B 3:00–6:00（終了と開始が同時刻） | 組み立てる | 2件とも残る（重なりとみなさない） | U1-11 |
| T045 | 記録元が違う睡眠 A 23:00–3:00:00.001（ステージあり・240分）と B 3:00–6:00（ステージあり・180分）。1ミリ秒重なる | 組み立てる | A だけ残る | U1-11 |
| T046 | `2026-11-24T23:30+09:00` 就寝・`2026-11-25T06:30+09:00` 起床／起床 `2026-11-24T23:59:59.999+09:00`／起床 `2026-11-25T00:00:00.000+09:00` | それぞれ組み立てる | 帰属日は順に `2026-11-25`・`2026-11-24`・`2026-11-25` | U1-12 |
| T047 | iOS で記録元が `undefined`／空文字、UUID が `undefined`／空文字のサンプル（開始 S・終了 E。4通りの組み合わせを `it.each`） | 組み立てる | 記録元が欠けたら `sourceId` は `unknown`、UUID が欠けたら `id` は `<sourceId>:<S>:<E>`（両方欠けたら `unknown:<S>:<E>`）。同じ入力でもう1回組み立てても同じ `id` | U1-15 |
| T181 | iOS・記録元 `com.soxai` で、UUID が空文字の先頭サンプル（S1–E1）と UUID `u9` の後続サンプル（S2–E2）が1つの睡眠になる | 組み立てる | 睡眠の `id` は `com.soxai:<S1>:<E1>`（代わりの ID はセグメントごとに、そのセグメントの時刻で付ける。睡眠全体の時刻 S1–E2 ではない） | U1-15・U1-14 |
| T048 | Android で `metadata.id`・`dataOrigin` が `undefined`／空文字の SleepSession | 組み立てる | `sourceId` は `unknown`、`id` は `unknown:<startTime>:<endTime>`。記録元だけあれば `<記録元>:<startTime>:<endTime>`。`metadata.id = 'hc-1'` で `dataOrigin` だけ `undefined` なら `id` は `hc-1`、`sourceId` は `unknown` | U1-15 |
| T049 | iOS・同じ記録元 `com.soxai` の3サンプル（UUID `u2` 23:00 開始、`u1` 23:00 開始、`u0` 1:00 開始） | 組み立てる | 睡眠の `id` は `u1`（開始が最も早い中で辞書順で先）、`sourceId` は `com.soxai` | U1-14 |
| T208 | Android で、ステージがすべて長さ0の7時間のセッション（A）と、正の長さのステージが3件のセッション（B）。別に、A のセッション自体も長さ0のもの、前後が逆（`startTime` > `endTime`）のもの。iOS で、長さ0のサンプル1件と正のサンプル2件（`it.each`） | `countValidSegments` | A＋B は4、A（長さ0）＋B は3、A（前後が逆）＋B は3、iOS は2 | U1-16 |
| T050 | Android・`metadata.id = 'hc-1'`・`dataOrigin = 'com.soxai'` | 組み立てる | `id` は `hc-1`、`sourceId` は `com.soxai` | U1-14 |

### 手順6 日ごとの要約と詳細（単体）：`tests/unit/features/sleep-record/sleep-record-day.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T051 | 帰属日 `2026-11-25` に、就寝 `15:00` の 30分、就寝 `2026-11-24T23:00` の 420分、就寝 `12:00` の 60分を、この順で渡す | 1日の詳細を作る | 主睡眠は 420分、昼寝は 12:00 の 60分・15:00 の 30分の順。昼寝を 12:00 の 30分・15:00 の 60分に変えても、昼寝は 12:00・15:00 の順（睡眠時間の順ではない） | U2-1 |
| T052 | 帰属日 `2026-11-25` に 300分の睡眠2件（就寝 `2026-11-25T13:00` のものを先、`2026-11-24T22:00` のものを後に渡す） | 1日の詳細を作る | 主睡眠は就寝 `2026-11-24T22:00` のもの、昼寝は `2026-11-25T13:00` のもの | U2-1 |
| T053 | T051 のデータ | 日ごとの要約一覧を作る | `2026-11-25` の合計睡眠時間 510分、昼寝の件数 2、主睡眠の就寝・起床が 420分の睡眠のもの | U2-2 |
| T054 | 帰属日 `2026-11-23`・`2026-11-25`・`2026-11-24` の睡眠を、この順（未整列）で渡す | 日ごとの要約一覧を作る | `2026-11-25`・`2026-11-24`・`2026-11-23` の順の3行。睡眠のない `2026-11-22` などの行はない | U2-3（未整列） |
| T055 | 睡眠0件 | 日ごとの要約一覧を作る | 空の配列 | U2-3 |
| T056 | 主睡眠の区間：`deep` 90分・`light` 200分・`rem` 80分・`awake` 20分・`unspecified` 10分。昼寝に `deep` 30分 | 1日の詳細を作る | 内訳は深い 90分 23%・浅い 200分 50%・REM 80分 20%・覚醒 20分 5%・不明 10分 3% の順（分母 400分）。昼寝の `deep` は含まれない | U2-4 |
| T057 | 主睡眠の区間：`light` 238分、`rem` 59秒、`awake` ちょうど60秒（合計 239分59秒） | 1日の詳細を作る | 行は浅い 238分 99%・覚醒 1分 0% の2行で、REM の行はない。分母は 239分59秒（REM の59秒を含む。含めないと浅いは 100% になる） | U2-4 |
| T058 | iOS でまとめた主睡眠：区間の合計6時間（`light` 6時間）、区間のない空き20分 | 1日の詳細を作る | 浅い 360分・100%（分母は 360分で、空き20分は入らない） | U2-4b |
| T059 | 分母 400分に対し 50分（12.5%）と 49.6分（12.4%）のステージ | 1日の詳細を作る | 前者 13%、後者 12% | U2-5 |
| T060 | ステージなしの主睡眠 | 1日の詳細を作る | 内訳が `null`（ステージありで出す行がないときの空配列 `[]` と区別する） | U2-6 |
| T191 | ステージありの主睡眠で、区間が `light` 59秒・`deep` 59秒だけ（睡眠時間 1分） | 1日の詳細を作る | 内訳が空配列 `[]`（ステージなしの `null` とは別の値） | U2-4 |
| T061 | `2026-11-24` にだけ睡眠 | `2026-11-25` の詳細を作る | 「データなし」の結果 | U2-7 |

### 手順6 日付の検証（単体）：`tests/unit/features/sleep-record/sleep-record-date.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T062 | — | `2026-11-25`・`2028-02-29`・`2000-02-29`・`2026-11-30`・`2026-12-31`・`2026-01-01`・`2026-02-28` を検証（`it.each`） | 7件とも正しく、同じ文字列の帰属日が返る（T063 の不正な側と対になる境界） | U2-8 |
| T063 | — | `2026-02-29`・`2100-02-29`・`2026-02-30`・`2026-11-31`・`2026-12-32`・`2026-00-10`・`2026-13-01`・`2026-11-00` を検証（`it.each`） | すべて不正（実在しない日付） | U2-8 |
| T064 | — | `abc`・`2026-1-5`・`2026-11-250`・`2026-11-25T00:00`・空文字を検証（`it.each`） | すべて不正（形式違い） | U2-8 |
| T065 | — | `undefined`・`['2026-11-25']` を検証 | どちらも不正 | U2-8 |

### 手順6 表示の整形（単体）：`tests/unit/features/sleep-record/sleep-record-format.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T066 | — | 分 452・60・59・45・0 を整形 | 「7時間32分」「1時間0分」「59分」「45分」「0分」 | U5-1 |
| T067 | TZ `Asia/Tokyo` | `2026-11-24T23:14+09:00`・`2026-11-25T00:05+09:00`・`2026-11-25T09:00+09:00` の UNIX ミリ秒を整形 | 「23:14」「0:05」「9:00」 | U5-2 |
| T068 | 現在日 `2026-11-25` | 帰属日 `2026-11-25`・`2025-11-25` を整形 | 「11月25日（水）」「2025年11月25日（火）」 | U5-3 |
| T069 | 現在日 `2026-12-31`／`2027-01-01` | 帰属日 `2026-12-31` と `2027-01-01` をそれぞれの現在日で整形 | 現在日 `2026-12-31` では「12月31日（木）」「2027年1月1日（金）」、現在日 `2027-01-01` では「2026年12月31日（木）」「1月1日（金）」 | U5-3 |

### 手順7 DB リポジトリ（中間）：`tests/integration/features/sleep-record/sleep-record.repository.test.ts`

範囲の開始を `R = 2026-11-18T12:00+09:00` とする。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T070 | DB に起床 `R − 1ms`・`R`・`R + 1日` の睡眠（重ならない）と、同期記録 `last_synced_at = R − 3日` | 範囲の開始 `R`・同期開始時刻 `T` で、新しい睡眠1件（`R + 2日` 起床）を入れ替える | 起床 `R − 1ms` の睡眠は残り、`R`・`R + 1日` は消え、新しい1件が入る。同期記録は1行のままで `last_synced_at = T`（上書き） | I1-1 |
| T071 | DB に起床 `R − 3日`・`id = 'x'` の睡眠 | 同じ `id = 'x'` で起床 `R + 1日` の睡眠を入れ替える | 例外なく、`id = 'x'` は新しい値の1件だけ | I1-2 |
| T072 | DB に範囲より前の睡眠 P1（採用する睡眠と1ミリ秒重なる）と P2（終了が採用する睡眠の開始とちょうど同じ） | 入れ替える | P1 は消え、P2 は残る | I1-3 |
| T183 | DB に範囲より前の睡眠 P1（ステージあり・480分）。採用する睡眠はステージなし・300分で、P1 と時間が重なる | 入れ替える | P1 は消え、採用する睡眠が入る（組み立ての順位づけを使わず、今回読んだ睡眠を残す） | I1-3 |
| T073 | DB に起床 `R + 1日` の睡眠とステージ3件 | 入れ替える | 消えた睡眠のステージ区間が0件（ほかの睡眠のステージは残る） | I1-4 |
| T074 | DB に睡眠・ステージ・同期記録。テスト用DBに `sleep_stages` への挿入を `RAISE(ABORT)` するトリガー | 入れ替える | 例外が投げられ、睡眠・ステージ区間・同期記録の全行が入れ替え前と一致する | I1-6 |
| T075 | 帰属日 `2026-11-24` に睡眠 `s24`、`2026-11-25` に `s25a`・`s25b`（ステージ区間つき） | 日ごとの取得・`2026-11-25` の取得・有無を呼ぶ | 日ごとは `s24`・`s25a`・`s25b` の3件（`id` の集合が一致）、指定日は `s25a`・`s25b` とそのステージ区間だけ、有無は「あり」 | I1-7 |
| T076 | DB が空 | 同上 | 日ごとは空、指定日は空、有無は「なし」。同期記録の読み取りは「なし」 | I1-7 |

### 手順8 ヘルスケアのリポジトリ（中間）：`tests/integration/features/sleep-record/sleep-record-health.repository.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T077 | HealthKit のモックが `awake`・`asleepCore`・`asleepDeep`・`asleepREM`・`asleepUnspecified`・`inBed`・表にない値 `99` を1件ずつ返す | iOS でセグメントを読む | 順に `awake`・`light`・`deep`・`rem`・`unspecified` に変わり、`inBed` はなく、`99` は `unspecified`。未知の値の件数 1 | I3-1 |
| T078 | 同上 | iOS でセグメントを読む（期間 S〜E） | `queryCategorySamples` に `HKCategoryTypeIdentifierSleepAnalysis`、`limit: 0`、`filter.date` の `startDate: S`・`endDate: E` が渡る | I3-1 |
| T079 | `isHealthDataAvailable` が false | iOS の連携状態を取る | `unavailable` | I3-1b |
| T080 | `getRequestStatusForAuthorization` が `shouldRequest`／`unnecessary`／`unknown`（`it.each`） | iOS の連携状態を取る | 順に `notRequested`・`ready`・`ready`。渡る引数は `toRead` が睡眠だけで `toShare` は空／なし（T125 と同じ） | I3-1b |
| T081 | ヘルスコネクトのモックが `AWAKE`・`OUT_OF_BED`・`LIGHT`・`DEEP`・`REM`・`SLEEPING`・`UNKNOWN`・表にない値を持つ SleepSession（`metadata.id = 'hc-1'`・`dataOrigin = 'com.soxai'`、先頭のステージは `startTime: '2026-11-24T14:00:00.000Z'`・`endTime: '2026-11-24T15:00:00.000Z'`）と、ステージなしの SleepSession を返す | Android でセグメントを読む | 順に `awake`・`awake`・`light`・`deep`・`rem`・`unspecified`・`unspecified`・`unspecified`。先頭のセグメントは開始 `1795528800000`（JST 23:00）・終了 `1795532400000`、セッション ID `hc-1`・記録元 `com.soxai`。ステージなしはセッション全体の `unspecified` 1件。未知の値の件数 1 | I3-2 |
| T082 | `readRecords` が1ページ目で `pageToken: 'p2'`、2ページ目で `pageToken: undefined` を返す／1ページ目で `pageToken: ''` を返す | Android で読む（期間 S〜E） | 前者は2回呼ばれ、2回目に `pageToken: 'p2'` が渡り、両ページ分が返る。後者は1回で打ち切る。どちらも `timeRangeFilter` が `{ operator: 'between', startTime: S, endTime: E }` | I3-2 |
| T083 | `getSdkStatus` が `SDK_UNAVAILABLE`／`SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED`（`it.each`） | Android の連携状態を取る | 順に `unavailable`・`updateRequired` | I3-2b |
| T084 | `SDK_AVAILABLE`・`initialize` true。`getGrantedPermissions` が `[{ accessType: 'read', recordType: 'SleepSession' }]`／`[{ accessType: 'write', recordType: 'SleepSession' }]`／`[{ accessType: 'read', recordType: 'HeartRate' }]`／`[]`（`it.each`） | Android の連携状態を取る | 1つ目だけ `ready`、残り3つは `notGranted` | I3-2b |
| T085 | `getSdkStatus` が表にない値 `99` | Android の連携状態を取る | 例外が投げられる | I3-2b |
| T086 | 両方のモックを用意 | `os: 'ios'`・`os: 'android'` で読み取りを呼ぶ | `ios` では `queryCategorySamples` だけ、`android` では `readRecords` だけが呼ばれる | I3-3 |

### 手順9 取り込み範囲（単体）：`tests/unit/features/sleep-record/sleep-record-sync-range.service.test.ts`

`now = 2026-11-25T12:00+09:00`、`D = 24時間` とする。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T087 | 同期記録なし | 範囲を計算 | 開始 `now − 90D`、終了 `now` | U3-1 |
| T088 | 前回 `now − 3D` | 範囲を計算 | 開始 `now − 7D` | U3-2 |
| T089 | 前回 `now − 7D`／`now − 7D − 1ms` | 範囲を計算 | 前者は `now − 7D`、後者は `now − 7D − 1ms` | U3-3 |
| T090 | 前回 `now − 20D` | 範囲を計算 | 開始 `now − 20D` | U3-4 |
| T091 | 前回 `now − 90D`／`now − 90D + 1ms`／`now − 90D − 1ms` | 範囲を計算 | 順に `now − 90D`・`now − 90D + 1ms`・`now − 90D` | U3-5 |
| T092 | 前回 `now − 120D` | 範囲を計算 | 開始 `now − 90D` | U3-6 |
| T093 | 前回 `now + 2D`（未来） | 範囲を計算 | 開始 `now − 7D` | U3-7 |
| T094 | 前回 `now − 20D` | ヘルスケアの読み取り開始を計算 | `now − 21D`（範囲の開始 − 24時間） | U3-8 |
| T095 | 範囲の開始 `R` | 起床 `R`・`R − 1ms` の睡眠を判定 | 前者は採用、後者は採用しない | U3-9 |

### 手順9 同期（中間）：`tests/integration/features/sleep-record/sleep-record-sync.service.test.ts`

`getNow` は1回の同期で開始・終了の2回呼ばれる。各同期の開始は項目に書いた時刻（書いていなければ `now`）、終了はその `+ 1234ms` を返す関数を渡す（2回同期する項目は、2回目の開始を項目に書く。T108 の2回目は `now + 1D`）。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T096 | DB 空・同期記録なし。HealthKit のモックが3件の睡眠になるサンプルを返す。そのうち1件は記録元 `com.soxai` の4サンプル：`u1` `asleepCore` `2026-11-24T23:00`–`2026-11-25T01:00`、`u2` `asleepDeep` 01:00–02:00、`u3` `awake` 02:00–02:10、`u4` `asleepREM` 02:10–06:30（`+09:00`） | `os: 'ios'` で同期 | `queryCategorySamples` の `startDate` が `now − 91D`、`endDate` が `now`。DB に睡眠3件、同期記録が `now`。4サンプルの睡眠は `id = 'u1'`・`source_id = 'com.soxai'`・`start_at = 1795528800000`・`end_at = 1795555800000`・`wake_date = '2026-11-25'`・`asleep_minutes = 440`・`has_stages = 1`、ステージ区間は `light` 23:00–01:00・`deep` 01:00–02:00・`awake` 02:00–02:10・`rem` 02:10–06:30 の4行 | I2-1・I2-3d |
| T097 | このテストの中で1回目の同期（`now`）を行う。モックは起床 `now − 1D`（A）・`now − 2D`（B）・`now − 3D`（C）と `now − 10D`（D）の4件を返す。2回目の同期（`now + 1D`。範囲の開始は `now − 6D`）では、モックは A を返さず、B の起床を30分遅らせ、C はそのまま、D も返さない | `now + 1D` で2回目の同期 | DB の睡眠は B・C・D の計3件。A はなく、B はその `id` の行が1行だけで新しい起床時刻、D は範囲外なのでモックが返さなくても残る。同期記録は `now + 1D` | I2-2 |
| T098 | 同期記録 `now − 20D` | 同期 | 読み取りの `startDate` が `now − 21D`、`endDate` が `now`（`min(前回, now − 7D) − 24時間`） | I2-3d |
| T099 | DB に睡眠と同期記録。`queryCategorySamples` が reject する | 同期 | 呼び出し元に同じエラーが届く。DB の睡眠と同期記録は変わらない。`sleepRecord.sync` の error ログ（`requestId`・`err`） | I2-3 |
| T100 | `os: 'android'`。DB に睡眠と同期記録。(a) `readRecords` の1ページ目は成功（`pageToken: 'p2'`）、2ページ目が reject、(b) 1ページ目が reject（2ケース） | 同期 | どちらも reject させたエラーと同じもの（`toBe`）が届き、DB の睡眠と同期記録は変わらず、`sleepRecord.sync` の error ログが出る | I2-3b |
| T101 | `os: 'android'`。SleepSession 2件（重ならない）：`hc-1`（`dataOrigin = 'com.soxai'`、ステージ `LIGHT` `2026-11-24T14:00:00.000Z`–`2026-11-24T21:30:00.000Z`）と `hc-2` | 同期 | DB に睡眠2件。`hc-1` は `source_id = 'com.soxai'`・`start_at = 1795528800000`・`end_at = 1795555800000`・`wake_date = '2026-11-25'`・`asleep_minutes = 450` | I2-3c |
| T102 | `os: 'android'`。`metadata.id`・`dataOrigin` のない、ステージなしの SleepSession（`startTime` S・`endTime` E） | 同期 | 成功し、`id = 'unknown:<S のUNIXミリ秒>:<E のUNIXミリ秒>'`・`source_id = 'unknown'` で保存される | I2-3e |
| T103 | 同期記録なし。睡眠3件になるセグメント計12件 | 同期 | `sleepRecord.sync` の info ログが `{ requestId, rangeDays: 90, segmentCount: 12, savedCount: 3, replaced: true, ms: 1234 }`。ログの文字列に睡眠の時刻（UNIX ミリ秒・ISO 文字列）・ステージ名・帰属日が含まれない | I2-4・I2-7 |
| T182 | 同期記録 `now − 7D − 5時間`（範囲の開始が前回の同期開始時刻になる） | 同期 | info ログの `rangeDays` が `7.2`。同期記録 `now − 7D − 3時間`（7.125日）なら `7.1`、`now − 7D − 1.2時間`（7.05日）なら `7.1`（.05 は切り上げ） | I2-4 |
| T104 | DB に睡眠と同期記録。テスト用DBに `sleep_stages` への挿入を `RAISE(ABORT)` で失敗させるトリガーを、この項目の中で作る（DB のエラーメッセージにクエリの値が入りうる経路） | 同期 | error ログの文字列に、入力した睡眠の時刻（UNIX ミリ秒・ISO 文字列）・ステージ名・帰属日が含まれない（通らなければ作業を止め、ログの `err` の扱いを相談する） | I2-4 |
| T105 | DB に睡眠と同期記録。モックが0件 | 同期 | 成功し、DB の睡眠と同期記録は変わらない。info ログに `replaced: false`・`segmentCount: 0`・`savedCount: 0`・`rangeDays`（前提の同期記録から計算した値）・`ms: 1234` | I2-5 |
| T106 | DB に睡眠と同期記録。テスト用DBに `sleep_stages` 挿入を `RAISE(ABORT)` するトリガー | 同期 | DB が投げたエラーと同じもの（`toBe`）が届き、`sleepRecord.sync` の error ログ、DB の睡眠・ステージ・同期記録は変わらない | I2-6 |
| T107 | 同期記録 `now − 3D`（範囲の開始 `R = now − 7D`）。iOS サンプルが `R − 2時間`〜`R` と `R`〜`R + 6時間` | 同期 | 睡眠1件で、就寝 `R − 2時間`・起床 `R + 6時間` | I2-8 |
| T108 | 同期記録なし。モックが0件 | `now` と `now + 1D` で同期を2回 | 同期記録は書かれず、2回目の読み取り開始は `(now + 1D) − 91D`（初回扱いのまま） | I2-9 |
| T109 | DB に範囲内の睡眠1件。範囲の開始より前に起床する睡眠になるセグメントだけ／`awake` だけのセグメントが返る（2ケース） | 同期 | どちらも範囲内の DB の睡眠が消え、同期記録が `now` になる。info ログに `replaced: true`・`savedCount: 0` | I2-11 |
| T198 | Android。DB に範囲内の睡眠1件（`id` `old-1`、起床 `now − 1D`、`has_stages = 1`）と同期記録（`now − 3D`）。モックは、ステージがすべて長さ0（各ステージの `startTime` = `endTime`）の SleepSession A（就寝 `now − 1D − 7時間`・起床 `now − 1D`）と、正の長さのステージが3件の SleepSession B（起床 `now − 2D`）を返す | 同期 | `old-1` の行は消え、DB の範囲内の睡眠は A（同じ就寝〜起床、`has_stages = 0`、`unspecified` の1区間）と B の2件になり、同期記録が今回の同期開始時刻になる。info ログに `segmentCount: 4`・`savedCount: 2`・`replaced: true` | I2-12b |
| T203 | T198 と同じ DB。モックは SleepSession A だけで、A 自体も長さ0（`startTime` = `endTime`）／前後が逆（`startTime` > `endTime`）の2ケース（`it.each`） | 同期 | どちらも DB の睡眠（`old-1`）と同期記録（`now − 3D`）は変わらない。info ログに `segmentCount: 0`・`savedCount: 0`・`replaced: false` | I2-12b |
| T110 | DB に睡眠と同期記録。モックが `inBed` だけ／長さ0のサンプルだけを返す（2ケース） | 同期 | どちらも DB と同期記録は変わらない。info ログに `segmentCount: 0`・`savedCount: 0`・`replaced: false` | I2-12 |
| T111 | モックが表にない値 `99` のサンプルを2件含む | 同期 | `sleepRecord.fetchFromHealth` の warn ログ `{ requestId, unknownCount: 2 }`。ログの文字列に `99` が含まれない | I2-10 |
| T112 | 表にない値なし | 同期 | `sleepRecord.fetchFromHealth` のログが出ない | I2-10 |

### 手順10 案内の判定（単体）：`tests/unit/features/sleep-record/sleep-record-guide.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T113 | 睡眠なし・同期中でない・同期失敗なし | 起きる組み合わせで判定（`it.each`）：iOS の `unavailable`・`notRequested`・`checkFailed`、Android の `unavailable`・`updateRequired`・`notGranted`・`checkFailed` | それぞれ 3.1 の表の案内1つだけ（文言の全文とボタンの種類が一致。`notGranted` は連携ボタンと設定を開くボタンの両方）。「睡眠データがありません」を含まない | U4-1 |
| T114 | `ready`・睡眠あり（iOS・Android の両方） | 判定 | どちらも案内なし（空） | U4-2 |
| T115 | `ready`・睡眠なし・同期中でない | iOS／Android で判定 | iOS は「睡眠データがありません。許可していない場合は、設定 → …」、Android は「睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください」（3.1 の全文と一致） | U4-3 |
| T116 | `ready`・睡眠なし・同期失敗（iOS・Android の両方） | 判定 | 「睡眠データの取り込みに失敗しました」（再試行つき）と、その OS の睡眠なしの案内（3.1 の全文と一致）の2つ | U4-4 |
| T117 | `ready`・睡眠あり・同期失敗 | 判定 | 失敗の表示1つだけ | U4-5 |
| T118 | 睡眠あり。T113 と同じ `ready` 以外の7組み合わせ（`it.each`） | 判定 | それぞれその状態の案内だけ（睡眠なしの案内はない） | U4-6 |
| T188 | 前回の同期失敗あり・同期中でない。T113 と同じ `ready` 以外の7組み合わせ（`it.each`）、睡眠なし／あり | 判定 | 失敗の表示は出ず、その状態の案内だけ | U4-4・U4-5・U4-6 |
| T119 | `ready`・睡眠なし・同期中／睡眠あり・同期中 | 判定 | 前者は「睡眠データを取り込んでいます」だけ、後者は同期中の表示だけ | U4-7 |
| T120 | `ready`・同期中・前回の同期失敗あり（睡眠なし／あり） | 判定 | 失敗の表示はなく、前者は「睡眠データを取り込んでいます」だけ、後者は同期中の表示だけ | U4-8 |

### 手順10 連携状態の窓口（中間）：`tests/integration/features/sleep-record/sleep-record-access.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T121 | iOS：`isHealthDataAvailable`／`getRequestStatusForAuthorization` を1つずつ失敗させる（同期関数は例外を投げ、非同期関数は reject する。`it.each`） | 連携状態を取得 | 同じエラーが届き、`sleepRecord.checkAccess` の error ログ（渡した `requestId`・`err`） | I3-4 |
| T122 | Android：`getSdkStatus`／`initialize`／`getGrantedPermissions` を1つずつ reject させる（`it.each`）、および `initialize` が false | 連携状態を取得 | どれもエラーが届き（reject のケースは投げたエラーと同じもの（`toBe`））、`sleepRecord.checkAccess` の error ログ（渡した `requestId`・`err`） | I3-4 |
| T123 | iOS の `requestAuthorization`／Android の `requestPermission` が reject（`it.each`） | 許可を要求 | 投げたエラーと同じもの（`toBe`）が届き、`sleepRecord.requestAccess` の error ログ | I3-5 |
| T124 | iOS の `requestAuthorization` が false／true を返す、Android の `requestPermission` が空配列を返す | 許可を要求 | どれも例外なく終わり、`sleepRecord.requestAccess` の info ログ（`requestId`） | I3-5 |
| T125 | 同上 | 許可を要求 | iOS は `toRead` が `['HKCategoryTypeIdentifierSleepAnalysis']` だけで `toShare` が空／なし。Android は `[{ accessType: 'read', recordType: 'SleepSession' }]` だけ | I3-5 |
| T126 | Android | 設定を開く | `openHealthConnectSettings` が1回呼ばれる | I3-6 |
| T127 | Android で `openHealthConnectSettings` が例外／iOS で呼ぶ | 設定を開く | どちらもエラーが届き（Android は投げたエラーと同じもの（`toBe`））、`sleepRecord.openSettings` の error ログ | I3-6 |

### 手順11 読み取りの窓口（中間）：`tests/integration/features/sleep-record/sleep-record-query.service.test.ts`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T128 | DB に手順14 のシード S と同じ睡眠とステージ | 一覧と `2026-11-25` の詳細を取る | 一覧は `2026-11-25`（合計 462分・就寝 `2026-11-24T23:14`・起床 `2026-11-25T06:46`・昼寝1件）、`2026-11-24`（合計 420分・`23:00`〜`06:00`・昼寝0件）の順。詳細は主睡眠 432分、内訳 深い 90分 20%・浅い 280分 62%・REM 62分 14%・覚醒 20分 4%、昼寝 `13:00`〜`13:30` 30分の1件 | I5-1 |
| T129 | テスト用DBを閉じる | 一覧／詳細を取る | どちらも DB が投げたエラーと同じもの（`toBe`）が届き、`sleepRecord.loadList`／`sleepRecord.loadDetail` の error ログに渡した `requestId` があり、詳細のログの文字列に `2026-11-25` が含まれない | I5-2 |

### 手順12 マイグレーションの適用（中間）：`tests/integration/lib/migration-gate.test.tsx`

最初に `useMigrations` が better-sqlite3 の DB で動くかを確かめる（動かなければ止めて相談）。あわせて、T130 の読み出しを止める仕組みが効くか（解く前に `sleep_sessions` がない状態を観測できるか）も確かめ、効かなければ止めて相談する（drizzle の migrator がマイグレーション一覧を `for await` で読む作りに依存するため）。DB のテーブルの有無は、テストが持つ better-sqlite3 の接続で `sqlite_master` を直接読んで確かめる

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T130 | 正しいマイグレーション。テスト用DBの補助を使わず、マイグレーションを適用していない空の better-sqlite3 DB を `@/lib/db` に渡す。`@/drizzle/migrations` は中身が本物のまま、マイグレーション一覧の読み出しを止めたもの（3.3） | 子要素「child」を包んで描画（`await render`）→ 止めていた読み出しを解く | 解く前は「child」も「データベースの準備に失敗しました」も出ず、DB に `sleep_sessions` がない。解いて待つと「child」が出て（失敗の表示は出ない）、DB に `sleep_sessions`・`sleep_stages`・`sleep_sync_state` がある。`app.migrate` のログはどのレベルにも出ない | I4-11（対照） |
| T131 | T130 と同じ、マイグレーションを適用していない空の better-sqlite3 DB を `@/lib/db` に渡す。`@/drizzle/migrations` は、適用できない壊れた SQL（`CREATE TABL broken (a);`）だけを含むマイグレーション1件に差し替える（読み出しは止めない） | 子要素「child」を包んで描画（`await render`）し、失敗の表示を `findBy*` で待つ | 「データベースの準備に失敗しました」が出て、「child」は出ない。`app.migrate` のログは error の1行だけで、`err.type` が `'DrizzleError'`、`err.message` が `"Failed to run the query 'CREATE TABL broken (a);'"`（info・warn には出ない） | I4-11 |
| T209 | このテストの中だけ、`@/lib/db` の `getDb` を `new Error('open failed')` を投げる実装に変える（呼ばれるたびに投げる。`afterEach` で元に戻し、ほかの項目は空の DB を受け取る）。`@/drizzle/migrations` は本物のまま | 子要素「child」を包んで描画（`await render`）し、失敗の表示を `findBy*` で待つ → 同じ要素で描画し直す（`rerender`） | `await render` は reject せず（落ちない）、「データベースの準備に失敗しました」が出て「child」は出ない。`app.migrate` のログは error の1行だけ（info・warn には出ない）で、`err` が `{ type: 'Error', message: 'open failed', stack: <投げた Error の stack と同じ文字列> }`。描画し直したあとも失敗の表示のままで、`getDb` の呼び出しは1回だけ（開き直さない）、error ログも1行のまま | I4-11 |

### 手順13 同期の受け口（中間）：`tests/integration/features/sleep-record/sleep-record.store.test.ts`・`use-sleep-record-sync.test.tsx`

手順13〜15 では、各テストの前に `jest.resetModules()` してから store を読み込み直す（store の状態と、重複防止のための実行中の Promise を前のテストから持ち越さない。`Platform.OS` を切り替える `it.each` も、各ケースで読み込み直す）。`Platform.OS` は `ios`（Android のケースだけ `android`）。同期中の状態は `queryCategorySamples` が返す Promise を保留にして作る。

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T132 | `ready`、読み取りを保留 | `sync()` を2回呼び、そのあと保留を解く | `queryCategorySamples` は1回だけ。2回目の Promise は1回目が終わるまで解決しない（解く前は未解決、解いたあと両方解決） | I4-6 |
| T133 | 1回目の同期が成功で終わった／失敗で終わった（2ケース） | もう一度 `sync()` | `queryCategorySamples` がもう1回（計2回）呼ばれる | I4-6 |
| T134 | `getRequestStatusForAuthorization` を保留 | `refreshAccess()` を2回呼び、保留を解く | 連携状態の取得関数は1回だけ、2回目は1回目の完了を待つ | I4-6 |
| T135 | `ready` | `sync()` | `getRequestStatusForAuthorization` が1回呼ばれ、そのあとに `queryCategorySamples` が1回呼ばれる | I4-6c |
| T136 | 1回目の取得が失敗、2回目は `ready` | `sync()` を2回（2回目は再試行の再現） | 1回目のあとは読み取り0回で状態が `checkFailed`。2回目のあとは読み取り1回で状態が `ready` | I4-6c |
| T199 | `ready`。store は読み込み直した初期状態（`accessStatus: null`・`syncing: false`）。store の更新を `subscribe` で記録する。同じ記録を、単独の `refreshAccess()` の実行中に `sync()` を呼んだ場合（取得を保留して合流させ、`ready` で解く）でも取る（2ケース） | `sync()` を最後まで | どちらも、`sync()` を呼んでから終わるまでの更新に「`accessStatus: 'ready'`・`syncing: false`」が一度もなく、終わったあとは `ready`・`syncing: false`。`getRequestStatusForAuthorization` は1回、`queryCategorySamples` は1回 | I4-6f |
| T204 | store は初期状態。store の更新を `subscribe` で記録する（`it.each`）：iOS `notRequested`（合流なし）、単独の `refreshAccess()` の取得を保留して `sync()` を合流させ `notRequested` で解く、連携状態の取得が reject する（`checkFailed`） | `sync()` を最後まで | どれも、終わったあとは その状態・`syncing: false` で、連携状態が入る更新と `syncing: false` になる更新が同じ1回（`syncing: true` のまま連携状態だけが変わる更新がない）。`queryCategorySamples` は呼ばれない | I4-6f |
| T200 | iOS。最初に `refreshAccess()` を呼んで `notRequested` にしておく。要求成功後の連携状態の取得（`getRequestStatusForAuthorization` の2回目）を保留し、`ready`（`unnecessary`）で解く。読み取り（`queryCategorySamples`）も保留 | `requestAccess()` → 取得の保留中にもう一度 `requestAccess()` → 取得の保留を解く → 読み取りの保留を解く | 取得の保留中は `requestingAccess` が `true` で、2回目の `requestAccess()` は取得の保留を解く前に終わり、`requestAuthorization` は1回だけ。取得の保留を解いたあと読み取りの保留中に、`requestingAccess` が `false`・`syncing` が `true`。読み取りを解いて終わると `ready`・`syncing: false`、`queryCategorySamples` は1回 | I4-6f |
| T205 | iOS。最初に `refreshAccess()` で `notRequested` にしておく。要求は成功し、そのあとの `getRequestStatusForAuthorization` は reject | `requestAccess()` を最後まで | `requestAccess()` は resolve する。連携状態が `checkFailed`、`requestingAccess` が `false`、`requestAccessFailed` が `false`、`syncing` が `false`、`requestAuthorization` は1回、`queryCategorySamples` は呼ばれない。`sleepRecord.checkAccess` の error ログが1行 | I4-6f |
| T206 | `ready`・1回目の読み取りを保留して同期中。`requestAccess()` を呼び、要求を成功させる。新しい `sync()` の連携状態の取得（要求後の `getRequestStatusForAuthorization`）も保留にする | 1回目の読み取りを解く → 新しい取得の保留中にもう一度 `requestAccess()` → 取得を `ready` で解く | 1回目の読み取りの保留中も、それを解いたあとの新しい取得の保留中も `requestingAccess` が `true` で、`requestAuthorization` は1回だけ。取得を解いた直後（2回目の読み取りの完了前）に `requestingAccess` が `false` | I4-6f |
| T137 | `notRequested`、要求成功後は `ready`。`requestAuthorization` が `true`／`false` を返す（2ケース） | `requestAccess()` | 要求のあと連携状態を取り直し（取得関数が要求後に1回）、同期が1回走る | I4-6c |
| T196 | Android `notGranted`、`requestPermission` 成功後は `getGrantedPermissions` に睡眠の読み取りあり | `requestAccess()` | 要求のあと連携状態を取り直して `ready` になり、`readRecords` が1回呼ばれる | I4-6c |
| T138 | 1回目の同期が失敗（`lastSyncError` あり） | 2回目の同期を成功させる | `lastSyncError` が消え、データの版番号が上がる。1回目の失敗では版番号が上がっていない | I4-6c |
| T186 | `ready`、モックが0件 | `sync()` | 成功扱いで、版番号が上がる（3.1「同期が成功すると版番号が上がる」。0件も成功扱い） | I4-6c |
| T139 | iOS の `notRequested`・`unavailable`・取得失敗（`checkFailed`）、Android の `notGranted`・`unavailable`・`updateRequired`・取得失敗（`checkFailed`）（`it.each`） | `sync()` | 連携状態の取得だけで、`queryCategorySamples`・`readRecords` は呼ばれない | I4-6c・I4-12 |
| T140 | `ready`・読み取りを保留して同期中。`requestAccess()` を呼び、要求を成功させてから保留を解く | 完了を待つ | 読み取りが計2回呼ばれ、2回目は1回目の完了後。`requestAccess()` のあとの連携状態の取得はちょうど1回（新しい `sync()` の中だけ）で、2回目の読み取りより前 | I4-6d |
| T187 | iOS | `openSettings()` | store の「設定を開くの失敗」の値が真になり（3.3 の store の状態）、`sleepRecord.openSettings` の error ログが出る | I4-2b |
| T141 | 連携状態の取得関数が reject | `refreshAccess()` | store の連携状態が `checkFailed` | I4-12b |
| T142 | 連携状態の窓口と同期サービスの関数に、中身を差し替えない `jest.spyOn` を付ける。`ready` で、表にないステージ値を含むサンプルを返す | `sync()` を2回 | 各 `sync()` で、連携状態の窓口に渡った `requestId` と同期サービスに渡った `requestId` が同じ値。その値が `sleepRecord.fetchFromHealth` の warn ログと `sleepRecord.sync` の info ログの `requestId` とも一致する。1回目と2回目の値は違う。続けて `requestAccess()`（成功）を呼ぶと、その `sleepRecord.requestAccess` の info ログの `requestId` と、続く `sync()` で連携状態の窓口に渡る `requestId` が違う値になる | I4-13b |
| T143 | `ready` | `use-sleep-record-sync` を `renderHook` で描画 | 連携状態の取得と `queryCategorySamples` がそれぞれ1回 | I4-5 |
| T144 | 描画済み・初回の同期が終わった | `AppState` を `background`→`active` にする | 連携状態の取得と読み取りがもう1回ずつ走る | I4-7 |
| T145 | 同上 | `AppState` を `active`→`inactive`→`active` にする | 追加の取得・読み取りは走らない | I4-6e |
| T146 | iOS の `notRequested`・`unavailable`・`checkFailed`、Android の `notGranted`・`unavailable`・`updateRequired`・`checkFailed`（`it.each`） | 描画し、`background`→`active` にする | どちらの契機でも `queryCategorySamples`・`readRecords` は呼ばれない | I4-12 |

### 手順14 一覧と案内（中間）：`tests/integration/features/sleep-record/sleep-record-list-screen.test.tsx`

`renderRouter` で実際の `src/app/` を読み込み、`/` を開く。手順13と同じく各テストで `jest.resetModules()` して読み込み直すため、`expo-router/testing-library`（RNTL の入口を読み込む）もテストごとに読み込み直し、RNTL の自動の後片付けは `RNTL_SKIP_AUTO_CLEANUP` で止めて `afterEach` で `cleanup()` を呼ぶ。`renderRouter` は中で既定の設定の `jest.useFakeTimers()` を呼び直す（それまでに固定した時刻は引き継ぐ）ため、`renderRouter` で描画したあとは `Date` とタイマー以外も偽装された状態になる。各テストの `beforeEach` で 3.3 の設定の `jest.useFakeTimers` と `jest.setSystemTime` を呼び直し、`afterEach` で `jest.useRealTimers()` を呼んで、次のテストに持ち越さない。Promise を流す補助（`tests/integration/helpers/`）は、テストファイルの最上位で静的に import し（`jest.resetModules()` の対象にしない）、読み込み時に取っておいた本物の `setImmediate` を使う。この段落の前提は手順15 にも当てはめる。ただし `renderRouter` を通さずコンポーネントを直接描画する項目（T162・T172）では偽装の呼び直しは起きない。手順14・15 で「シード S」と書いたものは次のデータ（DB に入れる場合も、ネイティブのモックが返す場合も同じ睡眠）。

- `2026-11-25`：主睡眠 `2026-11-24T23:14`〜`2026-11-25T06:46`（`deep` 90分・`light` 280分・`rem` 62分・`awake` 20分 → 睡眠時間 432分）、昼寝 `13:00`〜`13:30`（`light` 30分）
- `2026-11-24`：主睡眠 `2026-11-23T23:00`〜`2026-11-24T06:00`（`light` 420分）、昼寝なし
- 一覧の期待表示（以下「S の一覧」）：1行目「11月25日（水）」「7時間42分」「23:14〜6:46」「昼寝 1件」、2行目「11月24日（火）」「7時間0分」「23:00〜6:00」で「昼寝」の文字なし
- 詳細 `2026-11-25` の期待表示（以下「S の詳細」）：「23:14〜6:46」「7時間12分」、昼寝「13:00〜13:30」「30分」

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T147 | `ready`、DB にシード S | 一覧を開く | S の一覧（行の順も含めて一致） | I4-1 |
| T148 | 同上 | 1行目をタップ（手順15で詳細のルートを作ってから足す） | 詳細の URL が `/sleep/2026-11-25` になり、S の詳細が出る | I4-1 |
| T149 | `@/drizzle/migrations` を、T131 と同じ壊れた SQL のマイグレーション1件に差し替える。その `when` は本物の最後のマイグレーションより新しくする（手順14 のテスト用DBは適用済みなので、古いとスキップされて失敗が起きないため） | `/` を開く | 「データベースの準備に失敗しました」が出て、`queryCategorySamples`・連携状態の取得関数が呼ばれない | I4-11b |
| T150 | iOS `notRequested`、要求成功後は `ready`、DB 空、モックはシード S を返す | 「ヘルスケアと連携する」を押す | `requestAuthorization` が1回呼ばれ、同期して S の一覧が出る 。Android（`notGranted`、許可後は `ready`）でも「ヘルスコネクトと連携する」を押すと `requestPermission` が1回呼ばれ、S の一覧が出る | I4-2 |
| T151 | iOS `unavailable`／Android `unavailable`・`updateRequired`・`notGranted`（`it.each`） | 一覧を開く | 3.1 の表どおりの案内文とボタン（02 で一覧の上に足した「週・月の推移」ボタンは数えない） | I4-2 |
| T152 | Android `notGranted`、要求後も `notGranted` | 「ヘルスコネクトと連携する」を押す | 案内は `notGranted` のまま、`readRecords` が呼ばれない | I4-2b |
| T153 | Android `notGranted` | 設定を開くボタンを押す | `openHealthConnectSettings` が1回呼ばれる | I4-2b |
| T154 | `openHealthConnectSettings` が1回目は例外、2回目は保留 | 押す → もう一度押す | 1回目のあと「ヘルスコネクトの設定を開けませんでした。設定アプリからヘルスコネクトを開いてください」が出る。2回目を押すと、保留中のうちに表示が消える | I4-2b |
| T155 | iOS `notRequested`、`requestAuthorization` が1回目だけ例外 | 押す | 「連携の要求に失敗しました」が出て、ボタンは押せる（`disabled` でない）。連携状態の取得関数は押す前から呼び出し回数が増えない | I4-3 |
| T156 | T155 と同じ前提を、この項目の中で作る。2回目の `requestAuthorization` は保留 | 押して失敗させ、もう一度押す | 2回目を押すと、保留中のうちに「連携の要求に失敗しました」が消え、`requestAuthorization` が2回目に呼ばれている | I4-3 |
| T157 | `requestAuthorization` を保留 | 押す → 保留中にもう一度押す | 保留中はボタンが `disabled`、`requestAuthorization` は1回だけ | I4-3 |
| T158 | iOS。`getRequestStatusForAuthorization` が1回目だけ例外、2回目は `shouldRequest` | 一覧を開く → 「再試行」を押す | 「ヘルスケアの状態を確認できませんでした」と「再試行」が出て、押すと取得関数が再び呼ばれ、表示が「ヘルスケアと連携する」ボタンに替わる | I4-4 |
| T159 | `ready`、DB にシード S。起動時の同期が終わってから、2回目の読み取りだけを保留する | 下に引く（`RefreshControl` の `onRefresh`） → 保留を成功／失敗で解く（2ケース） | 引くと読み取り関数がもう1回（起動時の分と合わせて2回）呼ばれ、引いている間 `refreshing` が true、解くとどちらも false | I4-6b |
| T160 | `notRequested`、DB に睡眠あり | 下に引く | 連携状態の取得関数が起動時の分に加えてもう1回（計2回）呼ばれ、読み取り関数は呼ばれず、`refreshing` が false に戻る | I4-6b |
| T194 | iOS `ready`、DB にシード S。一覧が出たあと、次の `getRequestStatusForAuthorization` は reject | 下に引く | `refreshing` が false に戻り、読み取り関数は呼ばれず（起動時の1回のまま）、「ヘルスケアの状態を確認できませんでした」と「再試行」が出て、S の一覧は出たまま | I4-6b |
| T161 | `ready`、DB にシード S。起動時の読み取りは例外、2回目の読み取りは保留 | 一覧を開く → 「再試行」を押し、保留中の表示を見てから成功で解く | 「睡眠データの取り込みに失敗しました」と「再試行」が出て、S の一覧は表示されたまま。押すと読み取りが再び呼ばれ、保留中は失敗表示が消えて同期中の表示（`testID`）だけになる。解くと失敗表示が出ないまま終わる | I4-8 |
| T162 | DB にシード S。一覧画面のコンポーネントを `renderRouter` を通さず直接描画する（マイグレーションはテスト用DBの補助で適用済みのため `MigrationGate` を通さない）。描画の前に連携状態を `notRequested` で取得済みにし（同期が走らない）、テスト用DBを閉じる | 描画 → DB を開き直して「再試行」 | 「睡眠データを読み込めませんでした」と「再試行」、`sleepRecord.loadList` の error ログ。押すと S の一覧が出る | I4-9 |
| T163 | Android `notGranted`、DB にシード S | 一覧を開き、1行目をタップ | 「ヘルスコネクトと連携する」ボタン・「許可しなかった場合は、ヘルスコネクトの設定から許可してください」・設定を開くボタンと一緒に S の一覧が出て、タップで S の詳細が出る | I4-13 |
| T164 | `ready`、DB 空、読み取りを保留（解くとシード S を返す） | 一覧を開く → 保留を解く | 保留中は「睡眠データを取り込んでいます」が出て「睡眠データがありません」は出ない。解くと S の一覧が出る | I4-16 |
| T165 | 連携状態の取得を保留 | 一覧を開く | 「読み込み中」だけが出て、案内・空の表示は出ない | I4-16 |
| T180 | iOS。`getRequestStatusForAuthorization` は `shouldRequest` を返す（起動時の同期の中の取得で `notRequested` になり、同期は走らない）。DB にシード S | `renderRouter` で一覧を開き、`findBy*` で待ったあとの表示を見る | 「ヘルスケアと連携する」ボタンと S の一覧が出て、「読み込み中」と「睡眠データがありません」は出ていない（一覧が「DB を読んでいる間」の表示の状態を持たないことは、DB の読み取りが同期関数で、RNTL 14 の `await render` が読み取りの完了まで待つため外から見られない。I4-16 の注記のとおり、テストでは確かめず impl レビューでコードを確かめる。連携状態の取得中の「読み込み中」は T165 で確かめる） | I4-16 |
| T184 | 一覧が出たあと、2回目の連携状態の取得（`getRequestStatusForAuthorization`）を保留 | `background`→`active` にし、保留中の表示を見てから保留を解く | 保留中も T147 と同じ行が出たままで、「読み込み中」・案内は出ない | I4-16 |
| T166 | DB にシード S。一覧が出たあと、読み取りを保留 | `background`→`active`／下に引く（2ケース） | どちらも保留の間、S の一覧が出たままで「読み込み中」が出ない（同期成功のあとの読み直しは better-sqlite3 で同期的に終わり、間を外から見られないため、このリストでは T174 の内容の更新で確かめ、読み直しの間に「読み込み中」を出さないことは impl レビューでコードを確かめる） | I4-16 |
| T167 | `ready`、DB に睡眠あり、読み取りを保留 | 一覧を開く | 行が出たまま、上部に同期中の表示が出る | I4-17 |

### 手順15 詳細（中間）：`tests/integration/features/sleep-record/sleep-record-detail-screen.test.tsx`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T168 | DB にシード S | `/sleep/2026-11-25` を開く | 「23:14〜6:46」「7時間12分」、内訳が「深い 1時間30分 20%」「浅い 4時間40分 62%」「REM 1時間2分 14%」「覚醒 20分 4%」の順（分母 452分）で、不明の行はない。昼寝は「13:00〜13:30」「30分」で、内訳に昼寝の分は入らない | I4-10 |
| T169 | `2026-11-25` の主睡眠が `unspecified` `2026-11-24T23:00`–`2026-11-25T06:00` の1区間だけ（ステージなし・420分） | `/sleep/2026-11-25` を開く | 「23:00〜6:00」「7時間0分」と「ステージ情報なし」が出て、内訳の行は出ない | I4-10 |
| T192 | DB の `2026-11-25` の主睡眠が T191 と同じ（ステージあり・区間は `light` 59秒・`deep` 59秒） | `/sleep/2026-11-25` を開く | 「ステージ情報なし」が出て、内訳の行は出ない | I4-10 |
| T170 | `2026-11-25` に睡眠なし | `/sleep/2026-11-25` を開く | 「この日の睡眠データはありません」 | I4-10 |
| T171 | — | `/sleep/2026-02-30`・`/sleep/abc` を開く | 「日付が正しくありません」 | I4-10 |
| T172 | DB にシード S。T162 と同じく、詳細画面のコンポーネントに `date = '2026-11-25'` を渡して直接描画する。描画の前に連携状態を `notRequested` で取得済みにし、テスト用DBを閉じる。| 描画 → DB を開き直して「再試行」 | 「睡眠データを読み込めませんでした」と「再試行」、`sleepRecord.loadDetail` の error ログに日付が含まれない。押すと S の詳細が出る | I4-9b |
| T173 | `ready` | 起動の URL を `/sleep/2026-11-25` にして描画 | 連携状態の取得と読み取りがそれぞれ1回 | I4-14 |
| T185 | DB にシード S。起動時の同期の読み取りを保留し、モックは `2026-11-24` の睡眠だけを返す | `/sleep/2026-11-25` を開いて「23:14〜6:46」を確かめ、保留を解いて同期を終える | 表示が「この日の睡眠データはありません」に変わる | I4-15 |
| T174 | DB にシード S。起動時の同期の読み取りを保留し、モックは同じ睡眠を起床 7:10 にしたサンプルを返す | `/sleep/2026-11-25` を開いて「23:14〜6:46」を確かめ、保留を解いて同期を終える | 表示が「23:14〜7:10」に変わる | I4-15 |
| T175 | `ready`（取得のモックは即座に返す）、DB にシード S | `renderRouter` で `/sleep/2026-11-25` を開き、`findBy*` で待ったあとの表示を見る | S の詳細が出て、「読み込み中」と「この日の睡眠データはありません」は出ていない（詳細が「DB を読んでいる間」の表示の状態を持たないことは、T180 と同じ理由でテストでは確かめず impl レビューでコードを確かめる） | I4-16 |

### 手順16 E2E（Maestro）：`tests/e2e/`

| ID | 前提 | 操作 | 期待結果 | 対応 |
| --- | --- | --- | --- | --- |
| T176 | Android で実行。`onFlowStart`：`seed.yaml`（`SEED=数日分`）→ `reset-app.yaml`（`READ_SLEEP=deny`）。`onFlowComplete`：`restore.yaml` | 起動 → 「ヘルスコネクトと連携する」→ OS の許可画面で許可 | 押す前は「許可しなかった場合は、ヘルスコネクトの設定から許可してください」が出ている。許可のあと、`runScript` で `sleep-seed.js`（`SEED=数日分`）から求めた `output.latestDate`・`output.latestTotal`・`output.latestTime` の文字列が1行目に出るまで `extendedWaitUntil` で待ち、その案内と「ヘルスコネクトと連携する」ボタンは消えている。1行目（`testID` `sleep-record-row` の1件目）をタップすると、詳細に `output.latestTime`・`output.latestMainTotal` が出る（`sleep-flow.yaml`）。確かめるのは最新日だけで、ほかの日の行とステージの内訳は中間テスト（T147・T168）で確かめる。前提：エミュレータは日本語・Asia/Tokyo で、他のアプリの睡眠データがなく、0時（日本時間）をまたいで実行しない | E1 |
| T177 | T176 と同じ準備・後始末・前提（Android）。`runScript`（`SEED=数日分`）で `output.latestDate` を求めておく | 「ヘルスコネクトと連携する」→ 許可しない | 「許可しなかった場合は、ヘルスコネクトの設定から許可してください」と「設定を開く」ボタンが出るまで `extendedWaitUntil` で待ち、「ヘルスコネクトと連携する」ボタンが残っていて、「連携の要求に失敗しました」は出ていない。そのあとで、シードの最新日（`output.latestDate`）の行が出ていないこと（同期していない）を確かめる（`deny-android.yaml`） | E2 |
| T178 | iOS（シミュレータのヘルスケアへの投入方法が決まるまで実行しない）。`tags: [ios]`。準備（アプリのデータの消去と、HealthKit の許可を「未要求」に戻す方法）と後始末は、iOS の実行環境が決まるときに決める（それまでは `onFlowStart`・`onFlowComplete` を置かず、フロー本体だけを書く） | 「ヘルスケアと連携する」→ 許可しない | 許可の確認手順つきの「睡眠データがありません。許可していない場合は、設定 → ヘルスケア → データアクセスとデバイス → suimin-app で睡眠を許可してください。SOXAI アプリのヘルスケア連携も確認してください」が出るまで `extendedWaitUntil` で待ち（拒否は判別できず `ready` になり、同期で0件になってからこの案内が出る）、「ヘルスケアと連携する」ボタンは消えていて、一覧の行（`sleep-record-row`）は1つもない（`deny-ios.yaml`） | E2 |
| T179 | Android で実行。`onFlowStart`：`seed.yaml`（`SEED=睡眠なし`）→ `reset-app.yaml`（`READ_SLEEP=allow`）。`onFlowComplete`：`restore.yaml` | 起動 | 「睡眠データがありません。SOXAI アプリのヘルスコネクト連携を確認してください」が出て（`extendedWaitUntil` で待つ）、一覧の行（`testID` `sleep-record-row`）は1つもない（`no-data.yaml`）。前提：エミュレータに他のアプリの睡眠データがない（シードアプリは自分が書いたデータしか消せないため）。iOS の同じ確かめは、投入方法が決まってから足す | E3 |

### このリストで扱った・扱わなかった持ち越し事項（plan 9ラウンド目の P2）
- テスト番号の並び：リストは実装順に並べ、通し番号 `T001`〜で振った（5 の番号は「対応」に残す）
- 単体テストのファイルパス：各節の見出しに置き場所を書いた（`sleep-record-date.service.ts` の U2-8 は `sleep-record-date.service.test.ts` に分けた）
- 未整列入力の並べ替え：T022・T043・T054 を追加した
- 詳細画面の日付見出し・案内、`start_at` のインデックス：設計の変更が要るため、このリストでは扱わない。人間の判断で TODO とした（2026-11-25）

## レビュー記録
<!-- ai-review スキルが合格時に1行ずつ追記する（例：- 2026-11-18 plan 合格（1ラウンド）） -->
- 2026-11-25 plan 合格（9ラウンド。9ラウンド目の P1 4件を修正後、再レビューせず人間の判断で合格。9ラウンド目の P2 のうち未対応の6件（テスト番号の並び、単体テストのファイルパス、詳細画面の日付見出し・案内、並べ替えのケース、`start_at` のインデックス）は test 段階で扱う）
- 2026-11-26 test 合格（5ラウンド。5ラウンド目の P1 2件・P2 12件を修正後、再レビューせず人間の判断で合格。TODO：詳細画面の日付見出し・案内、`start_at` のインデックス、版番号の更新後の読み直し中に「読み込み中」が出ないことの確認方法（T166））
- 2026-11-26 test 合格（再レビュー：手順12 T130・T131 と T149、3.3 の `@/drizzle/migrations` の差し替え。1ラウンド。P1 3件・P2 3件を修正後、再レビューせず人間の判断で合格）
- 2026-11-26 test 合格（再レビュー：手順14 の前提・T180・T175・I4-16、3.3 の偽装タイマーの記述。1ラウンド。P1 2件・P2 5件を修正後、再レビューせず人間の判断で合格。P2 1件（T180 と T163 の重なり）は対応せず。TODO：一覧・詳細の初回の DB 読み取り中に「読み込み中」だけを出すことと、読み直しの間に「読み込み中」を出さないことを impl レビューでコードを確かめる）
- 2026-11-26 plan・test 合格（再レビュー：手順16 の E2E とシードアプリの設計、T176〜T179。2ラウンド。plan は P1 4→3件・P2 7→6件、test は P1 2→0件・P2 5→6件。2ラウンド目の plan の P1 3件と P2 の多くを修正後、再レビューせず人間の判断で合格。要確認として残したもの：要件「読み取りのみ」の解釈を docs/requirement.md にも書くか、testing.md の E2E の実行コマンドをタグ付きにそろえるか）
- 2026-11-26 plan・test 合格（impl レビュー1ラウンド目の P1 2件（実行の順序で落ちるテスト＝共通ログの Error 判定、Android の長さ0のステージだけの睡眠の取り込み）と P2 2件（同期中の印、許可の要求中の印）を直すための変更。T197〜T208。2ラウンド。plan は P1 4→2件・P2 5→5件、test は P1 5→5件・P2 6→7件。2ラウンド目の指摘をすべて修正後、再レビューせず人間の判断で合格）
- 2026-11-26 plan・test 合格（impl レビュー2ラウンド目の P1 2件（Android のバックアップ、DB を開けないとき）を直すための変更。T209。plan は2ラウンド（P1 1→2件・P2 6→6件）、test は1ラウンド（P1 0件・P2 4件、修正済み）。plan の2ラウンド目の指摘を修正後、再レビューせず人間の判断で合格）
- 2026-11-26 impl 合格（2ラウンド。P1 は 2→2件（1ラウンド目：実行の順序で落ちるテスト・Android の長さ0のステージだけの睡眠の取り込み、2ラウンド目：Android のバックアップ・DB を開けないとき。いずれも修正済み）。2ラウンド目の P1 を修正後、再レビューせず人間の判断で合格。P2 は次を TODO 化：
  - iOS の iCloud・端末のバックアップから DB を外す（8 に記載）
  - 共通ログ：出してよいキーを許可リストにする／drizzle の非同期 API を使い始めたら `DrizzleQueryError` の `params` をログから外す
  - 時計を戻したとき、範囲外（未来側）の睡眠が一時的に消える（削除の条件に `end_at <= 範囲の終了` を足す案）
  - Android のページ送りで、同じ `pageToken` が返り続けたら打ち切る
  - 許可の要求の Promise が終わらないとき、要求中の印が下りない
  - `throw null` の同期の失敗が画面に出ない（失敗の有無を真偽値で持つ）
  - iOS の連携状態 `unknown` を `ready` ではなく `checkFailed` にするか
  - ステージの一括 INSERT を分割する（SQLite の変数の上限）
  - 表示の文字列の組み立て（ステージ名・「〜」・「昼寝 n件」）と、要求・設定の失敗の文言をフックから整形・案内のサービスへ移す
  - `toRangeDays` を取り込み範囲のサービスへ移す／OS の値の変換を1か所にまとめる
  - 一覧・詳細の DB 読み取りを描画の中で行うため、開発時の StrictMode で読み取りの失敗ログが2回出うる
  - 本番から呼ばれていない `hasAnySession` を消すか、設計書の責務から外す
  - テストの補助の相対 import（`../../helpers/...`）を別名にするか
  - E2E：シードを入れた時刻と期待値を計算する時刻をそろえる（シードアプリが使った時刻を引き継ぐ）
  - iOS の並べ替えの比較関数・0〜99年の日付の判定（実害なし）

## 修正履歴
<!-- 既存機能の修正時に1行ずつ追記する（例：- 2026-12-01 ログイン失敗時のロック回数を5回に変更） -->
- 2026-11-26 02（週・月の推移のグラフ）のため、一覧画面の上に「週・月の推移」ボタンを追加し、整形サービスに関数を追加（詳細は `docs/features/02_sleep-chart.md`）
- 2026-11-28 画面の移動をフックから呼ぶ決まり（architecture.md）に合わせ、一覧の行のタップの移動を一覧のフックの `openDay` に移した（動きは変えない。02 の PR #2 のレビューで人間が判断）
