import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { FinalReviewAlertTask } from './final-review-alert.task.js';

describe('FinalReviewAlertTask', () => {
    it('registers final-review-alert on final_review_end_time and runs the alert service', async () => {
        const registry = new ScheduledTaskRegistry();
        const alert = { run: vi.fn(async () => ({ status: 'executed' })) };

        new FinalReviewAlertTask(registry, alert as any).onModuleInit();

        const task = registry.get('final-review-alert')!;
        expect(task.schedule).toEqual({ kind: 'time', settingKey: 'final_review_end_time' });
        const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(alert.run).toHaveBeenCalledWith(context);
    });
});
