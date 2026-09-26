// ST-17.3 — pruebas unitarias de validación de contraseñas (RF-A25, Escenarios 1 y 3).
// Todo mockeado (repos de TypeORM, SettingsService) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';
import { PasswordTooShortException, PasswordRecentlyUsedException, ConflictingUserFiltersException, InvalidRoleException, UserAlreadyExistsException } from '../exceptions/index.js';
import { RootAccountProtectedException, CannotModifyOwnAccountException } from '../../../../app/auth/exceptions/index.js';
import { QueryFailedError } from 'typeorm';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
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
    const roleRepo = {
        existsBy: vi.fn().mockResolvedValue(true),
    };
    const settings = {
        getNumber: vi.fn().mockReturnValue(overrides.minLength ?? 8),
    };

    const service = new UsersService(rawRepo as any, historyRepo as any, roleRepo as any, settings as any);
    return { service, rawRepo, historyRepo, roleRepo, settings };
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

describe('UsersService — roleId inexistente (antes daba 500 por la FK)', () => {
    const create = (over: object = {}) => ({ fullName: 'Ana', username: 'ana', email: undefined, password: 'Passw0rd!', roleId: 99, ...over }) as any;

    function withCreateMocks(roleExists: boolean) {
        const built = buildService();
        built.rawRepo.findOne.mockResolvedValue(null); // ningún usuario con ese username/email
        (built.rawRepo as any).create = vi.fn(() => ({}));
        (built.rawRepo as any).save   = vi.fn(async (e: any) => ({ id: 1, ...e }));
        built.roleRepo.existsBy.mockResolvedValue(roleExists);
        return built;
    }

    it('create: un roleId que no existe → InvalidRoleException y no se guarda nada', async () => {
        const { service, rawRepo, roleRepo } = withCreateMocks(false);

        await expect(service.create(UserDto, create())).rejects.toThrow(InvalidRoleException);

        expect(roleRepo.existsBy).toHaveBeenCalledWith({ id: 99 });
        expect((rawRepo as any).save).not.toHaveBeenCalled();
    });

    it('create: con un rol que existe sigue guardando', async () => {
        const { service, rawRepo } = withCreateMocks(true);
        rawRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: 1 });

        await service.create(UserDto, create({ roleId: 2 }));

        expect((rawRepo as any).save).toHaveBeenCalledTimes(1);
    });

    it('create: dentro de una transacción consulta el rol con el manager, no con el repo global', async () => {
        const { service, roleRepo } = withCreateMocks(true);
        const managerRoleRepo = { existsBy: vi.fn().mockResolvedValue(false) };
        const manager = { getRepository: vi.fn(() => managerRoleRepo) };

        await expect(service.create(UserDto, create(), { manager } as any)).rejects.toThrow(InvalidRoleException);

        expect(managerRoleRepo.existsBy).toHaveBeenCalled();
        expect(roleRepo.existsBy).not.toHaveBeenCalled();
    });

    it('update: un roleId que no existe → InvalidRoleException y no se actualiza nada', async () => {
        const { service, rawRepo, roleRepo } = buildService();
        rawRepo.findOne.mockResolvedValue({ id: 5, username: 'ana', email: null });
        roleRepo.existsBy.mockResolvedValue(false);

        await expect(service.update(UserDto, 5, { roleId: 99 } as any)).rejects.toThrow(InvalidRoleException);

        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('update: sin roleId en el body no consulta roles', async () => {
        const { service, rawRepo, roleRepo } = buildService();
        rawRepo.findOne.mockResolvedValue({ id: 5, username: 'ana', email: null });

        await service.update(UserDto, 5, { fullName: 'Ana B' } as any);

        expect(roleRepo.existsBy).not.toHaveBeenCalled();
        expect(rawRepo.update).toHaveBeenCalledWith(5, { fullName: 'Ana B' });
    });
});

