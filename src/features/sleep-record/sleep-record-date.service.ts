// 詳細画面の日付パラメータを検証する（設計書 3.3・U2-8）。純粋関数

/** 4桁の年・2桁の月・2桁の日。前後に余分な文字を許さない */
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** 日付パラメータが実在する `YYYY-MM-DD` ならその帰属日を、不正なら `null` を返す */
export function parseWakeDate(param: string | string[] | undefined): string | null {
  if (typeof param !== 'string' || !DATE_FORMAT.test(param)) return null;
  const [year, month, day] = param.split('-').map(Number);
  return isRealDate(year, month, day) ? param : null;
}

/** 年月日が実在する日付か（UTC の暦に入れて、年・月・日がずれないかで判定する） */
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
