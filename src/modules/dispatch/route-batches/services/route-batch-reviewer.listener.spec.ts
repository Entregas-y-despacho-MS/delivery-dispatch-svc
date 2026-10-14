// ST-50.4 — el listener solo dispara el barrido idempotente y nunca propaga un error.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchReviewerListener } from './route-batch-reviewer.listener.js';

describe('RouteBatchReviewerListener', () => {
    it('al cambiar la elegibilidad de un usuario corre el barrido con el motivo como trigger', async () => {
        const reviewers = { reassignFromIneligibleReviewers: vi.fn().mockResolvedValue([]) };
        const listener = new RouteBatchReviewerListener(reviewers as any);

        await listener.onUserEligibilityChanged({ userId: 5, reason: 'deactivated' });

        expect(reviewers.reassignFromIneligibleReviewers).toHaveBeenCalledWith('user_deactivated');
    });

    it('si el barrido falla no propaga el error (el cambio del usuario ya está confirmado)', async () => {
        const reviewers = { reassignFromIneligibleReviewers: vi.fn().mockRejectedValue(new Error('db down')) };
        const listener = new RouteBatchReviewerListener(reviewers as any);

        await expect(listener.onUserEligibilityChanged({ userId: 5, reason: 'deleted' })).resolves.toBeUndefined();
    });
});
