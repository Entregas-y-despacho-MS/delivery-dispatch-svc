import { describe, expect, it, vi } from 'vitest';
import { RouteBatchReassignmentService } from './route-batch-reassignment.service.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { RouteBatchReassignConflictException } from '../exceptions/route-batch-reassign-conflict.exception.js';
import { DispatchNotFoundException } from '../../dispatches/exceptions/dispatch-not-found.exception.js';
import { RescheduleReasonInvalidException } from '../../../../app/dispatch-reschedule/exceptions/reschedule-reason-invalid.exception.js';
import { RouteCapacityExceededException } from '../exceptions/route-capacity-exceeded.exception.js';
import { ROUTE_BATCH_REASSIGNED_EVENT } from '../events/route-batch-reassigned.event.js';
import { ROUTE_ASSIGNED_EVENT } from '../events/route-assigned.event.js';

const ORIGIN = { id: 10, status: 'in_execution', version: 5, driver_id: 4, vehicle_id: 2, shift_date: '2026-11-09' };
const TARGET = { id: 20, status: 'in_execution', version: 3, driver_id: 9, vehicle_id: 7, shift_date: '2026-11-09' };

function build() {
    const query = vi.fn();
    const manager = { query };
    const dataSource = { transaction: vi.fn((work: (manager: unknown) => unknown) => work(manager)) };
    const batchExit = { lock: vi.fn(), leave: vi.fn() };
    const capacity = { assertAssignable: vi.fn().mockResolvedValue(undefined) };
    const events = { emit: vi.fn() };
    const service = new RouteBatchReassignmentService(dataSource as never, batchExit as never, capacity as never, events as never);
    return { service, query, dataSource, batchExit, capacity, events };
}

const dto = { dispatchIds: [31], targetBatchId: 20, reasonCode: 'DRIVER-BREAKDOWN', version: 5, targetVersion: 3 };

function mockHappyPath(query: ReturnType<typeof vi.fn>, batchExit: { lock: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> }) {
    query
        .mockResolvedValueOnce([ORIGIN, TARGET]) // 1. lock both batches
        .mockResolvedValueOnce([{ reschedule_reason_id: 1 }]) // 2. reason
        .mockResolvedValueOnce([{ dispatch_id: 31, route_batch_id: 10, status: 'out_for_delivery' }]) // 3. requested dispatches
        .mockResolvedValueOnce([]) // 4. target's existing stops (empty)
        .mockResolvedValueOnce([]) // 5. UPDATE dispatches (move) for 31
        .mockResolvedValueOnce([[{ version: 4 }], 1]) // 6. UPDATE route_batches RETURNING version (target)
        .mockResolvedValueOnce([]) // 7. INSERT route_batch_events (target) for 31
        .mockResolvedValueOnce([{ route_batch_id: 10, name: 'Origen' }, { route_batch_id: 20, name: 'Centro' }]) // 8. zones for both batches
        .mockResolvedValueOnce([]) // 9. origin's current dispatches (post move: empty, its only stop left)
        .mockResolvedValueOnce([{ dispatch_id: 31, priority: 'normal' }]); // 10. target's current dispatches (post move)
    batchExit.lock.mockResolvedValue({ id: 10, status: 'in_execution', version: 5, stops: [{ dispatchId: 31, sequence: 1, windowStart: null }] });
    batchExit.leave.mockResolvedValue({ batchVersion: 6, closed: false });
}

