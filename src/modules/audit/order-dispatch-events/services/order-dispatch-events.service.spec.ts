import { describe, expect, it, vi } from 'vitest';
import { runWithCorrelationId } from '../context/correlation-context.js';
import { ORDER_DISPATCH_ACTIONS } from '../domain/order-dispatch-event-actions.js';
import { OrderDispatchEventsService } from './order-dispatch-events.service.js';

function setup(rows: { dispatch?: unknown; role?: unknown } = {}) {
    const insert = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM dispatches')) return rows.dispatch === undefined ? [{ source_order_ref: 'SO-1', route_batch_id: 9 }] : rows.dispatch;
        if (sql.includes('FROM users')) return rows.role === undefined ? [{ name: 'coordinator' }] : rows.role;
        return [];
    });
    const manager = { getRepository: vi.fn(() => ({ insert })), query };
    const repo = { find: vi.fn().mockResolvedValue([]) };
    return { service: new OrderDispatchEventsService(repo as never), manager: manager as never, insert, query, repo };
}

describe('OrderDispatchEventsService.record', () => {
    it('inserts through the caller manager as a success event with the system role when there is no actor', async () => {
        const { service, manager, insert } = setup();
        const id = await service.record({
            sourceOrderRef: 'SO-1', dispatchId: 4, action: ORDER_DISPATCH_ACTIONS.CREATED, newStatus: 'pending',
            correlationId: 'req-12345678', occurredAt: new Date('2026-11-21T10:00:00Z'),
        }, { manager });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({
            id, sourceOrderRef: 'SO-1', dispatchId: 4, routeBatchId: null, actorUserId: null, actorRole: 'system',
            action: 'dispatch.created', previousStatus: null, newStatus: 'pending', result: 'success', correlationId: 'req-12345678',
        }));
    });

    it('looks the actor role up when only the id is known, and keeps an explicit role', async () => {
        const { service, manager, insert, query } = setup();
        await service.record({ sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.CANCELLED, actor: { id: 7 } }, { manager });
        expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: 7, actorRole: 'coordinator' }));
        query.mockClear();
        await service.record({ sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.DEPARTED, actor: { id: 8, role: 'driver' } }, { manager });
        expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: 8, actorRole: 'driver' }));
        expect(query).not.toHaveBeenCalled();
    });

    it('takes the correlation id of the request in progress, and a new one outside HTTP', async () => {
        const { service, manager, insert } = setup();
        await runWithCorrelationId('http-request-1', () => service.record({ sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.ASSIGNED }, { manager }));
        expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ correlationId: 'http-request-1' }));
        await service.record({ sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.ASSIGNED }, { manager });
        expect((insert.mock.calls.at(-1)![0] as { correlationId: string }).correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('stores only a sanitized detail', async () => {
        const { service, manager, insert } = setup();
        await service.record({
            sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.WAREHOUSE_RECEIVED,
            detail: { receiptId: 'R-1', password: 'x', contactEmail: 'a@b.c', nested: { a: 1 } },
        }, { manager });
        expect((insert.mock.calls[0]![0] as { detail: unknown }).detail).toEqual({ receiptId: 'R-1' });
    });

    it('does not swallow an insert failure: the command must fail with it', async () => {
        const { service, manager, insert } = setup();
        insert.mockRejectedValue(new Error('permission denied for table order_dispatch_events'));
        await expect(service.record({ sourceOrderRef: 'SO-1', action: ORDER_DISPATCH_ACTIONS.CREATED }, { manager })).rejects.toThrow('permission denied');
    });
});

describe('OrderDispatchEventsService.recordForDispatch', () => {
    it('links dispatch, order and the dispatch batch from the stored row', async () => {
        const { service, manager, insert } = setup();
        await service.recordForDispatch(4, { action: ORDER_DISPATCH_ACTIONS.ASSIGNED, previousStatus: 'scheduled', newStatus: 'assigned' }, { manager });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sourceOrderRef: 'SO-1', dispatchId: 4, routeBatchId: 9, previousStatus: 'scheduled', newStatus: 'assigned' }));
    });

    it('lets the caller state the batch (e.g. the one the dispatch just left)', async () => {
        const { service, manager, insert } = setup();
        await service.recordForDispatch(4, { action: ORDER_DISPATCH_ACTIONS.RESCHEDULED, routeBatchId: null }, { manager });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ routeBatchId: null }));
    });

    it('fails when the dispatch does not exist, so no orphan event is written', async () => {
        const { service, manager, insert } = setup({ dispatch: [] });
        await expect(service.recordForDispatch(404, { action: ORDER_DISPATCH_ACTIONS.CANCELLED }, { manager })).rejects.toThrow('dispatch 404 does not exist');
        expect(insert).not.toHaveBeenCalled();
    });
});

describe('OrderDispatchEventsService reads', () => {
    it('reads a dispatch or an order oldest first and never writes', async () => {
        const { service, repo } = setup();
        await service.findByDispatch(4);
        await service.findByOrder('SO-1');
        expect(repo.find).toHaveBeenNthCalledWith(1, { where: { dispatchId: 4 }, order: { occurredAt: 'ASC', createdAt: 'ASC', id: 'ASC' } });
        expect(repo.find).toHaveBeenNthCalledWith(2, { where: { sourceOrderRef: 'SO-1' }, order: { occurredAt: 'ASC', createdAt: 'ASC', id: 'ASC' } });
    });
});