describe('UsersService.assertCanManageRoot — un admin no puede llegar a root', () => {
    const ROOT_ROLE_ID = 1;
    const actor = (role: string) => ({ id: 9, username: 'x', roleId: 2, role }) as any;
    const withRoot = () => {
        const built = buildService();
        (built.roleRepo as any).findOneBy = vi.fn().mockResolvedValue({ id: ROOT_ROLE_ID, name: 'root' });
        return built;
    };

    it('root puede todo: crear usuarios root y editar/borrar cuentas root', async () => {
        const { service, rawRepo } = withRoot();
        rawRepo.findOne.mockResolvedValue({ id: 5, roleId: ROOT_ROLE_ID });

        await expect(service.assertCanManageRoot(actor('root'), { roleId: ROOT_ROLE_ID, userId: 5 })).resolves.toBeUndefined();
    });

    it('un admin no puede dar el rol root (crear un usuario root o ascenderse a sí mismo)', async () => {
        const { service } = withRoot();

        await expect(service.assertCanManageRoot(actor('admin'), { roleId: ROOT_ROLE_ID })).rejects.toThrow(RootAccountProtectedException);
    });

    it('un admin no puede editar ni borrar una cuenta que ya es root (cambiarle la contraseña = tomar la cuenta)', async () => {
        const { service, rawRepo } = withRoot();
        rawRepo.findOne.mockResolvedValue({ id: 5, roleId: ROOT_ROLE_ID });

        await expect(service.assertCanManageRoot(actor('admin'), { userId: 5 })).rejects.toThrow(RootAccountProtectedException);
    });

    it('un admin sí puede gestionar cuentas que no son root y asignar otros roles', async () => {
        const { service, rawRepo } = withRoot();
        rawRepo.findOne.mockResolvedValue({ id: 6, roleId: 3 });

        await expect(service.assertCanManageRoot(actor('admin'), { userId: 6, roleId: 4 })).resolves.toBeUndefined();
    });

    it('un usuario que no existe no se bloquea acá (el 404 lo da el servicio)', async () => {
        const { service, rawRepo } = withRoot();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.assertCanManageRoot(actor('admin'), { userId: 999 })).resolves.toBeUndefined();
    });
});

describe('UsersService.registerFailedLogin — un solo UPDATE atómico', () => {
    it('manda un único UPDATE con el máximo y el instante de desbloqueo', async () => {
        const { service, rawRepo } = buildService();
        (rawRepo as any).query = vi.fn();
        const before = Date.now();

        await service.registerFailedLogin(7, 5, 15 * 60_000);

        expect((rawRepo as any).query).toHaveBeenCalledTimes(1);
        const [sql, [userId, now, max, until]] = (rawRepo as any).query.mock.calls[0];
        expect(sql).toMatch(/^\s*UPDATE users SET/);
        expect(sql).toContain('failed_attempts + 1'); // se incrementa en la base, no se calcula acá
        expect([userId, max]).toEqual([7, 5]);
        expect(now.getTime()).toBeGreaterThanOrEqual(before);
        expect(until.getTime() - now.getTime()).toBe(15 * 60_000);
        expect(rawRepo.update).not.toHaveBeenCalled(); // nada de leer-y-escribir
    });
});

describe('UsersService — carrera al crear/editar con un username o email repetido', () => {
    const dup = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('dup'), { code: '23505' }));
    const other = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('null'), { code: '23502' }));
    const dto = { fullName: 'Ana', username: 'ana', password: 'Passw0rd!', roleId: 2 } as any;

    it('create: el índice único (dos pedidos a la vez) responde 409, no 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);
        (rawRepo as any).create = vi.fn(() => ({}));
        (rawRepo as any).save   = vi.fn().mockRejectedValue(dup());

        await expect(service.create(UserDto, dto)).rejects.toThrow(UserAlreadyExistsException);
    });

    it('create: otro error de base de datos se propaga tal cual', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);
        const failure = other();
        (rawRepo as any).create = vi.fn(() => ({}));
        (rawRepo as any).save   = vi.fn().mockRejectedValue(failure);

        await expect(service.create(UserDto, dto)).rejects.toBe(failure);
    });

    it('update: el índice único también responde 409', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue({ id: 5, username: 'ana', email: null });
        rawRepo.update.mockRejectedValue(dup());

        await expect(service.update(UserDto, 5, { fullName: 'Ana B' } as any)).rejects.toThrow(UserAlreadyExistsException);
    });
});