describe('RouteBatchReassignmentService.reassign', () => {
    it('moves the requested dispatches, appends them at the end of the target sequence, and emits the events', async () => {
        const { service, query, batchExit, capacity, events } = build();
        mockHappyPath(query, batchExit);

        const result = await service.reassign(10, dto, 9);

        expect(result).toEqual({ fromBatchId: 10, toBatchId: 20, movedDispatchIds: [31], fromVersion: 6, toVersion: 4, fromBatchClosed: false });
        expect(batchExit.leave).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 10 }), 31, { actorUserId: 9, reason: 'DRIVER-BREAKDOWN', metadata: { toBatchId: 20 } });
        expect(capacity.assertAssignable).toHaveBeenCalledWith(20, 7, expect.anything());
        const moveCall = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches SET route_batch_id'));
        expect(moveCall[1]).toEqual([31, 20, 1]);
        expect(events.emit).toHaveBeenCalledWith(ROUTE_BATCH_REASSIGNED_EVENT, {
            fromBatchId: 10, toBatchId: 20, fromDriverId: 4, toDriverId: 9,
            dispatchIds: [31], fromVersion: 6, toVersion: 4, zoneName: 'Centro',
        });
        // route.assigned is emitted once per side too, so the board and its push listener (which only
        // know that event) refresh both rows without waiting for ST-63.3's own event.
        expect(events.emit).toHaveBeenCalledWith(ROUTE_ASSIGNED_EVENT, {
            routeId: 10, driverId: 4, vehicleId: 2, dispatchIds: [], dispatches: [], zoneName: 'Origen', version: 6,
        });
        expect(events.emit).toHaveBeenCalledWith(ROUTE_ASSIGNED_EVENT, {
            routeId: 20, driverId: 9, vehicleId: 7, dispatchIds: [31], dispatches: [{ dispatchId: 31, priority: 'normal' }], zoneName: 'Centro', version: 4,
        });
    });

    it('falls back to the default zone label on route.assigned when a batch has no zone', async () => {
        const { service, query, batchExit, events } = build();
        batchExit.lock.mockResolvedValue({ id: 10, status: 'in_execution', version: 5, stops: [{ dispatchId: 31, sequence: 1, windowStart: null }] });
        batchExit.leave.mockResolvedValue({ batchVersion: 6, closed: false });
        query
            .mockResolvedValueOnce([ORIGIN, TARGET])
            .mockResolvedValueOnce([{ reschedule_reason_id: 1 }])
            .mockResolvedValueOnce([{ dispatch_id: 31, route_batch_id: 10, status: 'out_for_delivery' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4 }], 1])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]) // no zone rows at all for either batch
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ dispatch_id: 31, priority: 'normal' }]);

        await service.reassign(10, dto, 9);

        expect(events.emit).toHaveBeenCalledWith(ROUTE_ASSIGNED_EVENT, expect.objectContaining({ routeId: 10, zoneName: 'Zona sin especificar' }));
        expect(events.emit).toHaveBeenCalledWith(ROUTE_ASSIGNED_EVENT, expect.objectContaining({ routeId: 20, zoneName: 'Zona sin especificar' }));
    });

    it('appends after the highest existing sequence_order of the target, not always at 1', async () => {
        const { service, query, batchExit } = build();
        query
            .mockResolvedValueOnce([ORIGIN, TARGET])
            .mockResolvedValueOnce([{ reschedule_reason_id: 1 }])
            .mockResolvedValueOnce([{ dispatch_id: 31, route_batch_id: 10, status: 'out_for_delivery' }])
            .mockResolvedValueOnce([{ sequence_order: 3 }, { sequence_order: 5 }]) // target already has stops up to 5
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4 }], 1])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ route_batch_id: 10, name: 'Origen' }, { route_batch_id: 20, name: 'Centro' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ dispatch_id: 31, priority: 'normal' }]);
        batchExit.lock.mockResolvedValue({ id: 10, status: 'in_execution', version: 5, stops: [{ dispatchId: 31, sequence: 1, windowStart: null }] });
        batchExit.leave.mockResolvedValue({ batchVersion: 6, closed: false });

        await service.reassign(10, dto, 9);

        const moveCall = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches SET route_batch_id'));
        expect(moveCall[1]).toEqual([31, 20, 6]);
    });

    it('rejects when the destination equals the origin', async () => {
        const { service } = build();

        await expect(service.reassign(10, { ...dto, targetBatchId: 10 }, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('404s when either batch does not exist', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN]); // target missing

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchNotFoundException);
    });

    it('rejects when the origin is not in_execution', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([{ ...ORIGIN, status: 'confirmed' }, TARGET]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('rejects when the target is not in_execution', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, { ...TARGET, status: 'provisional' }]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('rejects when the target has no vehicle or driver', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, { ...TARGET, vehicle_id: null }]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('rejects when the origin has no vehicle or driver', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([{ ...ORIGIN, vehicle_id: null }, TARGET]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('rejects when the batches are not the same shift day', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, { ...TARGET, shift_date: '2026-11-10' }]);

        await expect(service.reassign(10, dto, 9)).rejects.toMatchObject({ response: { error: 'ROUTE_BATCH_DIFFERENT_SHIFT_DATE' } });
    });

    it('409s on a stale origin version (Escenario 2)', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([{ ...ORIGIN, version: 99 }, TARGET]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('409s on a stale target version (Escenario 2)', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, { ...TARGET, version: 99 }]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('rejects an inactive/unknown reasonCode with 400', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, TARGET]).mockResolvedValueOnce([]); // no reason found

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RescheduleReasonInvalidException);
    });

    it('404s when a requested dispatch does not exist at all', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, TARGET]).mockResolvedValueOnce([{ reschedule_reason_id: 1 }]).mockResolvedValueOnce([]); // no dispatches found

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(DispatchNotFoundException);
    });

    it('409s when the dispatch does not belong to the origin batch', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, TARGET]).mockResolvedValueOnce([{ reschedule_reason_id: 1 }])
            .mockResolvedValueOnce([{ dispatch_id: 31, route_batch_id: 999, status: 'out_for_delivery' }]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('409s when the dispatch is not out_for_delivery (Escenario 3)', async () => {
        const { service, query } = build();
        query.mockResolvedValueOnce([ORIGIN, TARGET]).mockResolvedValueOnce([{ reschedule_reason_id: 1 }])
            .mockResolvedValueOnce([{ dispatch_id: 31, route_batch_id: 10, status: 'in_transit' }]);

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteBatchReassignConflictException);
    });

    it('409s when the destination has no capacity left (Escenario 3), rolling back the whole move', async () => {
        const { service, query, batchExit, capacity } = build();
        mockHappyPath(query, batchExit);
        capacity.assertAssignable.mockRejectedValue(new RouteCapacityExceededException({} as never));

        await expect(service.reassign(10, dto, 9)).rejects.toThrow(RouteCapacityExceededException);
    });

    it('reports the origin batch as closed when the last leave() call says so', async () => {
        const { service, query, batchExit } = build();
        mockHappyPath(query, batchExit);
        batchExit.leave.mockResolvedValue({ batchVersion: 6, closed: true });

        const result = await service.reassign(10, dto, 9);

        expect(result.fromBatchClosed).toBe(true);
    });

    it('moving several dispatches calls leave() once per dispatch with the version carried forward', async () => {
        const { service, query, batchExit } = build();
        const manyDto = { ...dto, dispatchIds: [31, 32] };
        query
            .mockResolvedValueOnce([ORIGIN, TARGET])
            .mockResolvedValueOnce([{ reschedule_reason_id: 1 }])
            .mockResolvedValueOnce([
                { dispatch_id: 31, route_batch_id: 10, status: 'out_for_delivery' },
                { dispatch_id: 32, route_batch_id: 10, status: 'out_for_delivery' },
            ])
            .mockResolvedValueOnce([]) // target stops
            .mockResolvedValueOnce([]) // move 31
            .mockResolvedValueOnce([]) // move 32
            .mockResolvedValueOnce([[{ version: 7 }], 1]) // route_batches update (+2)
            .mockResolvedValueOnce([]) // event 31
            .mockResolvedValueOnce([]) // event 32
            .mockResolvedValueOnce([{ route_batch_id: 10, name: null }, { route_batch_id: 20, name: null }])
            .mockResolvedValueOnce([]) // origin's current dispatches (post move: empty)
            .mockResolvedValueOnce([{ dispatch_id: 31, priority: 'normal' }, { dispatch_id: 32, priority: 'urgent' }]); // target's current dispatches
        batchExit.lock.mockResolvedValue({ id: 10, status: 'in_execution', version: 5, stops: [{ dispatchId: 31, sequence: 1, windowStart: null }, { dispatchId: 32, sequence: 2, windowStart: null }] });
        batchExit.leave.mockResolvedValueOnce({ batchVersion: 6, closed: false }).mockResolvedValueOnce({ batchVersion: 7, closed: false });

        const result = await service.reassign(10, manyDto, 9);

        expect(batchExit.leave).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ fromVersion: 7, toVersion: 7, movedDispatchIds: [31, 32] });
        const moveCalls = query.mock.calls.filter(([sql]: [string]) => sql.includes('UPDATE dispatches SET route_batch_id'));
        expect(moveCalls.map((call: [string, unknown[]]) => call[1])).toEqual([[31, 20, 1], [32, 20, 2]]);
        const routeBatchesUpdate = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE route_batches SET version'));
        expect(routeBatchesUpdate[1]).toEqual([20, 2]);
    });
});
