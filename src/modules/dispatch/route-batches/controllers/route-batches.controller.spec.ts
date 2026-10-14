// ST-50.4 — el actor de la reasignación manual sale siempre del token.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchesController } from './route-batches.controller.js';

describe('RouteBatchesController.reassignReviewer', () => {
    it('delega en el servicio con el lote, el nuevo revisor, el usuario del token y el motivo', async () => {
        const reviewer = { reassignReviewer: vi.fn().mockResolvedValue({ id: 5, status: 'provisional', reviewerUserId: 12, version: 0 }) };
        const controller = new RouteBatchesController(reviewer as any);

        const result = await controller.reassignReviewer(5, { reviewerUserId: 12, reason: 'Leave' }, 9);

        expect(reviewer.reassignReviewer).toHaveBeenCalledWith(5, 12, 9, 'Leave');
        expect(result).toEqual({ id: 5, status: 'provisional', reviewerUserId: 12, version: 0 });
    });
});
