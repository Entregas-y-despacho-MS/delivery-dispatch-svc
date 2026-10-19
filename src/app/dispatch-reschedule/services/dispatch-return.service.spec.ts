import { describe, expect, it, vi } from 'vitest';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, EntityManager } from 'typeorm';
import type { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import type { DispatchStatusPublicationService } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import type { DeliveryAttempts, DeliveryAttemptsService } from './delivery-attempts.service.js';
import type { DispatchLockService, LockedDispatch } from './dispatch-lock.service.js';
import { DispatchReturnService } from './dispatch-return.service.js';

const now = new Date('2026-10-19T15:00:00Z');

function dispatchRow(over: Partial<LockedDispatch> = {}): LockedDispatch {
    return { id: 5, status: 'not_delivered', type: 'delivery', version: 4, routeBatchId: 50, scheduledWindowStart: null, scheduledWindowEnd: null, customerConfirmation: 'confirmed', ...over };
}

function build(opts: { dispatch?: Partial<LockedDispatch>; attempts?: Partial<DeliveryAttempts>; incidentCode?: string | null; recordVersion?: number | null } = {}) {
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM dispatch_incidents')) return opts.incidentCode === null ? [] : [{ code: opts.incidentCode ?? 'INC-CUST-ABSENT' }];
        if (sql.includes('UPDATE dispatches')) return [[{ updated_at: new Date('2026-10-19T15:00:01Z') }], 1];
        return [];
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = { transaction: vi.fn(async (work: (m: EntityManager) => unknown) => await work(manager)) };
    const locks = { lockDispatchOnly: vi.fn().mockResolvedValue(dispatchRow(opts.dispatch)) };
    const attempts = { count: vi.fn().mockResolvedValue({ notDelivered: 2, incidents: 1, used: 3, limit: 3, limitReached: true, ...opts.attempts }) };
    const publication = { publish: vi.fn().mockResolvedValue(opts.recordVersion === undefined ? 1 : opts.recordVersion) };
    const dispatchEvents = { create: vi.fn().mockResolvedValue({}) };
    const events = { emit: vi.fn() };
    const service = new DispatchReturnService(
        dataSource as unknown as DataSource,
        locks as unknown as DispatchLockService,
        attempts as unknown as DeliveryAttemptsService,
        publication as unknown as DispatchStatusPublicationService,
        dispatchEvents as unknown as DispatchEventsService,
        events as unknown as EventEmitter2,
    );
    return { service, query, locks, publication, dispatchEvents, events };
}

describe('DispatchReturnService.returnToWarehouse', () => {
    it.each(['incident', 'not_delivered'])('returns a %s dispatch whose attempts are spent', async (status) => {
        const ctx = build({ dispatch: { status } });

        const result = await ctx.service.returnToWarehouse(5, { notes: 'No answer' }, 9, now);

        expect(result).toEqual({ dispatchId: 5, status: 'returned', previousStatus: status, closedAt: now.toISOString(), reasonCode: 'INC-CUST-ABSENT', attemptsUsed: 3, attemptsLimit: 3 });
    });

    it('queues the outbox message BEFORE writing the event and keeps its record version in the event', async () => {
        const ctx = build({ recordVersion: 2 });

        await ctx.service.returnToWarehouse(5, {}, 9, now);

        expect(ctx.publication.publish).toHaveBeenCalledWith(expect.anything(), {
            dispatchId: 5, status: 'returned', previousStatus: 'not_delivered', occurredAt: now, reasonCode: 'INC-CUST-ABSENT',
        });
        expect(ctx.publication.publish.mock.invocationCallOrder[0]).toBeLessThan(ctx.dispatchEvents.create.mock.invocationCallOrder[0]);
        expect(ctx.dispatchEvents.create.mock.calls[0][0].metadata).toMatchObject({ outboundRecordVersion: 2, reasonCode: 'INC-CUST-ABSENT', attemptsUsed: 3, notes: null });
    });

    it('closes the dispatch with the moment of the return, keeps its route and does not move the planning version', async () => {
        const ctx = build();

        await ctx.service.returnToWarehouse(5, {}, 9, now);

        const update = ctx.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches'))!;
        expect(String(update[0])).toContain('closed_at = $3::timestamptz');
        expect(String(update[0])).not.toContain('route_batch_id');
        expect(String(update[0])).not.toContain('version');
        expect(update[1]).toEqual([5, 'returned', now]);
        expect(ctx.events.emit).toHaveBeenCalledWith('dispatch.status_changed', { dispatchId: 5, status: 'returned', previousStatus: 'not_delivered', version: 4, updatedAt: '2026-10-19T15:00:01.000Z' });
    });

    it('sends no reasonCode when the dispatch has no incident', async () => {
        const ctx = build({ incidentCode: null });

        const result = await ctx.service.returnToWarehouse(5, {}, 9, now);

        expect(result.reasonCode).toBeNull();
        expect(ctx.publication.publish.mock.calls[0][1]).not.toHaveProperty('reasonCode');
    });

    it('does not fail when the message is not published for the status (record version null)', async () => {
        const ctx = build({ recordVersion: null });

        await ctx.service.returnToWarehouse(5, {}, 9, now);

        expect(ctx.dispatchEvents.create.mock.calls[0][0].metadata).not.toHaveProperty('outboundRecordVersion');
    });

    it('answers 409 while the attempts are not spent and writes nothing', async () => {
        const ctx = build({ attempts: { used: 1, limitReached: false } });

        await expect(ctx.service.returnToWarehouse(5, {}, 9, now)).rejects.toMatchObject({ response: { error: 'DELIVERY_ATTEMPTS_NOT_EXHAUSTED' } });
        expect(ctx.publication.publish).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it.each(['pending', 'scheduled', 'assigned', 'out_for_delivery', 'rescheduled', 'returned', 'delivered', 'cancelled'])('answers 409 for a dispatch in %s', async (status) => {
        const ctx = build({ dispatch: { status } });

        await expect(ctx.service.returnToWarehouse(5, {}, 9, now)).rejects.toMatchObject({ response: { error: 'DISPATCH_RETURN_NOT_ALLOWED' } });
        expect(ctx.publication.publish).not.toHaveBeenCalled();
    });

    it('answers 409 for a dispatch that is not a delivery', async () => {
        const ctx = build({ dispatch: { type: 'supplier_return' } });

        await expect(ctx.service.returnToWarehouse(5, {}, 9, now)).rejects.toMatchObject({ response: { error: 'DISPATCH_TYPE_NOT_SUPPORTED' } });
    });

    it('does not emit when the event cannot be written', async () => {
        const ctx = build();
        ctx.dispatchEvents.create.mockRejectedValueOnce(new Error('db down'));

        await expect(ctx.service.returnToWarehouse(5, {}, 9, now)).rejects.toThrow('db down');
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });
});
