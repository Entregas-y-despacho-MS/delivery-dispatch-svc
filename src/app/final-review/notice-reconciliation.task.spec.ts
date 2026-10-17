import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { NoticeReconciliationTask } from './notice-reconciliation.task.js';

describe('NoticeReconciliationTask', () => {
    it('registers notice-reconciliation every 5 minutes and runs the reconciliation service', async () => {
        const registry = new ScheduledTaskRegistry();
        const reconciliation = { run: vi.fn(async () => ({ status: 'executed' })) };

        new NoticeReconciliationTask(registry, reconciliation as any).onModuleInit();

        const task = registry.get('notice-reconciliation')!;
        expect(task.schedule).toEqual({ kind: 'every-minutes', minutes: 5 });
        const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(reconciliation.run).toHaveBeenCalledWith(context);
    });
});
