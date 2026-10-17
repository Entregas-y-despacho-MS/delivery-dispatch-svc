import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { RouteReminderTask } from './route-reminder.task.js';

describe('RouteReminderTask', () => {
    it('registers route-reminder on route_reminder_time and runs the reminder service', async () => {
        const registry = new ScheduledTaskRegistry();
        const reminder = { run: vi.fn(async () => ({ status: 'executed' })) };

        new RouteReminderTask(registry, reminder as any).onModuleInit();

        const task = registry.get('route-reminder')!;
        expect(task.schedule).toEqual({ kind: 'time', settingKey: 'route_reminder_time' });
        const context = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(reminder.run).toHaveBeenCalledWith(context);
    });
});
