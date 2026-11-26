import vm from 'node:vm';

import { logger } from '@/lib/logger';

describe('logger', () => {
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // T001
  it('info は name と値を1行の JSON で console.info にだけ出す', () => {
    logger.info('a.b', { requestId: 'r1', count: 3 });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const args = infoSpy.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe('string');
    expect(args[0]).not.toContain('\n');
    expect(JSON.parse(args[0])).toEqual(
      expect.objectContaining({ name: 'a.b', requestId: 'r1', count: 3 }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // T002
  it('warn は console.warn にだけ、error は console.error にだけ1回出す', () => {
    logger.warn('a.b', {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0][0]).name).toBe('a.b');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockClear();
    logger.error('a.b', {});
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0]).name).toBe('a.b');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // T003
  it('err に Error を渡すと、種別・メッセージ・スタックに整形される', () => {
    const err = new TypeError('boom');

    logger.error('a.b', { err });

    expect(JSON.parse(errorSpy.mock.calls[0][0]).err).toEqual({
      type: 'TypeError',
      message: 'boom',
      stack: err.stack,
    });
  });

  // T004
  it('err に Error 以外（文字列）を渡すと、メッセージとして出る', () => {
    logger.error('a.b', { err: 'just text' });

    expect(JSON.parse(errorSpy.mock.calls[0][0]).err.message).toBe('just text');
  });

  // T005
  it('err 以外のオブジェクト・配列は "[omitted]" に置き換わり、中身が出ない', () => {
    const data = { startAt: 1764000000000, stage: 'deep' };
    const list = [1, 2];

    logger.info('a.b', { data, list });

    const line: string = infoSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.data).toBe('[omitted]');
    expect(parsed.list).toBe('[omitted]');
    expect(line).not.toContain('1764000000000');
    expect(line).not.toContain('deep');
  });

  // T006
  it('null は null で出て、undefined のキーは出ない。真偽値・文字列はそのまま', () => {
    logger.info('a.b', { a: null, b: undefined, c: true, d: 'x' });

    const parsed = JSON.parse(infoSpy.mock.calls[0][0]);
    expect(parsed.a).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsed, 'b')).toBe(false);
    expect(parsed.c).toBe(true);
    expect(parsed.d).toBe('x');
  });

  // T007
  it('スタックのない Error は stack なしで出る', () => {
    const err = new Error('no stack');
    err.stack = undefined;

    logger.error('a.b', { err });

    const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(parsed.err).toEqual({ type: 'Error', message: 'no stack' });
    expect(Object.prototype.hasOwnProperty.call(parsed.err, 'stack')).toBe(false);
  });

  /** console.error に出た1行目を JSON にしたもの */
  const errorEntry = () => JSON.parse(errorSpy.mock.calls[0][0]);

  // T197
  it('別の実行環境で作られた Error（instanceof が偽）も種別・メッセージ・スタックに整形する', () => {
    const err = vm.runInNewContext("new TypeError('boom')") as Error;
    expect(err instanceof Error).toBe(false);

    logger.error('a.b', { err });

    expect(errorEntry().err).toEqual({ type: 'TypeError', message: 'boom', stack: err.stack });
  });

  // T197
  it('別の実行環境で作られた Error で stack がなければ、stack のキーを出さない', () => {
    const err = vm.runInNewContext(
      "const e = new TypeError('boom'); delete e.stack; e.stack = undefined; e",
    ) as Error;
    expect(err instanceof Error).toBe(false);

    logger.error('a.b', { err });

    expect(errorEntry().err).toEqual({ type: 'TypeError', message: 'boom' });
  });

  // T201
  it.each([
    ['message が数値', { message: 98765 }],
    ['name がない', { message: 'secret-msg-x' }],
    ['name は文字列で message が数値', { name: 'Error', message: 98765 }],
    ['name が数値で message は文字列', { name: 12345, message: 'secret-msg-x' }],
    ['どちらも数値', { name: 12345, message: 98765 }],
    ['睡眠らしい値', { startAt: 1764000000000, stage: 'deep' }],
  ])('Error の形でないオブジェクト（%s）は中身を出さない', (_label, err) => {
    logger.error('a.b', { err });

    expect(errorEntry().err).toEqual({ message: '[omitted]' });
    const line = errorSpy.mock.calls[0][0] as string;
    for (const text of ['98765', 'secret-msg-x', '12345', '1764000000000', 'deep']) {
      expect(line).not.toContain(text);
    }
  });

  // T201（反対側）
  it('name と message がどちらも文字列の普通のオブジェクトは Error として整形する', () => {
    logger.error('a.b', { err: { name: 'MyError', message: 'm' } });

    expect(errorEntry().err).toEqual({ type: 'MyError', message: 'm' });
  });

  // T202
  it.each([
    [
      'err が null プロトタイプのオブジェクト',
      () => ({ err: Object.create(null) }),
      { err: { message: '[omitted]' } },
    ],
    ['err が BigInt', () => ({ err: BigInt(1) }), { err: { message: '[omitted]' } }],
    ['フィールドが BigInt', () => ({ big: BigInt(1) }), { big: '[omitted]' }],
  ])('整形できない値（%s）でも例外を投げず1行出す', (_label, fields, expected) => {
    expect(() => logger.error('a.b', fields())).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorEntry()).toEqual({ name: 'a.b', ...expected });
  });

  // T202
  it('err の name を読むと例外を投げる値でも、例外を投げず name と logFailed だけの1行を出す', () => {
    const err = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );

    expect(() => logger.error('a.b', { err })).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorEntry()).toEqual({ name: 'a.b', logFailed: true });
  });

  // T207
  it.each([
    [404, { message: '404' }],
    [0, { message: '0' }],
    [false, { message: 'false' }],
  ])('err に %p を渡すと文字列にしてメッセージに出す', (err, expected) => {
    logger.error('a.b', { err });

    expect(errorEntry().err).toEqual(expected);
  });

  // T207
  it('err が null なら null、undefined ならキーを出さない', () => {
    logger.error('a.b', { err: null });
    logger.error('a.c', { err: undefined });

    expect(JSON.parse(errorSpy.mock.calls[0][0]).err).toBeNull();
    expect(JSON.parse(errorSpy.mock.calls[1][0])).toEqual({ name: 'a.c' });
  });
});
