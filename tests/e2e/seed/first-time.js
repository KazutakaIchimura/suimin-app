// Maestro の runScript：直前の copyTextFrom で写した文字（maestro.copiedText）から、先頭の「H:MM」を output.time に入れる
// （03 の E5。候補のボタン「5:48 4サイクル（6時間14分後）」から 5:48 を取り出す）
var match = /^(\d{1,2}:\d{2})/.exec(maestro.copiedText);
output.time = match ? match[1] : '';
