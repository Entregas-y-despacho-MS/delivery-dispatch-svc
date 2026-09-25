// RolesService.findAll — la búsqueda por nombre trata % y _ como texto, no como comodines.
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { RolesService } from './roles.service.js';
import { RoleDto } from '../dto/role.dto.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';

async function run(over: object = {}) {
    const rawRepo = { findAndCount: vi.fn().mockResolvedValue([[], 0]) };
    await new RolesService(rawRepo as any).findAll(RoleDto, plainToInstance(FindAllRolesParamsDto, over));
    return rawRepo.findAndCount.mock.calls[0][0];
}

describe('RolesService.findAll — búsqueda', () => {
    it('busca por nombre con ILIKE contiene, sin distinguir mayúsculas', async () => {
        const { where } = await run({ search: 'adm' });
        expect(where.name.type).toBe('ilike');
        expect(where.name.value).toBe('%adm%');
    });

    it('escapa los comodines: "50%" y "a_b" se buscan literalmente', async () => {
        expect((await run({ search: '50%' })).where.name.value).toBe('%50\\%%');
        expect((await run({ search: 'a_b' })).where.name.value).toBe('%a\\_b%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).where).toEqual({});
        expect((await run({ search: '   ' })).where).toEqual({});
    });

    it('recorta los espacios alrededor', async () => {
        expect((await run({ search: '  adm  ' })).where.name.value).toBe('%adm%');
    });
});
