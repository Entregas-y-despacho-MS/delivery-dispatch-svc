import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { RouteBatchClosingService } from './route-batch-closing.service.js';

/** `queries` are answered in order: the open-dispatch lookup, the batch UPDATE ([rows, count]) and the event INSERT. */
function manager(answers: unknown[]) {
    const query = vi.fn();
    for (const answer of answers) query.mockResolvedValueOnce(answer);
    return { query } as unknown as EntityManager & { query: ReturnType<typeof vi.fn> };
}

describe('RouteBatchClosingService', () => {
    const service = new RouteBatchClosingService();

    it('does nothing while a dispatch of the batch is still assigned, out for delivery or in transit', async () => {
        const m = manager([[{ dispatch_id: 9 }]]);

        expect(await service.closeIfComplete(m, 5, { dispatchId: 1 })).toBe(false);
        expect(m.query).toHaveBeenCalledTimes(1);
        expect(m.query.mock.calls[0][1]).toEqual([5, ['assigned', 'out_for_delivery', 'in_transit']]);
    });

    it('closes an in_execution batch and writes the closed event with the context', async () => {
        const m = manager([[], [[{ closed_at: new Date() }], 1], []]);

        expect(await service.closeIfComplete(m, 5, { dispatchId: 1, dispatchStatus: 'delivered' })).toBe(true);
        const [sql, params] = m.query.mock.calls[2];
        expect(sql).toContain("'closed'");
        expect(params).toEqual([5, 'All route dispatches are outside active states.', JSON.stringify({ dispatchId: 1, dispatchStatus: 'delivered' })]);
    });

    it('leaves a batch that is not in_execution alone and writes no event (UPDATE matched no row)', async () => {
        const m = manager([[], [[], 0]]);

        expect(await service.closeIfComplete(m, 5, {})).toBe(false);
        expect(m.query).toHaveBeenCalledTimes(2);
    });
});
