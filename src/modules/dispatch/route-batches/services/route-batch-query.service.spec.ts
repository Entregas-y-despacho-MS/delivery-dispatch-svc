// ST-215.5 — RouteBatchQueryService.findAll: filtros, revisor «o sin revisor», ocupación y paginación. Todo mockeado.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchQueryService } from './route-batch-query.service.js';
import { calculateRouteCapacity } from '../domain/route-capacity.js';

const vehicleCapacity = { capacityKg: 100, capacityM3: 1, maxPackageLengthCm: null, maxPackageWidthCm: null, maxPackageHeightCm: null };

function batch(over: Record<string, unknown> = {}) {
    return {
        id: 1, status: 'provisional', version: 2, shiftDate: '2026-10-17', vehicleId: 8, driverId: null,
        deliveryZone: { id: 3, code: 'ACH', name: 'Achumani' },
        vehicle: { id: 8, plate: '1234ABC', model: 'Hilux', type: 'pickup' },
        proposedDriver: { id: 20, fullName: 'Pedro Driver' },
        reviewerUser: { id: 7, fullName: 'Maria Lopez' },
        ...over,
    };
}

function build(rows: unknown[], total = rows.length) {
    const where: Array<[string, unknown?]> = [];
    const orWhere: Array<[string, unknown?]> = [];
    const qb: Record<string, any> = {
        leftJoinAndSelect: vi.fn().mockReturnThis(),
        andWhere: vi.fn((cond: unknown, p?: unknown) => {
            if (typeof cond === 'string') where.push([cond, p]);
            else (cond as { whereFactory: (q: unknown) => void }).whereFactory({ orWhere: (c: string, q?: unknown) => orWhere.push([c, q]) });
            return qb;
        }),
        orderBy: vi.fn().mockReturnThis(),
        addOrderBy: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        take: vi.fn().mockReturnThis(),
        getManyAndCount: vi.fn().mockResolvedValue([rows, total]),
    };
    const repo = { createQueryBuilder: vi.fn(() => qb), query: vi.fn().mockResolvedValue([{ id: 1, total: '3' }]) };
    const capacity = {
        report: vi.fn().mockResolvedValue(
            calculateRouteCapacity([{ dispatchId: 5, estimatedWeightKg: 25, packages: [] }], vehicleCapacity),
        ),
    };
    return { service: new RouteBatchQueryService(repo as any, capacity as any), qb, repo, capacity, where, orWhere };
}

const base = { page: 1, limit: 10 };

describe('RouteBatchQueryService.findAll', () => {
    it('devuelve la fila con zona, vehículo, conductor, revisor, cantidad de pedidos y ocupación', async () => {
        const { service, capacity } = build([batch()]);

        const result = await service.findAll({ ...base });

        expect(capacity.report).toHaveBeenCalledWith(1, 8);
        expect(result.data).toEqual([{
            id: 1, status: 'provisional', version: 2, shiftDate: '2026-10-17',
            zone: { id: 3, code: 'ACH', name: 'Achumani' },
            vehicle: { id: 8, plate: '1234ABC', model: 'Hilux', type: 'pickup' },
            proposedDriver: { id: 20, fullName: 'Pedro Driver' },
            reviewer: { id: 7, fullName: 'Maria Lopez' },
            dispatchCount: 3,
            occupancy: {
                weight: { actual: 25, capacity: 100, usedPercent: 25 },
                volume: { actual: 0, capacity: 1, usedPercent: 0 },
                estimatedDispatchIds: [5],
                assignable: true,
            },
        }]);
        expect(result.meta).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
    });

    it('un lote sin vehículo ni revisor devuelve ocupación nula sin calcular la capacidad', async () => {
        const { service, capacity } = build([batch({ vehicleId: null, vehicle: null, reviewerUser: null, proposedDriver: null })]);

        const [row] = (await service.findAll({ ...base })).data;

        expect(capacity.report).not.toHaveBeenCalled();
        expect(row).toMatchObject({ vehicle: null, reviewer: null, proposedDriver: null, occupancy: null });
    });

    it('un lote sin pedidos cuenta cero', async () => {
        const { service, repo } = build([batch({ id: 9 })]);
        repo.query.mockResolvedValue([]);

        expect((await service.findAll({ ...base })).data[0].dispatchCount).toBe(0);
    });

    it('sin resultados no consulta cantidades y devuelve cero páginas', async () => {
        const { service, repo } = build([], 0);

        const result = await service.findAll({ ...base });

        expect(repo.query).not.toHaveBeenCalled();
        expect(result).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
    });

    it('filtra por estado y fecha del turno', async () => {
        const { service, where } = build([]);

        await service.findAll({ ...base, status: 'pending_final_review' as any, shiftDate: '2026-10-17' });

        expect(where).toEqual([
            ['b.status = :status', { status: 'pending_final_review' }],
            ['b.shiftDate = :shiftDate', { shiftDate: '2026-10-17' }],
        ]);
    });

    it('revisor solo: únicamente los de ese revisor', async () => {
        const { service, orWhere } = build([]);

        await service.findAll({ ...base, reviewerUserId: 7 });

        expect(orWhere).toEqual([['b.reviewerUserId = :reviewerUserId', { reviewerUserId: 7 }]]);
    });

    it('withoutReviewer solo: únicamente los lotes sin revisor', async () => {
        const { service, orWhere } = build([]);

        await service.findAll({ ...base, withoutReviewer: true });

        expect(orWhere).toEqual([['b.reviewerUserId IS NULL', undefined]]);
    });

    it('revisor y withoutReviewer juntos: los del revisor o los sin revisor', async () => {
        const { service, orWhere } = build([]);

        await service.findAll({ ...base, reviewerUserId: 7, withoutReviewer: true });

        expect(orWhere).toEqual([['b.reviewerUserId = :reviewerUserId', { reviewerUserId: 7 }], ['b.reviewerUserId IS NULL', undefined]]);
    });

    it('withoutReviewer=false no agrega ningún filtro de revisor', async () => {
        const { service, qb } = build([]);

        await service.findAll({ ...base, withoutReviewer: false });

        expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('ordena por fecha del turno e id y pagina', async () => {
        const { service, qb } = build([], 45);

        const result = await service.findAll({ page: 3, limit: 10 });

        expect(qb.orderBy).toHaveBeenCalledWith('b.shiftDate', 'ASC');
        expect(qb.addOrderBy).toHaveBeenCalledWith('b.id', 'ASC');
        expect(qb.skip).toHaveBeenCalledWith(20);
        expect(qb.take).toHaveBeenCalledWith(10);
        expect(result.meta).toEqual({ page: 3, limit: 10, total: 45, pages: 5 });
    });
});
