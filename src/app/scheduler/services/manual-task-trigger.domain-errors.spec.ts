import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ScheduledTaskFailedException } from '../exceptions/index.js';
import { MemoryTaskLock } from '../memory/memory-task-lock.adapter.js';
import { MemoryTaskRunLog } from '../memory/memory-task-run-log.adapter.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';
import { ManualTaskTriggerService } from './manual-task-trigger.service.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';

function setup(run: ScheduledTask['run']) {
    const registry = new ScheduledTaskRegistry();
    registry.register({ name: 'plan-generation', schedule: { kind: 'times', settingKey: 'plan_generation_times' }, run });
    const runner = new ScheduledTaskRunner(new MemoryTaskLock(new Set()), new MemoryTaskRunLog());
    return { service: new ManualTaskTriggerService(registry, runner), runner, registry };
}

describe('ManualTaskTriggerService with domain errors and summaries', () => {
    it('relays a 422 raised by the task as it is', async () => {
        const { service } = setup(async () => {
            throw new UnprocessableEntityException({ message: 'fix settings', error: 'PLANNING_SETTINGS_MISSING' });
        });

        const error = await service.trigger('plan-generation').catch((e) => e);

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(error.getResponse()).toMatchObject({ error: 'PLANNING_SETTINGS_MISSING' });
    });

    it('relays a 503 raised by the task (OSRM down) with its code', async () => {
        const { service } = setup(async () => {
            throw new ServiceUnavailableException({ message: 'osrm', error: 'OSRM_UNAVAILABLE' });
        });

        const error = await service.trigger('plan-generation').catch((e) => e);

        expect(error.getStatus()).toBe(503);
        expect(error.getResponse()).toMatchObject({ error: 'OSRM_UNAVAILABLE' });
    });

    it('keeps answering 500 SCHEDULED_TASK_FAILED for an unexpected error', async () => {
        const { service } = setup(async () => {
            throw new Error('boom');
        });

        await expect(service.trigger('plan-generation')).rejects.toBeInstanceOf(ScheduledTaskFailedException);
    });

    it('puts what the task returns in the response as summary', async () => {
        const { service } = setup(async () => ({ status: 'executed', createdBatchIds: [9] }));

        const result = await service.trigger('plan-generation');

        expect(result.summary).toEqual({ status: 'executed', createdBatchIds: [9] });
    });

    it('answers without summary when the task returns nothing', async () => {
        const { service } = setup(async () => undefined);

        const result = await service.trigger('plan-generation');

        expect('summary' in result).toBe(false);
    });

    it('the runner keeps the original exception as the cause of a failed outcome', async () => {
        const boom = new UnprocessableEntityException('x');
        const { runner, registry } = setup(async () => {
            throw boom;
        });

        const outcome = await runner.run(registry.get('plan-generation')!, { trigger: 'manual', occurrence: null });

        expect(outcome).toMatchObject({ status: 'failed', cause: boom });
    });
});
