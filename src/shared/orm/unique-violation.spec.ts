import { describe, expect, it } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { isUniqueViolation } from './unique-violation.js';

const queryFailed = (code?: string) =>
    new QueryFailedError('INSERT ...', [], Object.assign(new Error('db error'), code === undefined ? {} : { code }));

describe('isUniqueViolation', () => {
    it('true para el error de índice único de Postgres (23505)', () => {
        expect(isUniqueViolation(queryFailed('23505'))).toBe(true);
    });

    it('false para otros errores de la base (NOT NULL 23502, FK 23503, check 23514, sintaxis 42601)', () => {
        for (const code of ['23502', '23503', '23514', '42601', '40001']) {
            expect(isUniqueViolation(queryFailed(code)), code).toBe(false);
        }
    });

    it('false si el error de la base no trae código', () => {
        expect(isUniqueViolation(queryFailed())).toBe(false);
    });

    it('false para errores que no son de la base, aunque tengan code 23505', () => {
        expect(isUniqueViolation(new Error('boom'))).toBe(false);
        expect(isUniqueViolation(Object.assign(new Error('parece'), { code: '23505' }))).toBe(false);
        expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(false);
    });

    it('false para valores que no son errores', () => {
        for (const value of [null, undefined, '23505', 23505, {}, []]) {
            expect(isUniqueViolation(value)).toBe(false);
        }
    });
});
