// ST-215.5 — RouteBatchQueryService.findOne: detalle en una sola foto de solo lectura. Todo mockeado.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchQueryService } from './route-batch-query.service.js';
import { calculateRouteCapacity } from '../domain/route-capacity.js';
import { RouteBatchNotFoundException } from '../exceptions/index.js';

const vehicleCapacity = { capacityKg: 100, capacityM3: 1, maxPackageLengthCm: null, maxPackageWidthCm: null, maxPackageHeightCm: null };
const at = new Date('2026-10-16T20:00:00Z');

function batch(over: Record<string, unknown> = {}) {
    return {
        id: 4, status: 'pending_final_review', version: 3, shiftDate: '2026-10-17', vehicleId: 8, driverId: null,
        deliveryZone: { id: 3, code: 'ACH', name: 'Achumani' },
        vehicle: { id: 8, plate: '1234ABC', model: 'Hilux', type: 'pickup' },
        proposedDriver: { id: 20, fullName: 'Pedro Driver' },
        reviewerUser: null,
        ...over,
    };
}

function build(opts: { batch: unknown; dispatches?: unknown[]; packages?: unknown[]; event?: unknown }) {
    const manager = {
        getRepository: vi.fn(() => ({ findOne: vi.fn().mockResolvedValue(opts.batch) })),
        query: vi.fn(async (sql: string) => {
            if (/FROM dispatches d/.test(sql)) return opts.dispatches ?? [];
            if (/FROM dispatch_packages/.test(sql)) return opts.packages ?? [];
            if (/FROM route_batch_events/.test(sql)) return opts.event ? [opts.event] : [];
            return [];
        }),
    };
    const dataSource = { transaction: vi.fn(async (_level: string, fn: (m: unknown) => unknown) => fn(manager)) };
    const report = calculateRouteCapacity([{ dispatchId: 11, estimatedWeightKg: 25, packages: [] }], vehicleCapacity);
    const capacity = { report: vi.fn().mockResolvedValue(report) };
    return { service: new RouteBatchQueryService({} as any, capacity as any, dataSource as any), manager, dataSource, capacity };
}

const dispatchRow = (id: number, over: Record<string, unknown> = {}) => ({
    dispatchId: id, version: 5, status: 'in_planning', sequenceOrder: id, sourceOrderRef: `SO-${id}`,
    deliveryAddress: 'Av. Costanera 123', scheduledWindowStart: at, scheduledWindowEnd: at, ...over,
});

describe('RouteBatchQueryService.findOne', () => {
    it('lee todo en una transacción REPEATABLE READ de solo lectura y sin bloquear filas', async () => {
        const { service, dataSource, manager, capacity } = build({ batch: batch(), dispatches: [dispatchRow(11)] });

        await service.findOne(4);

        expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
        expect(manager.query.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
        expect(capacity.report).toHaveBeenCalledWith(4, 8, manager, { lock: false });
    });

    it('devuelve la versión del lote y de cada pedido, la capacidad completa y los bultos', async () => {
        const { service } = build({
            batch: batch(),
            dispatches: [dispatchRow(11), dispatchRow(12, { version: 7 })],
            packages: [{ id: 90, dispatchId: 12, externalPackageId: 'PKG-1', lengthCm: '40.00', widthCm: '30.00', heightCm: '20.00', grossWeightKg: '12.500' }],
        });

        const detail = await service.findOne(4);

        expect(detail).toMatchObject({ id: 4, version: 3, dispatchCount: 2, reviewer: null, capacity: { assignable: true, estimatedDispatchIds: [11] } });
        expect(detail.dispatches.map((d) => [d.dispatchId, d.version, d.estimated])).toEqual([[11, 5, true], [12, 7, false]]);
        expect(detail.dispatches[1].packages).toEqual([
            { id: 90, externalPackageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 20, grossWeightKg: 12.5 },
        ]);
        expect(detail.dispatches[0]).toMatchObject({ status: 'in_planning', scheduledWindowStart: at, scheduledWindowEnd: at, packages: [] });
    });

    it('un lote sin vehículo devuelve capacidad y ocupación nulas', async () => {
        const { service, capacity } = build({ batch: batch({ vehicleId: null, vehicle: null }), dispatches: [dispatchRow(11)] });

        const detail = await service.findOne(4);

        expect(capacity.report).not.toHaveBeenCalled();
        expect(detail).toMatchObject({ vehicle: null, capacity: null, occupancy: null });
    });

    it('un lote sin pedidos devuelve la lista vacía sin consultar los bultos', async () => {
        const { service, manager } = build({ batch: batch() });

        const detail = await service.findOne(4);

        expect(detail.dispatches).toEqual([]);
        expect(manager.query.mock.calls.some(([sql]) => /FROM dispatch_packages/.test(sql))).toBe(false);
    });

    it('trae el motivo del último corte fallido de un lote devuelto a provisional', async () => {
        const failure = { code: 'slot_not_met', dispatchIds: [11], detail: {} };
        const { service, manager } = build({
            batch: batch({ status: 'provisional' }),
            event: { eventType: 'cutoff_failed', createdAt: at, reason: 'slot_not_met', metadata: { failures: [failure], warnings: [] } },
        });

        const detail = await service.findOne(4);

        expect(detail.validation).toEqual({ result: 'failed', occurredAt: at, reason: 'slot_not_met', failures: [failure], warnings: [] });
        const eventSql = manager.query.mock.calls.map(([sql]) => sql as string).find((sql) => /route_batch_events/.test(sql))!;
        expect(eventSql).toMatch(/event_type IN \('cutoff_validated', 'cutoff_failed'\)/);
        expect(eventSql).toMatch(/ORDER BY created_at DESC, route_batch_event_id DESC\s+LIMIT 1/);
    });

    it('sin evento de corte la validación es nula', async () => {
        const { service } = build({ batch: batch() });

        expect((await service.findOne(4)).validation).toBeNull();
    });

    it('un lote inexistente es ROUTE_BATCH_NOT_FOUND', async () => {
        const { service } = build({ batch: null });

        await expect(service.findOne(999)).rejects.toBeInstanceOf(RouteBatchNotFoundException);
    });
});
