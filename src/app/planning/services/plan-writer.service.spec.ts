import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { DispatchEvent } from '../../../modules/dispatch/dispatch-events/entities/dispatch-event.entity.js';
import { RouteBatch } from '../../../modules/dispatch/route-batches/entities/route-batch.entity.js';
import type { ProposedBatch } from '../domain/plan-types.js';
import { PlanWriterService } from './plan-writer.service.js';

const proposal = (overrides: Partial<ProposedBatch> = {}): ProposedBatch => ({
    shiftDate: '2026-10-14',
    zoneId: 1,
    zoneCode: 'ZON-SUR',
    zoneName: 'Achumani',
    warehouseId: 1,
    vehicleId: 7,
    alternativeVehicleIds: [],
    proposedDriverId: 10,
    stops: [101, 102, 103].map((dispatchId, index) => ({ dispatchId, sequence: index + 1, windowStart: null, windowEnd: null })),
    splitReason: null,
    rescheduledDispatchIds: [],
    ...overrides,
});

const locked = (id: number, status = 'pending', over: Partial<{ route_batch_id: number | null; reserved: boolean }> = {}) => ({
    dispatch_id: id, status, route_batch_id: null, reserved: false, ...over,
});

function uniqueViolation(): QueryFailedError {
    const error = new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
    return error;
}

function build(options: { lockedRows: ReturnType<typeof locked>[]; insertFailures?: unknown[] }) {
    const saved: Record<string, unknown[]> = { RouteBatch: [], DispatchEvent: [], RouteBatchEvent: [] };
    const failures = [...(options.insertFailures ?? [])];
    let nextBatchId = 900;

    const repoFor = (entity: unknown) => {
        const name = entity === RouteBatch ? 'RouteBatch' : entity === DispatchEvent ? 'DispatchEvent' : 'RouteBatchEvent';
        return {
            create: (data: unknown) => data,
            save: vi.fn(async (data: unknown) => {
                if (name === 'RouteBatch') {
                    const failure = failures.shift();
                    if (failure) throw failure;
                    const row = { ...(data as object), id: nextBatchId++ };
                    saved[name].push(row);
                    return row;
                }
                saved[name].push(...(Array.isArray(data) ? data : [data]));
                return data;
            }),
        };
    };

    const manager: any = {
        query: vi.fn()
            .mockResolvedValueOnce(options.lockedRows)
            .mockResolvedValue([]),
        getRepository: vi.fn(repoFor),
    };
    manager.transaction = vi.fn(async (callback: (m: unknown) => unknown) => await callback(manager));

    const dataSource: any = { transaction: vi.fn(async (callback: (m: unknown) => unknown) => await callback(manager)) };
    const reviewer = { assignReviewer: vi.fn(async () => ({ routeBatchId: 900, reviewerUserId: 4, changed: true })) };
    const service = new PlanWriterService(dataSource, reviewer as any);
    return { service, manager, saved, reviewer, dataSource };
}

