// ST-17.3 — pruebas unitarias de validación de contraseñas (RF-A25, Escenarios 1 y 3).
// Todo mockeado (repos de TypeORM, SettingsService) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';
import { PasswordTooShortException, PasswordRecentlyUsedException, ConflictingUserFiltersException } from '../exceptions/index.js';
import { FindAllUsersParamsDto, UserSortBy } from '../dto/find-all-users-params.dto.js';
import { UserDto } from '../dto/user.dto.js';
import { plainToInstance } from 'class-transformer';
import { hashPassword } from '../../../../shared/utils/crypto.util.js';

function buildService(overrides: { minLength?: number } = {}) {
    const rawRepo = {
        findOneByOrFail: vi.fn(),
        update:          vi.fn(),
        findOne:         vi.fn(),
        findAndCount:    vi.fn().mockResolvedValue([[], 0]),
    };
    const historyRepo = {
        find:   vi.fn().mockResolvedValue([]),
        create: vi.fn((data: any) => data),
        save:   vi.fn(),
    };
    const settings = {
        getNumber: vi.fn().mockReturnValue(overrides.minLength ?? 8),
    };

    const service = new UsersService(rawRepo as any, historyRepo as any, settings as any);
    return { service, rawRepo, historyRepo, settings };
}

describe('UsersService — password policy (RF-A25)', () => {
    describe('Escenario 1 — mínimo dinámico (settings.password_min_length)', () => {
        it('rechaza una contraseña más corta que el mínimo configurado', async () => {
            const { service, rawRepo } = buildService({ minLength: 10 });
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });

            await expect(service.updatePassword(1, 'Short1!')).rejects.toThrow(PasswordTooShortException);
        });

        it('acepta una contraseña que cumple el mínimo configurado', async () => {
            const { service, rawRepo, historyRepo } = buildService({ minLength: 8 });
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });

            await service.updatePassword(1, 'LongEnough1!');

            expect(rawRepo.update).toHaveBeenCalled();
            expect(historyRepo.save).toHaveBeenCalled();
        });
    });

    describe('Escenario 3 — no reutilización (updatePassword)', () => {
        it('rechaza si la nueva contraseña es igual a la actual', async () => {
            const { service, rawRepo } = buildService();
            const currentHash = await hashPassword('CurrentPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: currentHash });

            await expect(service.updatePassword(1, 'CurrentPassw0rd!')).rejects.toThrow(PasswordRecentlyUsedException);
        });

        it('rechaza si la nueva contraseña coincide con alguna de las últimas 3 del historial', async () => {
            const { service, rawRepo, historyRepo } = buildService();
            const oldHash = await hashPassword('OldPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });
            historyRepo.find.mockResolvedValue([{ passwordHash: oldHash, createdAt: new Date() }]);

            await expect(service.updatePassword(1, 'OldPassw0rd!')).rejects.toThrow(PasswordRecentlyUsedException);
        });

        it('acepta una contraseña genuinamente nueva, la registra en el historial y limpia el estado', async () => {
            const { service, rawRepo, historyRepo } = buildService();
            const currentHash = await hashPassword('CurrentPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: currentHash });
            historyRepo.find.mockResolvedValue([]);

            await service.updatePassword(1, 'BrandNewPassw0rd!');

            // Guarda el hash VIEJO en el historial (no el nuevo) — es "la contraseña que se reemplazó".
            expect(historyRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, passwordHash: currentHash }));

            const updatePayload = rawRepo.update.mock.calls[0][1];
            expect(updatePayload.requiresPwdChange).toBe(false);
            expect(updatePayload.failedAttempts).toBe(0);
            expect(updatePayload.lockedUntil).toBeNull();
            expect(updatePayload.passwordChangedAt).toBeInstanceOf(Date);
            expect(updatePayload.passwordHash).not.toBe(currentHash); // quedó hasheada, no en texto plano
        });
    });
});

