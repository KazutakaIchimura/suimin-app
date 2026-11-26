// E2E のシードの定義（設計書 3.3「E2E」・testing.md「E2Eのシードデータ」）。
// シードアプリ（tests/e2e/seed/seeder-app/）と Maestro の runScript の両方から使う。
// Maestro の runScript でも動くよう、import・アロー関数・テンプレート文字列を使わない素の JavaScript で書く。
// 日付と時刻はすべて日本時間（+09:00）で計算する（動かす機械のタイムゾーンに左右されないように）。
// 表示文字列の作り方はアプリの整形サービスを使わず、このファイルに書く（E2E でアプリ内部を使わないため）。

var MINUTE_MS = 60 * 1000;
var DAY_MS = 24 * 60 * MINUTE_MS;
/** 日本時間と UTC の差 */
var JST_OFFSET_MS = 9 * 60 * MINUTE_MS;
var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** シードの名前と、起床日を「実行日の何日前」で並べたもの */
var SEED_DAYS = {
  睡眠なし: [],
  数日分: [1, 2, 3],
  // 今回のフローでは使わない。スマートアラームの推定（testing.md の「推定に足りる日数」）のために置いておく
  '14日分': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
};

/** 日本時間の、その日の0時（UNIX ミリ秒） */
function jstMidnight(ms) {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/**
 * 「d 日前に起きた」睡眠1回分。就寝は前日の 23:00〜23:20、ステージは深い→浅い→REM→覚醒の順に隙間なく続ける。
 * 日によって浅いの長さを変え、どの日の表示か見分けられるようにする
 */
function sessionFor(daysAgo, now) {
  var wakeDayMidnight = jstMidnight(now) - daysAgo * DAY_MS;
  var startAt = wakeDayMidnight - 60 * MINUTE_MS + (daysAgo % 3) * 10 * MINUTE_MS;
  var parts = [
    ['deep', 90],
    ['light', 240 + daysAgo * 5],
    ['rem', 60],
    ['awake', 15],
  ];
  var at = startAt;
  var stages = [];
  var asleepMinutes = 0;
  for (var i = 0; i < parts.length; i += 1) {
    var minutes = parts[i][1];
    stages.push({ stage: parts[i][0], startAt: at, endAt: at + minutes * MINUTE_MS });
    at += minutes * MINUTE_MS;
    if (parts[i][0] !== 'awake') asleepMinutes += minutes;
  }
  return {
    id: 'seed-' + daysAgo,
    startAt: startAt,
    endAt: at,
    wakeDayMidnight: wakeDayMidnight,
    asleepMinutes: asleepMinutes,
    stages: stages,
  };
}

/** シード `name` の睡眠（新しい順）。各睡眠は id・startAt・endAt・asleepMinutes・stages を持つ */
function buildSeed(name, now) {
  var days = SEED_DAYS[name];
  if (!days) throw new Error('Unknown seed: ' + name);
  var sessions = [];
  for (var i = 0; i < days.length; i += 1) sessions.push(sessionFor(days[i], now));
  return sessions;
}

/** 日本時間の年月日と曜日 */
function jstParts(ms) {
  var d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: WEEKDAYS[d.getUTCDay()],
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
  };
}

/** 「7時間32分」「45分」（設計書 3.4） */
function formatMinutes(total) {
  var h = Math.floor(total / 60);
  var m = total % 60;
  return h > 0 ? h + '時間' + m + '分' : m + '分';
}

/** 「23:14」「6:05」（時は0埋めなし、分は2桁） */
function formatTime(ms) {
  var p = jstParts(ms);
  return p.hours + ':' + (p.minutes < 10 ? '0' : '') + p.minutes;
}

/** 「11月25日（水）」。今年（日本時間の現在日の年）以外なら「2025年11月25日（火）」 */
function formatDate(dayMs, now) {
  var p = jstParts(dayMs);
  var prefix = p.year === jstParts(now).year ? '' : p.year + '年';
  return prefix + p.month + '月' + p.day + '日（' + p.weekday + '）';
}

/** シード `name` の最新日の表示文字列。睡眠がなければ `null`（「数日分」などは昼寝がないので、合計＝主睡眠） */
function expectedLatest(name, now) {
  var sessions = buildSeed(name, now);
  if (sessions.length === 0) return null;
  var latest = sessions[0];
  return {
    date: formatDate(latest.wakeDayMidnight, now),
    total: formatMinutes(latest.asleepMinutes),
    time: formatTime(latest.startAt) + '〜' + formatTime(latest.endAt),
    mainTotal: formatMinutes(latest.asleepMinutes),
  };
}

// Maestro の runScript から使うとき：環境変数 SEED の最新日の表示文字列を output に入れる
if (typeof output !== 'undefined' && typeof SEED !== 'undefined') {
  var expected = expectedLatest(SEED, Date.now());
  if (expected) {
    output.latestDate = expected.date;
    output.latestTotal = expected.total;
    output.latestTime = expected.time;
    output.latestMainTotal = expected.mainTotal;
  }
}

// シードアプリ（Node・Metro）から使うとき
if (typeof module !== 'undefined') {
  module.exports = {
    buildSeed: buildSeed,
    expectedLatest: expectedLatest,
    SEED_NAMES: Object.keys(SEED_DAYS),
  };
}