describe('correo en minúsculas', () => {
    it('CreateUserDto y UpdateUserDto lo recortan y pasan a minúsculas antes de validar', () => {
        const create = plainToInstance(CreateUserDto, { email: '  Ana@Hipermaxi.COM ' });
        const update = plainToInstance(UpdateUserDto, { email: 'ANA@X.com' });

        expect(create.email).toBe('ana@hipermaxi.com');
        expect(update.email).toBe('ana@x.com');
    });

    it('null sigue significando "borrar el correo" en el update', () => {
        expect(plainToInstance(UpdateUserDto, { email: null }).email).toBeNull();
    });

    it('la búsqueda por correo ignora mayúsculas (filas viejas guardadas con mayúsculas)', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await service.findOneByEmail(UserDto, 'Ana@X.com', { throwException: false });

        const where = rawRepo.findOne.mock.calls[0][0].where;
        expect(where.email).toMatchObject({ type: 'ilike', value: 'Ana@X.com' });
    });
});

describe('UsersService.assertNotSelfDestructive — nobody locks themselves out', () => {
    const { service } = buildService();
    const me = { id: 9, username: 'ana', roleId: 2, role: 'admin', mustChangePassword: false } as any;

    it('cannot delete, deactivate or change the role of the own account', () => {
        expect(() => service.assertNotSelfDestructive(me, 9, { remove: true })).toThrow(CannotModifyOwnAccountException);
        expect(() => service.assertNotSelfDestructive(me, 9, { active: false })).toThrow(CannotModifyOwnAccountException);
        expect(() => service.assertNotSelfDestructive(me, 9, { roleId: 4 })).toThrow(CannotModifyOwnAccountException);
    });

    it('can edit the own account otherwise (name, keeping the same role, staying active)', () => {
        expect(() => service.assertNotSelfDestructive(me, 9, {})).not.toThrow();
        expect(() => service.assertNotSelfDestructive(me, 9, { active: true, roleId: 2 })).not.toThrow();
    });

    it('acts on other accounts freely', () => {
        expect(() => service.assertNotSelfDestructive(me, 10, { remove: true, active: false, roleId: 4 })).not.toThrow();
    });
});

describe('UsersService.findForAuthentication', () => {
    it('returns the current state with the role name; null for a missing user', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValueOnce({ id: 7, username: 'ana', roleId: 3, active: true, requiresPwdChange: false, passwordChangedAt: new Date(0), role: { id: 3, name: 'coordinator' } });

        expect(await service.findForAuthentication(7)).toEqual({ id: 7, username: 'ana', roleId: 3, role: 'coordinator', active: true, requiresPwdChange: false, passwordChangedAt: new Date(0) });

        rawRepo.findOne.mockResolvedValueOnce(null);
        expect(await service.findForAuthentication(8)).toBeNull();
    });
});

describe('UsersService.countByRoles', () => {
    function withQueryBuilder(rows: any[]) {
        const built = buildService();
        const qb: any = { select: vi.fn().mockReturnThis(), addSelect: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), groupBy: vi.fn().mockReturnThis(), getRawMany: vi.fn().mockResolvedValue(rows) };
        (built.rawRepo as any).createQueryBuilder = vi.fn(() => qb);
        return { ...built, qb };
    }

    it('groups the users of the given roles and returns totals and active counts as numbers', async () => {
        const { service, qb } = withQueryBuilder([{ roleId: 2, total: '4', active: '3' }, { roleId: 5, total: '1', active: '0' }]);

        const counts = await service.countByRoles([1, 2, 5]);

        expect(qb.where).toHaveBeenCalledWith('u.role_id IN (:...roleIds)', { roleIds: [1, 2, 5] });
        expect(qb.groupBy).toHaveBeenCalledWith('u.role_id');
        expect(counts.get(2)).toEqual({ total: 4, active: 3 });
        expect(counts.get(5)).toEqual({ total: 1, active: 0 });
        expect(counts.has(1)).toBe(false); // a role with no users is simply absent
    });

    it('no roles → no query', async () => {
        const { service, qb } = withQueryBuilder([]);

        expect((await service.countByRoles([])).size).toBe(0);
        expect(qb.getRawMany).not.toHaveBeenCalled();
    });
});
