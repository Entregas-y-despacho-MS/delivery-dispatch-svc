import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { CustomerNotificationRecoveryTask } from './customer-notification-recovery.task.js';

describe('CustomerNotificationRecoveryTask', () => {
    it('registers customer-notification-recovery every 5 minutes and runs the recovery, which reads the clock itself', async () => {
        const registry = new ScheduledTaskRegistry();
        const summary = { claimed: 2, sent: 2, bounced: 0, failed: 0, exhausted: 0, errors: 0 };
        const notices = { recoverDue: vi.fn(async () => summary) };

        new CustomerNotificationRecoveryTask(registry, notices as any).onModuleInit();

        const task = registry.get('customer-notification-recovery')!;
        expect(task.schedule).toEqual({ kind: 'every-minutes', minutes: 5 });
        const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date('2026-11-19T16:00:00.000Z') };
        await expect(task.run(context)).resolves.toEqual(summary);
        expect(notices.recoverDue).toHaveBeenCalledWith();
    });
});
