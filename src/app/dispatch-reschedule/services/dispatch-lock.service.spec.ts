import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { DispatchLockService } from './dispatch-lock.service.js';
import type { BatchExitService } from './batch-exit.service.js';

const dispatchRow = {
    id: 5, status: 'not_delivered', type: 'delivery', version: 4, route_batch_id: 50,
    scheduled_window_start: null, scheduled_window_end: null, customer_confirmation: 'pending',
};

function build(answers: unknown[][], lockedBatch: unknown = { id: 50, status: 'confirmed', version: 2, stops: [] }) {
    const query = vi.fn();
    for (const answer of answers) query.mockResolvedValueOnce(answer);
    const batchExit = { lock: vi.fn().mockResolvedValue(lockedBatch) };
    return { service: new DispatchLockService(batchExit as unknown as BatchExitService), manager: { query } as unknown as EntityManager, batchExit, query };
}

describe('DispatchLockService.lock', () => {
    it('locks the batch before the dispatch and returns both', async () => {
        const { service, manager, batchExit, query } = build([[{ route_batch_id: 50 }], [dispatchRow]]);

        const locked = await service.lock(manager, 5);

        expect(batchExit.lock).toHaveBeenCalledWith(manager, 50);
        expect(String(query.mock.calls[1][0])).toContain('FOR UPDATE OF d');
        expect(locked.batch).toMatchObject({ id: 50 });
        expect(locked.dispatch).toMatchObject({ id: 5, status: 'not_delivered', type: 'delivery', routeBatchId: 50, customerConfirmation: 'pending' });
    });

    it('a dispatch with no batch locks only itself', async () => {
        const { service, manager, batchExit } = build([[{ route_batch_id: null }], [{ ...dispatchRow, route_batch_id: null }]]);

        expect((await service.lock(manager, 5)).batch).toBeNull();
        expect(batchExit.lock).not.toHaveBeenCalled();
    });

    it('answers 404 for a dispatch that does not exist', async () => {
        const { service, manager } = build([[]]);

        await expect(service.lock(manager, 5)).rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_FOUND' } });
    });

    it('answers 409 when the dispatch moved to another batch while it was being locked', async () => {
        const { service, manager } = build([[{ route_batch_id: 50 }], [{ ...dispatchRow, route_batch_id: 51 }]]);

        await expect(service.lock(manager, 5)).rejects.toMatchObject({ response: { error: 'DISPATCH_CHANGED_CONCURRENTLY' } });
    });
});
