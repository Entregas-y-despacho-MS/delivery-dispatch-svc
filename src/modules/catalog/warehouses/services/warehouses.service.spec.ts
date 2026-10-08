// Corrección de ES-26/ST-26.1 — WarehousesService: filtros/orden del listado y lectura por ID.
// Catálogo de solo lectura, no hay create/update/remove que testear. Todo mockeado: sin DB ni red.
// (El comportamiento real contra Postgres se cubre en test/warehouses.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { WarehousesService } from './warehouses.service.js';
import { WarehouseDto } from '../dto/warehouse.dto.js';
import { FindAllWarehousesParamsDto } from '../dto/find-all-warehouses-params.dto.js';
import { WarehouseNotFoundException } from '../exceptions/index.js';

const ROW = { id: 1, code: 'WH-LPZ-01', name: 'Centro de Distribución La Paz', address: 'Av. Autopista Viacha', latitude: -16.52, longitude: -68.169, contactName: null, contactPhone: null, receptionStartTime: '07:00:00', receptionEndTime: '19:00:00', active: true };

function buildService() {
    const rawRepo = {
        findOne:      vi.fn().mockResolvedValue(ROW),
        findAndCount: vi.fn().mockResolvedValue([[], 0]),
    };
    const service = new WarehousesService(rawRepo as any);
    return { service, rawRepo };
}

const branches = (where: any) => (Array.isArray(where) ? where : [where]);
const op = (f: any) => ({ type: f.type, value: f.value });

// ── listado, orden y filtros ───────────────────────────────────────────────────
describe('WarehousesService.findAll — orden y filtros', () => {
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        const result = await service.findAll(WarehouseDto, plainToInstance(FindAllWarehousesParamsDto, over));
        return { options: rawRepo.findAndCount.mock.calls[0][0], result };
    };

    it('ordena por nombre por defecto, desempatando por id', async () => {
        expect((await run()).options.order).toEqual({ name: 'ASC', id: 'ASC' });
    });

    it('sortBy/sortOrder cambian el campo y la dirección, siempre con id ASC al final', async () => {
        expect((await run({ sortBy: 'code' })).options.order).toEqual({ code: 'ASC', id: 'ASC' });
        expect((await run({ sortBy: 'createdAt', sortOrder: 'desc' })).options.order).toEqual({ createdAt: 'DESC', id: 'ASC' });
    });

    it('sin filtros, el where es {}', async () => {
        expect((await run()).options.where).toEqual({});
    });

    it('active filtra; un active vacío (convertido a null por el DTO) no filtra', async () => {
        expect((await run({ active: 'true' })).options.where).toEqual({ active: true });
        expect((await run({ active: '' })).options.where).toEqual({});
    });

    it('search busca en código o nombre (2 ramas del OR) con ILIKE contiene, sin distinguir mayúsculas', async () => {
        const list = branches((await run({ search: 'lpz' })).options.where);
        expect(list).toHaveLength(2);
        expect(op(list[0].code)).toEqual({ type: 'ilike', value: '%lpz%' });
        expect(op(list[1].name)).toEqual({ type: 'ilike', value: '%lpz%' });
    });

    it('search escapa los comodines: "50%" se busca literalmente', async () => {
        expect(op(branches((await run({ search: '50%' })).options.where)[0].code).value).toBe('%50\\%%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).options.where).toEqual({});
        expect((await run({ search: '   ' })).options.where).toEqual({});
    });

    it('search + active: cada rama del OR conserva el filtro', async () => {
        const list = branches((await run({ search: 'x', active: 'false' })).options.where);
        for (const branch of list) expect(branch).toMatchObject({ active: false });
    });

    it('pagination: skip/take y meta', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[ROW], 1]);

        const result = await service.findAll(WarehouseDto, plainToInstance(FindAllWarehousesParamsDto, { page: '2', limit: '5' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5 });
        expect(result.meta).toEqual({ page: 2, limit: 5, total: 1, pages: 1 });
    });
});

// ── lectura ───────────────────────────────────────────────────────────────────
describe('WarehousesService.findOneById', () => {
    it('throwException:false devuelve null en vez de lanzar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        expect(await service.findOneById(WarehouseDto, 1, { throwException: false })).toBeNull();
    });

    it('por defecto lanza WarehouseNotFoundException si no existe', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.findOneById(WarehouseDto, 999)).rejects.toThrow(WarehouseNotFoundException);
    });

    it('devuelve el almacén cuando existe', async () => {
        const { service } = buildService();

        const result = await service.findOneById(WarehouseDto, 1);

        expect(result).toEqual(ROW);
    });
});
