import { describe, expect, it, vi } from 'vitest';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, EntityManager } from 'typeorm';
import type { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import type { SettingsService } from '../../../modules/settings/services/settings.service.js';
import type { RescheduleDispatchDto } from '../dto/reschedule-dispatch.dto.js';
import { DispatchReschedulingService } from './dispatch-rescheduling.service.js';
import type { BatchExitService, LockedBatch } from './batch-exit.service.js';
import type { DeliveryAttempts, DeliveryAttemptsService } from './delivery-attempts.service.js';
import type { DispatchLockService, LockedDispatch } from './dispatch-lock.service.js';

// Monday 2026-10-19, 11:00 in La Paz. The slot 09:00-11:00 of the 21st is 13:00Z-15:00Z.
const dto: RescheduleDispatchDto = { reasonCode: 'RES-OPS', windowStart: '2026-10-21T13:00:00Z', windowEnd: '2026-10-21T15:00:00Z', instructions: 'Call first' };
const previousStart = new Date('2026-10-20T13:00:00Z');
const previousEnd = new Date('2026-10-20T15:00:00Z');

function dispatchRow(over: Partial<LockedDispatch> = {}): LockedDispatch {
    return {
        id: 5, status: 'not_delivered', type: 'delivery', version: 4, routeBatchId: 50,
        scheduledWindowStart: previousStart, scheduledWindowEnd: previousEnd, customerConfirmation: 'confirmed', ...over,
    };
}

const batch: LockedBatch = { id: 50, status: 'in_execution', version: 6, stops: [] };

function build(opts: { dispatch?: Partial<LockedDispatch>; batch?: LockedBatch | null; attempts?: Partial<DeliveryAttempts>; reasonFound?: boolean } = {}) {
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM reschedule_reasons')) return opts.reasonFound === false ? [] : [{ reschedule_reason_id: 8 }];
        if (sql.includes('INSERT INTO dispatch_reschedules')) return [{ dispatch_reschedule_id: 17 }];
        if (sql.includes('UPDATE dispatches')) return [[{ version: 5, updated_at: new Date('2026-10-19T15:00:00Z') }], 1];
        return [];
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = { transaction: vi.fn(async (work: (m: EntityManager) => unknown) => await work(manager)) };
    const locks = { lock: vi.fn().mockResolvedValue({ dispatch: dispatchRow(opts.dispatch), batch: opts.batch === undefined ? batch : opts.batch }) };
    const attempts = { count: vi.fn().mockResolvedValue({ notDelivered: 1, incidents: 0, used: 1, limit: 3, limitReached: false, ...opts.attempts }) };
    const batchExit = { leave: vi.fn().mockResolvedValue({ batchId: 50, batchStatusBefore: 'in_execution', batchStatusAfter: 'closed', batchVersion: 7, dispatchVersion: 5, cancelled: false, closed: true, shiftedDispatchIds: [] }) };
    const dispatchEvents = { create: vi.fn().mockResolvedValue({}) };
    const settings = {
        getString: vi.fn(async (_key: string, fallback: string) => fallback),
        getNumber: vi.fn(async (_key: string, fallback: number) => fallback),
    };
    const events = { emit: vi.fn() };
    const service = new DispatchReschedulingService(
        dataSource as unknown as DataSource,
        locks as unknown as DispatchLockService,
        attempts as unknown as DeliveryAttemptsService,
        batchExit as unknown as BatchExitService,
        dispatchEvents as unknown as DispatchEventsService,
        settings as unknown as SettingsService,
        events as unknown as EventEmitter2,
    );
    return { service, query, dataSource, locks, attempts, batchExit, dispatchEvents, events };
}

const now = new Date('2026-10-19T15:00:00Z');

describe('DispatchReschedulingService.reschedule', () => {
    it('reschedules a not_delivered dispatch: records it, leaves the batch, updates the dispatch and emits both events', async () => {
        const ctx = build();

        const result = await ctx.service.reschedule(5, dto, 9, now);

        expect(result).toEqual({
            dispatchId: 5, status: 'rescheduled', rescheduleId: 17, version: 5,
            windowStart: '2026-10-21T13:00:00.000Z', windowEnd: '2026-10-21T15:00:00.000Z', shift: 'morning', attemptsUsed: 1, attemptsLimit: 3,
        });
        const insert = ctx.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_reschedules'))!;
        expect(String(insert[0])).toContain("'coordinator'");
        expect(insert[1]).toEqual([5, 8, 9, 50, previousStart, previousEnd, new Date(dto.windowStart), new Date(dto.windowEnd)]);
        expect(ctx.batchExit.leave).toHaveBeenCalledWith(expect.anything(), batch, 5, expect.objectContaining({ actorUserId: 9 }));
        // The version already moved when the dispatch left the batch: the UPDATE adds 0.
        const update = ctx.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches'))!;
        expect(update[1]).toEqual([5, 'rescheduled', new Date(dto.windowStart), new Date(dto.windowEnd), 0]);
        expect(ctx.events.emit).toHaveBeenCalledWith('dispatch.status_changed', expect.objectContaining({ dispatchId: 5, status: 'rescheduled', previousStatus: 'not_delivered', version: 5 }));
        expect(ctx.events.emit).toHaveBeenCalledWith('dispatch.rescheduled', expect.objectContaining({ dispatchId: 5, rescheduleId: 17, rescheduledBy: 'coordinator', reasonCode: 'RES-OPS' }));
    });

    it('writes the audit event with the instructions, the attempts and the batch outcome', async () => {
        const ctx = build();

        await ctx.service.reschedule(5, dto, 9, now);

        const [data] = ctx.dispatchEvents.create.mock.calls[0];
        expect(data).toMatchObject({ dispatchId: 5, eventType: 'status_changed', actorUserId: 9, actorType: 'user' });
        expect(data.metadata).toMatchObject({
            previousStatus: 'not_delivered', status: 'rescheduled', rescheduleId: 17, reasonCode: 'RES-OPS', instructions: 'Call first',
            attemptsUsed: 1, attemptsLimit: 3, shift: 'morning', fromBatchId: 50, batchStatusAfter: 'closed', customerChangeRequestResolved: false,
        });
    });

    it('a dispatch with no batch gets its version bumped by the UPDATE itself', async () => {
        const ctx = build({ dispatch: { status: 'scheduled', routeBatchId: null }, batch: null });

        await ctx.service.reschedule(5, dto, 9, now);

        expect(ctx.batchExit.leave).not.toHaveBeenCalled();
        const update = ctx.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches'))!;
        expect(update[1][4]).toBe(1);
        const insert = ctx.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_reschedules'))!;
        expect(insert[1][3]).toBeNull();
    });

    it('resolves a pending change request of the customer', async () => {
        const ctx = build({ dispatch: { customerConfirmation: 'change_requested' } });

        await ctx.service.reschedule(5, dto, 9, now);

        const update = ctx.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches'))!;
        expect(String(update[0])).toContain("WHEN customer_confirmation = 'change_requested' THEN 'rescheduled'");
        expect(ctx.dispatchEvents.create.mock.calls[0][0].metadata.customerChangeRequestResolved).toBe(true);
    });

    it.each(['incident', 'not_delivered', 'scheduled', 'assigned'])('admits a dispatch in %s', async (status) => {
        const ctx = build({ dispatch: { status } });

        expect((await ctx.service.reschedule(5, dto, 9, now)).status).toBe('rescheduled');
    });

    it.each(['pending', 'in_planning', 'out_for_delivery', 'in_transit', 'delivered', 'rescheduled', 'returned', 'cancelled'])('answers 409 for a dispatch in %s and writes nothing', async (status) => {
        const ctx = build({ dispatch: { status } });

        await expect(ctx.service.reschedule(5, dto, 9, now)).rejects.toMatchObject({ response: { error: 'DISPATCH_STATUS_NOT_RESCHEDULABLE' } });
        expect(ctx.events.emit).not.toHaveBeenCalled();
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
    });

    it('answers 409 for a dispatch that is not a delivery', async () => {
        const ctx = build({ dispatch: { type: 'supplier_pickup' } });

        await expect(ctx.service.reschedule(5, dto, 9, now)).rejects.toMatchObject({ response: { error: 'DISPATCH_TYPE_NOT_SUPPORTED' } });
    });

    it('answers 400 when the attempts limit is reached and tells to return the dispatch', async () => {
        const ctx = build({ attempts: { used: 3, limit: 3, limitReached: true } });

        await expect(ctx.service.reschedule(5, dto, 9, now)).rejects.toMatchObject({
            response: { error: 'RESCHEDULE_ATTEMPTS_LIMIT_REACHED', message: expect.stringContaining('returned to the warehouse') },
        });
        expect(ctx.batchExit.leave).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('answers 400 for an unknown or inactive reason', async () => {
        const ctx = build({ reasonFound: false });

        await expect(ctx.service.reschedule(5, dto, 9, now)).rejects.toMatchObject({ response: { error: 'RESCHEDULE_REASON_INVALID' } });
        expect(ctx.batchExit.leave).not.toHaveBeenCalled();
    });

    it('answers 400 for a past date before opening any transaction', async () => {
        const ctx = build();

        await expect(ctx.service.reschedule(5, { ...dto, windowStart: '2026-10-18T13:00:00Z', windowEnd: '2026-10-18T15:00:00Z' }, 9, now))
            .rejects.toMatchObject({ response: { error: 'INVALID_RESCHEDULE_WINDOW', message: 'The agreed date cannot be before today.' } });
        expect(ctx.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers 400 for a window that is not one of the delivery slots', async () => {
        const ctx = build();

        await expect(ctx.service.reschedule(5, { ...dto, windowEnd: '2026-10-21T17:00:00Z' }, 9, now))
            .rejects.toMatchObject({ response: { error: 'INVALID_RESCHEDULE_WINDOW' } });
    });

    it('does not emit when the transaction fails after the writes', async () => {
        const ctx = build();
        ctx.dispatchEvents.create.mockRejectedValueOnce(new Error('db down'));

        await expect(ctx.service.reschedule(5, dto, 9, now)).rejects.toThrow('db down');
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });
});
