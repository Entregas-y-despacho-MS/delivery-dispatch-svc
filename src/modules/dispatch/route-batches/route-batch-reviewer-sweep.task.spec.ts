import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../../../app/scheduler/services/scheduled-task-registry.service.js';
import { RouteBatchReviewerSweepTask } from './route-batch-reviewer-sweep.task.js';

describe('RouteBatchReviewerSweepTask', () => {
    const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date() };

    it('registers the sweep every 15 minutes and hands over the batches of ineligible reviewers', async () => {
        const registry = new ScheduledTaskRegistry();
        const reviewers = { reassignFromIneligibleReviewers: vi.fn(async () => [{ routeBatchId: 4 }, { routeBatchId: 9 }]) };

        new RouteBatchReviewerSweepTask(registry, reviewers as any).onModuleInit();

        const task = registry.get('route-batch-reviewer-sweep')!;
        expect(task.schedule).toEqual({ kind: 'every-minutes', minutes: 15 });
        await expect(task.run(context)).resolves.toEqual({ handedOver: 2 });
        expect(reviewers.reassignFromIneligibleReviewers).toHaveBeenCalledWith('scheduled_sweep');
    });

    it('reports nothing handed over when every reviewer is still eligible', async () => {
        const registry = new ScheduledTaskRegistry();
        const reviewers = { reassignFromIneligibleReviewers: vi.fn(async () => []) };
        new RouteBatchReviewerSweepTask(registry, reviewers as any).onModuleInit();

        await expect(registry.get('route-batch-reviewer-sweep')!.run(context)).resolves.toEqual({ handedOver: 0 });
    });

    it('lets a failure reach the runner so the occurrence stays open', async () => {
        const registry = new ScheduledTaskRegistry();
        const reviewers = { reassignFromIneligibleReviewers: vi.fn(async () => { throw new Error('db down'); }) };
        new RouteBatchReviewerSweepTask(registry, reviewers as any).onModuleInit();

        await expect(registry.get('route-batch-reviewer-sweep')!.run(context)).rejects.toThrow('db down');
    });
});
