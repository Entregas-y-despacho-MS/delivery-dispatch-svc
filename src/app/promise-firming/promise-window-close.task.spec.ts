import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { PromiseWindowCloseTask } from './promise-window-close.task.js';

describe('PromiseWindowCloseTask', () => {
    it('registers promise-window-close every 5 minutes and closes the window at the run start', async () => {
        const registry = new ScheduledTaskRegistry();
        const close = { run: vi.fn(async () => ({ candidates: 0, firmed: 0, skipped: 0, incomplete: 0, failed: 0 })) };

        new PromiseWindowCloseTask(registry, close as never).onModuleInit();

        const task = registry.get('promise-window-close')!;
        expect(task.schedule).toEqual({ kind: 'every-minutes', minutes: 5 });
        const startedAt = new Date('2026-10-15T20:45:00.000Z');
        await task.run({ trigger: 'schedule', occurrence: 'promise-window-close@x', startedAt });
        expect(close.run).toHaveBeenCalledWith(startedAt);
    });

    it('lets a failure of the close propagate so the runner records a failed run', async () => {
        const registry = new ScheduledTaskRegistry();
        const close = { run: vi.fn().mockRejectedValue(new Error('1 of 2 dispatches failed')) };
        new PromiseWindowCloseTask(registry, close as never).onModuleInit();

        await expect(
            registry.get('promise-window-close')!.run({ trigger: 'schedule', occurrence: null, startedAt: new Date() }),
        ).rejects.toThrow('failed');
    });
});
