// RolesService — listing, filtering, sorting and user counts of the (read-only) roles catalog. No DB.
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { RolesService } from './roles.service.js';
import { RoleDto } from '../dto/role.dto.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';
import { RoleNotFoundException } from '../exceptions/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

const ROLES = [
    { id: 1, name: 'root', createdAt: new Date('2026-01-01') },
    { id: 2, name: 'admin', createdAt: new Date('2026-01-01') },
    { id: 5, name: 'driver', createdAt: new Date('2026-01-01') },
];

function build(counts: Record<number, { total: number; active: number }> = {}) {
    const rawRepo = {
        findAndCount: vi.fn().mockResolvedValue([ROLES, 3]),
        findOne:      vi.fn().mockResolvedValue(ROLES[1]),
    };
    const usersService = { countByRoles: vi.fn().mockResolvedValue(new Map(Object.entries(counts).map(([id, c]) => [Number(id), c]))) };
    return { service: new RolesService(rawRepo as any, usersService as any), rawRepo, usersService };
}

const params = (over: object = {}) => plainToInstance(FindAllRolesParamsDto, over);
async function query(over: object = {}, actor?: RoleEnum) {
    const { service, rawRepo } = build();
    await service.findAll(RoleDto, params(over), actor);
    return rawRepo.findAndCount.mock.calls[0][0];
}
// A FindOperator, flattened for assertions: 'ilike:%adm%', 'equal:admin', 'not:root', 'and:[…]'.
const show = (op: any): string => (op.type === 'and' ? `and:[${op.value.map(show).join(', ')}]` : op.type === 'not' ? `not:${op.value.value ?? op.value}` : `${op.type}:${op.value}`);

describe('RolesService.findAll — filters', () => {
    it('no filters → no where at all, ordered by id', async () => {
        const options = await query();
        expect(options.where).toEqual({});
        expect(options.order).toEqual({ id: 'ASC' });
    });

    it('search → name contains (case-insensitive), % and _ escaped, spaces trimmed', async () => {
        expect(show((await query({ search: '  adm ' })).where.name)).toBe('ilike:%adm%');
        expect(show((await query({ search: '50%' })).where.name)).toBe('ilike:%50\\%%');
        expect(show((await query({ search: 'a_b' })).where.name)).toBe('ilike:%a\\_b%');
    });

    it('an empty or blank search is ignored', async () => {
        expect((await query({ search: '' })).where).toEqual({});
        expect((await query({ search: '   ' })).where).toEqual({});
    });

    it('name → exactly that role', async () => {
        expect(show((await query({ name: 'driver' })).where.name)).toBe('equal:driver');
    });

    it('search + name → both must hold (ANDed on the same column, not one overwriting the other)', async () => {
        expect(show((await query({ search: 'dri', name: 'driver' })).where.name)).toBe('and:[ilike:%dri%, equal:driver]');
    });

    it('assignable=true for an admin (or anyone but root) → root is left out', async () => {
        for (const actor of [RoleEnum.ADMIN, RoleEnum.COORDINATOR, undefined]) {
            expect(show((await query({ assignable: 'true' }, actor)).where.name), String(actor)).toBe('not:root');
        }
    });

    it('assignable=true for root → nothing is left out', async () => {
        expect((await query({ assignable: 'true' }, RoleEnum.ROOT)).where).toEqual({});
    });

    it('assignable=false or empty is "no filter" (an empty value used to break other lists with a 500)', async () => {
        expect((await query({ assignable: 'false' }, RoleEnum.ADMIN)).where).toEqual({});
        expect((await query({ assignable: '' }, RoleEnum.ADMIN)).where).toEqual({});
    });

    it('all three together are ANDed', async () => {
        expect(show((await query({ search: 'a', name: 'admin', assignable: 'true' }, RoleEnum.ADMIN)).where.name)).toBe('and:[ilike:%a%, equal:admin, not:root]');
    });
});

describe('RolesService.findAll — sorting and pagination', () => {
    it('sorts by id by default and ties are broken by id', async () => {
        expect((await query()).order).toEqual({ id: 'ASC' });
        expect((await query({ sortBy: 'name' })).order).toEqual({ name: 'ASC', id: 'ASC' });
        expect((await query({ sortBy: 'createdAt' })).order).toEqual({ createdAt: 'ASC', id: 'ASC' });
    });

    it('sortOrder desc reverses the chosen field but not the id tie-break; the case does not matter', async () => {
        expect((await query({ sortBy: 'name', sortOrder: 'DESC' })).order).toEqual({ name: 'DESC', id: 'ASC' });
        expect((await query({ sortOrder: 'desc' })).order).toEqual({ id: 'DESC' });
    });

    it('pagination: skip/take from page and limit, and the meta', async () => {
        const { service, rawRepo } = build();

        const result = await service.findAll(RoleDto, params({ page: '2', limit: '2' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 2, take: 2 });
        expect(result.meta).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
    });
});

describe('RolesService — user counts', () => {
    it('findAllWithUserCounts adds userCount / activeUserCount to each role, 0 for a role nobody has', async () => {
        const { service, usersService } = build({ 2: { total: 4, active: 3 }, 1: { total: 1, active: 1 } });

        const page = await service.findAllWithUserCounts(params());

        expect(usersService.countByRoles).toHaveBeenCalledWith([1, 2, 5]); // one query for the whole page
        expect(page.data.map((r) => [r.name, r.userCount, r.activeUserCount])).toEqual([['root', 1, 1], ['admin', 4, 3], ['driver', 0, 0]]);
        expect(page.data[1]).toMatchObject({ id: 2, name: 'admin', createdAt: ROLES[1].createdAt });
        expect(page.meta.total).toBe(3);
    });

    it('an empty page asks for no counts', async () => {
        const { service, rawRepo, usersService } = build();
        rawRepo.findAndCount.mockResolvedValue([[], 0]);

        const page = await service.findAllWithUserCounts(params({ search: 'zzz' }));

        expect(page.data).toEqual([]);
        expect(usersService.countByRoles).toHaveBeenCalledWith([]);
    });

    it('findOneByIdWithUserCounts returns the role with its counts', async () => {
        const { service } = build({ 2: { total: 2, active: 1 } });

        expect(await service.findOneByIdWithUserCounts(2)).toMatchObject({ id: 2, name: 'admin', userCount: 2, activeUserCount: 1 });
    });

    it('…and ROLE_NOT_FOUND for a role that does not exist', async () => {
        const { service, rawRepo } = build();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.findOneByIdWithUserCounts(99)).rejects.toThrow(RoleNotFoundException);
    });
});
