// 共通ログ関数（.claude/rules/logging.md）。console を直接呼ぶのはこのファイルだけ
type LogFields = Record<string, unknown>;

const OMITTED = '[omitted]';

/** 値を出さないこと（`undefined` のキーと同じく、出力から外す） */
const SKIP = Symbol('skip');

/**
 * Error として扱うか。ネイティブのモジュールなど別の実行環境で作られたエラーは `instanceof Error` が偽になるため、
 * `name` と `message` がどちらも文字列かで判定する
 */
function isErrorLike(value: object): value is { name: string; message: string; stack?: unknown } {
  const v = value as { name?: unknown; message?: unknown };
  return typeof v.name === 'string' && typeof v.message === 'string';
}

function formatError(err: unknown): unknown {
  if (err === undefined) return SKIP;
  if (err === null) return null;
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'number' || typeof err === 'boolean') return { message: String(err) };
  if (typeof err === 'object' && isErrorLike(err)) {
    const stack = typeof err.stack === 'string' ? { stack: err.stack } : {};
    return { type: err.name, message: err.message, ...stack };
  }
  // Error の形でないオブジェクト・BigInt・関数・シンボルは、睡眠データが入っていても出さない
  return { message: OMITTED };
}

// 睡眠データを丸ごと渡されても出力しないよう、文字列・数値・真偽値・null 以外は中身を出さない
function mask(value: unknown): unknown {
  if (value === undefined) return SKIP;
  if (value === null) return null;
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' ? value : OMITTED;
}

function format(name: string, fields: LogFields): string {
  try {
    const out: LogFields = { name };
    for (const [key, value] of Object.entries(fields)) {
      const formatted = key === 'err' ? formatError(value) : mask(value);
      if (formatted !== SKIP) out[key] = formatted;
    }
    return JSON.stringify(out);
  } catch {
    // ログ関数そのものは例外を投げない（呼び出し元の元のエラーを別のエラーに置き換えないため）
    return JSON.stringify({ name, logFailed: true });
  }
}

function info(name: string, fields: LogFields): void {
  console.info(format(name, fields));
}
function warn(name: string, fields: LogFields): void {
  console.warn(format(name, fields));
}
function error(name: string, fields: LogFields): void {
  console.error(format(name, fields));
}

export const logger = { info, warn, error };