describe('PlanWriterService.writeNewBatch', () => {
    const context = { trigger: 'manual' as const, occurrence: null };

    it('creates a provisional batch, moves the orders to in_planning and numbers them', async () => {
        const { service, manager, saved } = build({ lockedRows: [locked(101), locked(102), locked(103)] });

        const result = await service.writeNewBatch(proposal(), context);

        expect(result).toEqual({ routeBatchId: 900, vehicleId: 7, plannedDispatchIds: [101, 102, 103], skippedDispatchIds: [] });
        expect(saved.RouteBatch[0]).toMatchObject({
            status: 'provisional', version: 0, shiftDate: '2026-10-14', deliveryZoneId: 1,
            originWarehouseId: 1, vehicleId: 7, driverId: null, proposedDriverId: 10,
        });

        const update = manager.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches'));
        expect(update[1][0]).toBe(900);
        expect(update[1][1]).toEqual([101, 102, 103]);
        expect(update[1][2]).toEqual([1, 2, 3]);
        expect(update[1][5]).toBe('in_planning');
        expect(update[0]).toContain('version = d.version + 1');
    });

    it('records one status event per order and a created event for the batch, all as system', async () => {
        const { service, saved } = build({ lockedRows: [locked(101), locked(102, 'rescheduled'), locked(103)] });

        await service.writeNewBatch(proposal({ rescheduledDispatchIds: [102] }), { trigger: 'scheduled', occurrence: 'plan-generation@2026-10-13T08:30' });

        expect(saved.DispatchEvent).toHaveLength(3);
        expect(saved.DispatchEvent[1]).toMatchObject({
            dispatchId: 102, eventType: 'status_changed', actorType: 'system',
            metadata: expect.objectContaining({ from: 'rescheduled', to: 'in_planning', routeBatchId: 900, sequenceOrder: 2 }),
        });
        expect(saved.RouteBatchEvent).toEqual([
            expect.objectContaining({
                routeBatchId: 900, eventType: 'created', actorType: 'system',
                metadata: expect.objectContaining({
                    zoneId: 1, zoneCode: 'ZON-SUR', zoneName: 'Achumani',
                    vehicleId: 7, proposedDriverId: 10, stops: 3, rescheduledDispatchIds: [102],
                    trigger: 'scheduled', occurrence: 'plan-generation@2026-10-13T08:30',
                }),
            }),
        ]);
    });

    it('assigns the reviewer inside the same transaction, passing its manager', async () => {
        const { service, manager, reviewer, dataSource } = build({ lockedRows: [locked(101), locked(102), locked(103)] });

        await service.writeNewBatch(proposal(), context);

        expect(dataSource.transaction).toHaveBeenCalledOnce();
        expect(reviewer.assignReviewer).toHaveBeenCalledWith(900, { manager });
    });

    it('leaves out the orders that changed meanwhile and numbers the rest without gaps', async () => {
        const { service, manager, saved } = build({
            lockedRows: [locked(101), locked(102, 'scheduled', { route_batch_id: 5 }), locked(103, 'pending', { reserved: true })],
        });

        const result = await service.writeNewBatch(proposal(), context);

        expect(result.plannedDispatchIds).toEqual([101]);
        expect(result.skippedDispatchIds).toEqual([102, 103]);
        const update = manager.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches'));
        expect(update[1][2]).toEqual([1]);
        expect(saved.DispatchEvent).toHaveLength(1);
        expect(saved.RouteBatchEvent[0]).toMatchObject({ metadata: expect.objectContaining({ stops: 1, skippedDispatchIds: [102, 103] }) });
    });

    it('creates nothing when no order can be taken any more', async () => {
        const { service, manager, saved, reviewer } = build({
            lockedRows: [locked(101, 'cancelled'), locked(102, 'in_planning'), locked(103, 'address_review')],
        });

        const result = await service.writeNewBatch(proposal(), context);

        expect(result).toEqual({ routeBatchId: null, vehicleId: null, plannedDispatchIds: [], skippedDispatchIds: [101, 102, 103] });
        expect(saved.RouteBatch).toEqual([]);
        expect(reviewer.assignReviewer).not.toHaveBeenCalled();
        expect(manager.query).toHaveBeenCalledOnce();
    });

    it('locks the orders FOR UPDATE before it decides anything', async () => {
        const { service, manager } = build({ lockedRows: [locked(101), locked(102), locked(103)] });

        await service.writeNewBatch(proposal(), context);

        expect(manager.query.mock.calls[0][0]).toContain('FOR UPDATE');
        expect(manager.query.mock.calls[0][1]).toEqual([[101, 102, 103]]);
    });

    describe('vehicle already taken that day', () => {
        it('tries the next vehicle that fits', async () => {
            const { service, saved } = build({
                lockedRows: [locked(101), locked(102), locked(103)],
                insertFailures: [uniqueViolation()],
            });

            const result = await service.writeNewBatch(proposal({ alternativeVehicleIds: [8, 9] }), context);

            expect(result.vehicleId).toBe(8);
            expect(saved.RouteBatch[0]).toMatchObject({ vehicleId: 8 });
        });

        it('gives up with the original error when no alternative is left', async () => {
            const error = uniqueViolation();
            const { service } = build({
                lockedRows: [locked(101), locked(102), locked(103)],
                insertFailures: [error, uniqueViolation()],
            });

            await expect(service.writeNewBatch(proposal({ alternativeVehicleIds: [8] }), context)).rejects.toBeInstanceOf(QueryFailedError);
        });

        it('does not swallow an error that is not a unique violation', async () => {
            const boom = new Error('connection lost');
            const { service } = build({
                lockedRows: [locked(101), locked(102), locked(103)],
                insertFailures: [boom],
            });

            await expect(service.writeNewBatch(proposal({ alternativeVehicleIds: [8] }), context)).rejects.toBe(boom);
        });
    });
});
