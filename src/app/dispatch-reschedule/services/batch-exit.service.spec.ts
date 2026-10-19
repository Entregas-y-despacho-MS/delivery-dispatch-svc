import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { RouteBatchClosingService } from '../../route-batch-closing/services/route-batch-closing.service.js';
import { BatchExitService, type LockedBatch } from './batch-exit.service.js';

const audit = { actorUserId: 9, reason: 'Coordinator rescheduled the delivery', metadata: { rescheduleId: 4 } };

function batch(status: string, stops: { id: number; seq: number | null }[]): LockedBatch {
    return { id: 50, status, version: 6, stops: stops.map((s) => ({ dispatchId: s.id, sequence: s.seq, windowStart: null })) };
}

function build(closed = false) {
    const query = vi.fn(async (sql: string) => (sql.startsWith('UPDATE dispatches\n') || sql.includes('RETURNING version') ? [[{ version: 3 }], 1] : []));
    const manager = { query } as unknown as EntityManager;
    const closing = { closeIfComplete: vi.fn().mockResolvedValue(closed) };
    const service = new BatchExitService(closing as unknown as RouteBatchClosingService);
    const sqls = () => query.mock.calls.map(([sql]) => String(sql));
    const events = () => query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO route_batch_events'));
    return { service, manager, closing, query, sqls, events };
}

describe('BatchExitService.leave', () => {
    it('provisional: frees the sequence, closes the gap of the others and bumps the batch version', async () => {
        const { service, manager, sqls, events } = build();

        const result = await service.leave(manager, batch('provisional', [{ id: 1, seq: 1 }, { id: 2, seq: 2 }, { id: 3, seq: 3 }]), 2, audit);

        expect(result).toMatchObject({ batchStatusAfter: 'provisional', batchVersion: 7, dispatchVersion: 3, cancelled: false, closed: false, shiftedDispatchIds: [3] });
        expect(sqls()[0]).toContain('SET route_batch_id = NULL, sequence_order = NULL, version = version + 1');
        expect(sqls().some((sql) => sql.includes('unnest($1::int[]) AS id'))).toBe(true);
        expect(events()).toHaveLength(1);
        expect(JSON.parse(events()[0][1][4])).toMatchObject({ dispatchId: 2, rescheduleId: 4, previousSequence: 2, batchStatusBefore: 'provisional', shiftedDispatchIds: [3] });
    });

    it('provisional and emptied: cancels the batch and records both events', async () => {
        const { service, manager, sqls, events } = build();

        const result = await service.leave(manager, batch('provisional', [{ id: 2, seq: 1 }]), 2, audit);

        expect(result).toMatchObject({ batchStatusAfter: 'cancelled', cancelled: true, batchVersion: 7 });
        expect(sqls().some((sql) => sql.includes('UPDATE route_batches SET status = $2'))).toBe(true);
        expect(events().map(([sql]) => String(sql).includes("'cancelled'"))).toEqual([false, true]);
    });

    it.each(['pending_final_review', 'confirmed'])('%s: does not renumber the other stops', async (status) => {
        const { service, manager, sqls } = build();

        const result = await service.leave(manager, batch(status, [{ id: 1, seq: 1 }, { id: 2, seq: 2 }, { id: 3, seq: 3 }]), 1, audit);

        expect(result).toMatchObject({ batchStatusAfter: status, batchVersion: 7, shiftedDispatchIds: [] });
        expect(sqls().some((sql) => sql.includes('unnest'))).toBe(false);
    });

    it('confirmed and emptied: cancels the batch', async () => {
        const { service, manager } = build();

        expect(await service.leave(manager, batch('confirmed', [{ id: 2, seq: 1 }]), 2, audit)).toMatchObject({ cancelled: true, batchStatusAfter: 'cancelled' });
    });

    it('in_execution: evaluates the automatic closing and reports the batch closed when it closes', async () => {
        const { service, manager, closing } = build(true);

        const result = await service.leave(manager, batch('in_execution', [{ id: 1, seq: 1 }, { id: 2, seq: 2 }]), 2, audit);

        expect(closing.closeIfComplete).toHaveBeenCalledWith(manager, 50, expect.objectContaining({ dispatchId: 2 }));
        expect(result).toMatchObject({ closed: true, batchStatusAfter: 'closed', cancelled: false });
    });

    it('in_execution with other open stops: stays in execution', async () => {
        const { service, manager } = build(false);

        expect(await service.leave(manager, batch('in_execution', [{ id: 1, seq: 1 }, { id: 2, seq: 2 }]), 2, audit))
            .toMatchObject({ closed: false, batchStatusAfter: 'in_execution', batchVersion: 7 });
    });

    it.each(['closed', 'cancelled'])('%s: the dispatch leaves and the event is written, the batch is not touched', async (status) => {
        const { service, manager, sqls, events, closing } = build();

        const result = await service.leave(manager, batch(status, [{ id: 1, seq: 1 }, { id: 2, seq: 2 }]), 2, audit);

        expect(result).toMatchObject({ batchStatusAfter: status, batchVersion: 6, cancelled: false, closed: false });
        expect(sqls().some((sql) => sql.includes('UPDATE route_batches'))).toBe(false);
        expect(closing.closeIfComplete).not.toHaveBeenCalled();
        expect(events()).toHaveLength(1);
    });
});
