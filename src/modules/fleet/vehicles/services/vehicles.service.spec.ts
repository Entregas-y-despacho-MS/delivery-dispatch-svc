// VehiclesService.findAll — la búsqueda (placa, modelo, tipo) trata % y _ como texto y conserva el
// filtro de estado en cada rama del OR.
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { VehiclesService } from './vehicles.service.js';
import { VehicleDto } from '../dto/vehicle.dto.js';
import { FindAllVehiclesParamsDto } from '../dto/find-all-vehicles-params.dto.js';

async function run(over: object = {}) {
    const rawRepo = { findAndCount: vi.fn().mockResolvedValue([[], 0]) };
    await new VehiclesService(rawRepo as any, {} as any).findAll(VehicleDto, plainToInstance(FindAllVehiclesParamsDto, over));
    return rawRepo.findAndCount.mock.calls[0][0];
}
const branches = (where: any) => (Array.isArray(where) ? where : [where]);

describe('VehiclesService.findAll — búsqueda', () => {
    it('busca en placa, modelo y tipo (3 ramas del OR) con ILIKE contiene', async () => {
        const list = branches((await run({ search: 'hilux' })).where);

        expect(list).toHaveLength(3);
        expect(list.map((b) => Object.keys(b)[0]).sort()).toEqual(['model', 'plate', 'type']);
        for (const b of list) expect(Object.values(b)[0]).toMatchObject({ type: 'ilike', value: '%hilux%' });
    });

    it('escapa los comodines: "50%" y "a_b" se buscan literalmente', async () => {
        expect(branches((await run({ search: '50%' })).where)[0].plate.value).toBe('%50\\%%');
        expect(branches((await run({ search: 'a_b' })).where)[0].plate.value).toBe('%a\\_b%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).where).toEqual({});
        expect((await run({ search: '   ' })).where).toEqual({});
    });

    it('search + vehicleStatusId: cada rama conserva el filtro de estado', async () => {
        for (const b of branches((await run({ search: 'x', vehicleStatusId: '2' })).where)) expect(b.vehicleStatusId).toBe(2);
    });
});
