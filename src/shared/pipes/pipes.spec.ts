import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ParseIdPipe } from './parse-id.pipe.js';
import { NoNullBytesPipe } from './no-null-bytes.pipe.js';

describe('ParseIdPipe', () => {
    const pipe = new ParseIdPipe();

    it.each([['1', 1], ['42', 42], ['2147483647', 2147483647]])('accepts %s', (raw, expected) => {
        expect(pipe.transform(raw)).toBe(expected);
    });

    it.each([12, 2147483647])('accepts the number %s (the global ValidationPipe may have converted it already)', (n) => {
        expect(pipe.transform(n)).toBe(n);
    });

    it.each([NaN, 1.5, 0, -3, 2147483648, 1e21, Infinity])('rejects the number %s', (n) => {
        expect(() => pipe.transform(n)).toThrow(BadRequestException);
    });

    it.each(['0', '-1', '2147483648', '99999999999', 'abc', '1.5', '1e3', '', ' 1', '+1', '0x10'])('rejects %j with a 400 (it used to reach Postgres as a 500 or a 404)', (raw) => {
        expect(() => pipe.transform(raw)).toThrow(BadRequestException);
    });
});

describe('NoNullBytesPipe', () => {
    const pipe = new NoNullBytesPipe();
    const body = { type: 'body' } as const;

    it('lets normal values through untouched', () => {
        const value = { name: 'Zona Sur', nested: { list: ['a', 'b'], n: 3 }, none: null };
        expect(pipe.transform(value, body)).toBe(value);
    });

    it.each([
        ['a string body value', { name: 'a\u0000b' }],
        ['a nested value', { a: { b: [{ c: 'x\u0000' }] } }],
        ['a key', { ['k\u0000']: 1 }],
        ['a top-level string', 'a\u0000'],
    ])('rejects a NUL character in %s', (_label, value) => {
        expect(() => pipe.transform(value, body)).toThrow(BadRequestException);
    });

    it('also checks query and path params, but ignores custom decorators', () => {
        expect(() => pipe.transform('%00'.replace('%00', '\u0000'), { type: 'query' })).toThrow(BadRequestException);
        expect(() => pipe.transform('\u0000', { type: 'param' })).toThrow(BadRequestException);
        expect(pipe.transform('\u0000', { type: 'custom' })).toBe('\u0000');
    });
});
