import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskRegistry } from '../scheduler/services/scheduled-task-registry.service.js';
import { PlanGenerationTask } from './plan-generation.task.js';

describe('PlanGenerationTask', () => {
    it('registers plan-generation on plan_generation_times and runs the generation service', async () => {
        const registry = new ScheduledTaskRegistry();
        const generation = { run: vi.fn(async () => ({ status: 'executed' })) };

        new PlanGenerationTask(registry, generation as any).onModuleInit();

        const task = registry.get('plan-generation')!;
        expect(task.schedule).toEqual({ kind: 'times', settingKey: 'plan_generation_times' });
        const context = { trigger: 'schedule' as const, occurrence: 'plan-generation@x', startedAt: new Date() };
        await expect(task.run(context)).resolves.toEqual({ status: 'executed' });
        expect(generation.run).toHaveBeenCalledWith(context);
    });
});
