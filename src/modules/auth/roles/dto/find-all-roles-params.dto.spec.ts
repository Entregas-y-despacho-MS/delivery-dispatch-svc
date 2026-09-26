import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FindAllRolesParamsDto, RoleSortBy } from './find-all-roles-params.dto.js';

const validate = (input: object) => {
    const dto = plainToInstance(FindAllRolesParamsDto, input);
    return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
};
const failing = (input: object) => validate(input).errors.map((e) => e.property);

describe('FindAllRolesParamsDto', () => {
    it('everything is optional and paginates with page 1 / limit 10 by default', () => {
        const { dto, errors } = validate({});
        expect(errors).toEqual([]);
        expect([dto.page, dto.limit]).toEqual([1, 10]);
    });

    it.each(['root', 'admin', 'coordinator', 'supervisor', 'driver'])('name accepts %s', (name) => {
        expect(failing({ name })).toEqual([]);
    });

    it.each(['Admin', 'ADMIN', 'client', 'superuser', '', 'admin,driver'])('name rejects %j (must be exactly one of the 5 roles)', (name) => {
        expect(failing({ name })).toEqual(['name']);
    });

    it.each([['true', true], ['false', false]])('assignable=%s is converted to a boolean', (raw, expected) => {
        const { dto, errors } = validate({ assignable: raw });
        expect(errors).toEqual([]);
        expect(dto.assignable).toBe(expected);
    });

    it('an empty assignable means "no filter" (null), and anything else is rejected', () => {
        expect(validate({ assignable: '' }).errors).toEqual([]);
        expect(() => validate({ assignable: 'maybe' })).toThrow();
    });

    it.each(Object.values(RoleSortBy))('sortBy accepts %s', (sortBy) => {
        expect(failing({ sortBy })).toEqual([]);
    });

    it.each(['username', 'userCount', 'password', ''])('sortBy rejects %j', (sortBy) => {
        expect(failing({ sortBy })).toEqual(['sortBy']);
    });

    it('sortOrder accepts asc/desc in any case, rejects the rest', () => {
        expect(failing({ sortOrder: 'ASC' })).toEqual([]);
        expect(validate({ sortOrder: 'Desc' }).dto.sortOrder).toBe('desc');
        expect(failing({ sortOrder: 'up' })).toEqual(['sortOrder']);
    });

    it('search is trimmed and limited to 100 characters', () => {
        expect(validate({ search: '  adm  ' }).dto.search).toBe('adm');
        expect(failing({ search: 'a'.repeat(101) })).toEqual(['search']);
        expect(failing({ search: 'a'.repeat(100) })).toEqual([]);
    });

    it('unknown params are rejected', () => {
        expect(failing({ foo: 'bar' })).toEqual(['foo']);
    });

    it('the shared pagination limits still apply (limit <= 100, page >= 1)', () => {
        expect(failing({ limit: '101' })).toEqual(['limit']);
        expect(failing({ page: '0' })).toEqual(['page']);
    });
});
