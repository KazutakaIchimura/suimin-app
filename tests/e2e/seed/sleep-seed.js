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
  // スマートアラームの推定（testing.md の「推定に足りる日数」）。03 の E5 で使う
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

/**
 * グラフの画面（02）で期待する文字列。今日を含む週（月曜〜日曜）の見出し、
 * シードの最新日が今週にあるか（今日が月曜なら最新日の1日前は先週）、最新日のボタンの読み上げの説明
 */
function expectedChart(name, now) {
  var todayMidnight = jstMidnight(now);
  // getUTCDay は日曜が 0。月曜からの日数にする（日本時間の曜日）
  var sinceMonday = (new Date(todayMidnight + JST_OFFSET_MS).getUTCDay() + 6) % 7;
  var weekStart = todayMidnight - sinceMonday * DAY_MS;
  var weekEnd = weekStart + 6 * DAY_MS;
  var result = {
    weekTitle: formatDate(weekStart, now) + '〜' + formatDate(weekEnd, now),
    latestInThisWeek: false,
    latestDayLabel: null,
  };
  var sessions = buildSeed(name, now);
  if (sessions.length === 0) return result;
  var latest = sessions[0];
  result.latestInThisWeek = latest.wakeDayMidnight >= weekStart;
  result.latestDayLabel =
    formatDate(latest.wakeDayMidnight, now) +
    ' 睡眠 ' +
    formatMinutes(latest.asleepMinutes) +
    ' 就寝 ' +
    formatTime(latest.startAt) +
    ' 起床 ' +
    formatTime(latest.endAt);
  return result;
}

/**
 * スマートアラームの画面（03）の使う値の説明。推定の規則（03 の設計書 3.1）を、このシードの形に合わせて写したもの：
 * どの日も深い睡眠から始まるので入眠は 0分、レムは1晩に1回なのでサイクル長の値はない。
 * 実行日の29日前〜今日に入る日（シードの日はすべて1〜14日前）の数で、実績か標準値かを決める
 */
function expectedAlarmParams(name) {
  var days = SEED_DAYS[name].filter(function (d) {
    return d <= 29;
  }).length;
  var required = 14;
  var onset =
    days >= required
      ? '入眠 0分（あなたの記録）'
      : '入眠 14分（標準値。あと ' + (required - days) + '日分の記録で切り替わります）';
  return onset + '・1サイクル 90分（標準値。あと 14日分の記録で切り替わります）';
}

/**
 * 03 の E6：起きたい時刻を「今から2分後」にするための時と分（日本時間）と、希望の時刻のボタンの先頭の文字「H:MM 希望の時刻」
 */
function expectedRingTime(now) {
  var target = new Date(now + 2 * MINUTE_MS + JST_OFFSET_MS);
  var hour = target.getUTCHours();
  var minute = target.getUTCMinutes();
  var hhmm = hour + ':' + (minute < 10 ? '0' : '') + minute;
  return {
    hour: String(hour),
    minute: (minute < 10 ? '0' : '') + minute,
    label: hhmm + ' 希望の時刻',
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
  var chart = expectedChart(SEED, Date.now());
  output.chartWeekTitle = chart.weekTitle;
  // Maestro のフローの条件で使うため文字列にする
  output.latestInThisWeek = chart.latestInThisWeek ? 'true' : 'false';
  output.latestDayLabel = chart.latestDayLabel;
  output.alarmParams = expectedAlarmParams(SEED);
  var ring = expectedRingTime(Date.now());
  output.ringHour = ring.hour;
  output.ringMinute = ring.minute;
  output.ringLabel = ring.label;
}

// シードアプリ（Node・Metro）から使うとき
if (typeof module !== 'undefined') {
  module.exports = {
    buildSeed: buildSeed,
    expectedLatest: expectedLatest,
    expectedChart: expectedChart,
    expectedAlarmParams: expectedAlarmParams,
    expectedRingTime: expectedRingTime,
    SEED_NAMES: Object.keys(SEED_DAYS),
  };
}