// ── RF-A28 — listado de usuarios: paginación, filtros combinados, búsqueda y orden ───────────────
describe('UsersService.findAll — consulta del listado (RF-A28)', () => {
    const query = (over: object = {}) => plainToInstance(FindAllUsersParamsDto, over);
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        await service.findAll(UserDto, query(over));
        const [options] = rawRepo.findAndCount.mock.calls[0];
        return { options, rawRepo };
    };
    // FindOperator (ILike, MoreThan, IsNull...) → algo comparable.
    const op = (f: any) => ({ type: f.type, value: f.value });
    const branches = (where: any) => (Array.isArray(where) ? where : [where]);

    it('sin filtros: todos los usuarios, más nuevos primero, página 1 de 10', async () => {
        const { options } = await run();

        expect(options.where).toEqual({});
        expect(options.order).toEqual({ createdAt: 'DESC', id: 'ASC' });
        expect(options.skip).toBe(0);
        expect(options.take).toBe(10);
    });

    it('pagina en el servidor: skip/take según page y limit, y devuelve total y cantidad de páginas', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[], 47]);

        const result = await service.findAll(UserDto, query({ page: '3', limit: '10' }));

        const [options] = rawRepo.findAndCount.mock.calls[0];
        expect(options).toMatchObject({ skip: 20, take: 10 });
        expect(result.meta).toEqual({ page: 3, limit: 10, total: 47, pages: 5 });
    });

    it('sin resultados: total 0 y 0 páginas', async () => {
        const { service } = buildService();
        const result = await service.findAll(UserDto, query());
        expect(result.data).toEqual([]);
        expect(result.meta).toMatchObject({ total: 0, pages: 0 });
    });

    it('roleId y active se combinan con "y" en un único where', async () => {
        const { options } = await run({ roleId: '4', active: 'true' });
        expect(options.where).toEqual({ roleId: 4, active: true });
    });

    describe('active vacío (?active=)', () => {
        it('no filtra: el DTO lo convierte en null y no debe llegar al where como active = null (eso rompía la consulta)', async () => {
            const { options } = await run({ active: '' });
            expect(options.where).toEqual({});
        });

        it('combinado con otros filtros, los demás se aplican igual', async () => {
            const { options } = await run({ active: '', roleId: '3' });
            expect(options.where).toEqual({ roleId: 3 });
        });

        it('con status no cuenta como "active y status a la vez": no da CONFLICTING_USER_FILTERS', async () => {
            const { options } = await run({ active: '', status: 'inactive' });
            expect(options.where).toEqual({ active: false });
        });
    });

    describe('status (derivado)', () => {
        it('inactive → active = false', async () => {
            const { options } = await run({ status: 'inactive' });
            expect(options.where).toEqual({ active: false });
        });

        it('locked → activo y locked_until en el futuro', async () => {
            const { options } = await run({ status: 'locked' });
            const where = options.where;

            expect(where.active).toBe(true);
            expect(op(where.lockedUntil).type).toBe('moreThan');
            expect(where.lockedUntil.value.getTime()).toBeLessThanOrEqual(Date.now());
            expect(where.lockedUntil.value.getTime()).toBeGreaterThan(Date.now() - 5_000);
        });

        it('active → activo y (sin bloqueo O con bloqueo ya vencido): 2 ramas', async () => {
            const { options } = await run({ status: 'active' });
            const [noLock, expired] = branches(options.where);

            expect(branches(options.where)).toHaveLength(2);
            expect(noLock.active).toBe(true);
            expect(op(noLock.lockedUntil).type).toBe('isNull');
            expect(expired.active).toBe(true);
            expect(op(expired.lockedUntil).type).toBe('lessThanOrEqual');
        });

        it('active/status a la vez → 400 CONFLICTING_USER_FILTERS, sin consultar la base', async () => {
            const { service, rawRepo } = buildService();

            await expect(service.findAll(UserDto, query({ active: 'true', status: 'locked' })))
                .rejects.toThrow(ConflictingUserFiltersException);
            expect(rawRepo.findAndCount).not.toHaveBeenCalled();
        });
    });

    describe('search', () => {
        it('busca en nombre, usuario y correo (sin distinguir mayúsculas): 3 ramas OR', async () => {
            const { options } = await run({ search: 'Carlos' });
            const list = branches(options.where);

            expect(list).toHaveLength(3);
            expect(list.map((b: any) => Object.keys(b)[0]).sort()).toEqual(['email', 'fullName', 'username']);
            for (const branch of list) {
                const filter = Object.values(branch)[0] as any;
                expect(op(filter)).toEqual({ type: 'ilike', value: '%Carlos%' });
            }
        });

        it('escapa los comodines: buscar "50%" o "a_b" no matchea todo', async () => {
            const { options } = await run({ search: '50%' });
            expect(op(branches(options.where)[0].fullName).value).toBe('%50\\%%');

            const second = await run({ search: 'a_b' });
            expect(op(branches(second.options.where)[0].fullName).value).toBe('%a\\_b%');
        });

        it('un search vacío o de solo espacios se ignora', async () => {
            expect((await run({ search: '' })).options.where).toEqual({});
            expect((await run({ search: '   ' })).options.where).toEqual({});
        });
    });

    describe('filtros combinados: TODOS deben cumplirse (Escenario 1)', () => {
        it('search + roleId + status=inactive: cada rama del OR conserva rol y estado', async () => {
            const { options } = await run({ search: 'Carlos', roleId: '5', status: 'inactive' });
            const list = branches(options.where);

            expect(list).toHaveLength(3);
            for (const branch of list) {
                expect(branch.roleId).toBe(5);
                expect(branch.active).toBe(false);
            }
        });

        it('search + status=active + roleId: 3 x 2 = 6 ramas y ninguna se salta el rol ni el estado', async () => {
            const { options } = await run({ search: 'ana', roleId: '2', status: 'active' });
            const list = branches(options.where);

            expect(list).toHaveLength(6);
            for (const branch of list) {
                expect(branch.roleId).toBe(2);
                expect(branch.active).toBe(true);
                expect(branch.lockedUntil).toBeDefined();
                expect(['fullName', 'username', 'email'].some((key) => key in branch)).toBe(true);
            }
        });

        it('las ramas no comparten objetos (mutar una no afecta a otra)', async () => {
            const { options } = await run({ search: 'ana', status: 'active' });
            const list = branches(options.where);
            expect(new Set(list).size).toBe(list.length);
        });
    });

    describe('ordenamiento', () => {
        it('por nombre ascendente', async () => {
            const { options } = await run({ sortBy: UserSortBy.FULL_NAME, sortOrder: 'asc' });
            expect(options.order).toEqual({ fullName: 'ASC', id: 'ASC' });
        });

        it('sortOrder solo, sin sortBy: ordena por fecha de alta en ese sentido', async () => {
            const { options } = await run({ sortOrder: 'asc' });
            expect(options.order).toEqual({ createdAt: 'ASC', id: 'ASC' });
        });

        it('por último acceso: los que nunca ingresaron quedan al final en ambos sentidos', async () => {
            const desc = await run({ sortBy: UserSortBy.LAST_LOGIN_AT, sortOrder: 'desc' });
            const asc  = await run({ sortBy: UserSortBy.LAST_LOGIN_AT, sortOrder: 'asc' });

            expect(desc.options.order).toEqual({ lastLoginAt: { direction: 'DESC', nulls: 'LAST' }, id: 'ASC' });
            expect(asc.options.order).toEqual({ lastLoginAt: { direction: 'ASC', nulls: 'LAST' }, id: 'ASC' });
        });

        it('siempre desempata por id, para que una página no repita ni se salte filas', async () => {
            for (const sortBy of Object.values(UserSortBy)) {
                const { options } = await run({ sortBy });
                expect(options.order.id).toBe('ASC');
            }
        });
    });
});

describe('UsersService.setLastLogin (RF-A28)', () => {
    it('guarda la hora actual en last_login_at del usuario', async () => {
        const { service, rawRepo } = buildService();
        const before = Date.now();

        await service.setLastLogin(7);

        expect(rawRepo.update).toHaveBeenCalledTimes(1);
        const [id, patch] = rawRepo.update.mock.calls[0];
        expect(id).toBe(7);
        expect(Object.keys(patch)).toEqual(['lastLoginAt']);
        expect(patch.lastLoginAt.getTime()).toBeGreaterThanOrEqual(before);
    });
});
