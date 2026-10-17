import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { FinalReviewEscalationTask } from './final-review-escalation.task.js';

describe('FinalReviewEscalationTask', () => {
    it('registers final-review-escalation on final_review_escalation_time and runs the escalation service', async () => {
        const registry = new ScheduledTaskRegistry();
        const escalation = { run: vi.fn(async () => ({ status: 'executed' })) };

        new FinalReviewEscalationTask(registry, escalation as any).onModuleInit();

        const task = registry.get('final-review-escalation')!;
        expect(task.schedule).toEqual({ kind: 'time', settingKey: 'final_review_escalation_time' });
        const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(escalation.run).toHaveBeenCalledWith(context);
    });
});
