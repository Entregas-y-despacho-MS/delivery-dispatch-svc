import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { RouteCutoffTask } from './route-cutoff.task.js';

describe('RouteCutoffTask', () => {
    it('registers route-cutoff on route_cutoff_time and runs the cutoff service', async () => {
        const registry = new ScheduledTaskRegistry();
        const cutoff = { run: vi.fn(async () => ({ status: 'executed' })) };

        new RouteCutoffTask(registry, cutoff as any).onModuleInit();

        const task = registry.get('route-cutoff')!;
        expect(task.schedule).toEqual({ kind: 'times', settingKey: 'route_cutoff_time' });
        const context = { trigger: 'manual' as const, occurrence: null, startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(cutoff.run).toHaveBeenCalledWith(context);
    });
});
