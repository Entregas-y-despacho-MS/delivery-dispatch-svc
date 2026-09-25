// RF-A28 — parámetros de consulta del listado de usuarios (llegan como strings del query string).
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindAllUsersParamsDto, UserSortBy } from './find-all-users-params.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const parse = (plain: object) => plainToInstance(FindAllUsersParamsDto, plain);
const errorsOf = async (plain: object) => (await validate(parse(plain), OPTIONS)).map((e) => e.property);

describe('FindAllUsersParamsDto', () => {
    it('sin parámetros: página 1, 10 por página, todo lo demás sin definir', async () => {
        const dto = parse({});
        expect(await errorsOf({})).toEqual([]);
        expect(dto.page).toBe(1);
        expect(dto.limit).toBe(10);
        expect(dto.search).toBeUndefined();
        expect(dto.status).toBeUndefined();
        expect(dto.sortBy).toBeUndefined();
    });

    it('convierte los strings del query string (page, limit, roleId, active)', () => {
        const dto = parse({ page: '3', limit: '25', roleId: '2', active: 'false' });
        expect(dto).toMatchObject({ page: 3, limit: 25, roleId: 2, active: false });
    });

    describe('paginación', () => {
        it('limit hasta 100 es válido; 101 o más se rechaza', async () => {
            expect(await errorsOf({ limit: '100' })).toEqual([]);
            expect(await errorsOf({ limit: '101' })).toEqual(['limit']);
            expect(await errorsOf({ limit: '1000000' })).toEqual(['limit']);
        });

        it('page y limit menores a 1 o no enteros se rechazan', async () => {
            for (const bad of ['0', '-1', '1.5', 'abc']) {
                expect(await errorsOf({ page: bad }), `page=${bad}`).toEqual(['page']);
                expect(await errorsOf({ limit: bad }), `limit=${bad}`).toEqual(['limit']);
            }
        });
    });

    describe('status', () => {
        it('acepta active | inactive | locked', async () => {
            for (const status of ['active', 'inactive', 'locked']) {
                expect(await errorsOf({ status }), status).toEqual([]);
            }
        });

        it('rechaza cualquier otro valor (incluidas mayúsculas)', async () => {
            for (const status of ['bloqueado', 'ACTIVE', 'true', '']) {
                expect(await errorsOf({ status }), status).toEqual(['status']);
            }
        });
    });

    describe('search', () => {
        it('recorta espacios al inicio y al final', () => {
            expect(parse({ search: '  carlos  ' }).search).toBe('carlos');
        });

        it('acepta hasta 100 caracteres y rechaza más', async () => {
            expect(await errorsOf({ search: 'a'.repeat(100) })).toEqual([]);
            expect(await errorsOf({ search: 'a'.repeat(101) })).toEqual(['search']);
        });
    });

    describe('ordenamiento', () => {
        it('acepta los 4 campos de la lista cerrada', async () => {
            for (const sortBy of Object.values(UserSortBy)) {
                expect(await errorsOf({ sortBy }), sortBy).toEqual([]);
            }
        });

        it('rechaza un campo fuera de la lista (evita ordenar por columnas internas como password_hash)', async () => {
            for (const sortBy of ['passwordHash', 'role', 'id; DROP TABLE users', 'fullname']) {
                expect(await errorsOf({ sortBy }), sortBy).toEqual(['sortBy']);
            }
        });

        it('sortOrder acepta asc/desc en cualquier capitalización, y rechaza otra cosa', async () => {
            expect(parse({ sortOrder: 'ASC' }).sortOrder).toBe('asc');
            expect(await errorsOf({ sortOrder: 'Desc' })).toEqual([]);
            expect(await errorsOf({ sortOrder: 'up' })).toEqual(['sortOrder']);
        });
    });

    it('rechaza parámetros que no existen (forbidNonWhitelisted)', async () => {
        expect(await errorsOf({ nombre: 'carlos' })).toEqual(['nombre']);
    });
});
