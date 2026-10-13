import { describe, expect, it, vi } from 'vitest';
import {
    ScheduledTaskAlreadyRunningException,
    ScheduledTaskFailedException,
    ScheduledTaskNotAvailableException,
} from '../exceptions/index.js';
import { MemoryTaskLock } from '../memory/memory-task-lock.adapter.js';
import { MemoryTaskRunLog } from '../memory/memory-task-run-log.adapter.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';
import { ManualTaskTriggerService } from './manual-task-trigger.service.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';

const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
};

const setup = (run?: ScheduledTask['run'], shared: { held?: Set<string>; log?: MemoryTaskRunLog } = {}) => {
    const registry = new ScheduledTaskRegistry();
    if (run) {
        registry.register({ name: 'plan-generation', schedule: { kind: 'times', settingKey: 'plan_generation_times' }, run });
    }
    const log = shared.log ?? new MemoryTaskRunLog();
    const runner = new ScheduledTaskRunner(new MemoryTaskLock(shared.held ?? new Set()), log);
    return { service: new ManualTaskTriggerService(registry, runner), log };
};

describe('ManualTaskTriggerService', () => {
    it('runs the registered task as a manual run and answers when it finished', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const { service, log } = setup(run);

        const result = await service.trigger('plan-generation');

        expect(result).toEqual({ task: 'plan-generation', status: 'executed', finishedAt: expect.any(Date) });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', occurrence: null }));
        expect(log.runs).toEqual([expect.objectContaining({ trigger: 'manual', occurrence: null })]);
    });

    it('can be fired again right after: a manual run is not deduplicated', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const { service } = setup(run);

        await service.trigger('plan-generation');
        await service.trigger('plan-generation');

        expect(run).toHaveBeenCalledTimes(2);
    });

    it('answers 503 when nobody registered the task', async () => {
        const { service } = setup();

        await expect(service.trigger('plan-generation')).rejects.toBeInstanceOf(ScheduledTaskNotAvailableException);
    });

    it('answers 409 and starts nothing while the task is running (scheduled run or another instance)', async () => {
        const held = new Set<string>();
        const hold = gate();
        const other = setup(async () => await hold.opened, { held });
        const running = other.service.trigger('plan-generation');

        const run = vi.fn();
        const mine = setup(run, { held });
        await expect(mine.service.trigger('plan-generation')).rejects.toBeInstanceOf(ScheduledTaskAlreadyRunningException);

        expect(run).not.toHaveBeenCalled();
        hold.open();
        await running;
    });

    it('answers 500 when the task fails, without leaking the cause, and releases the lock', async () => {
        const held = new Set<string>();
        const { service } = setup(async () => {
            throw new Error('OSRM unavailable at 10.0.0.5');
        }, { held });

        const error = await service.trigger('plan-generation').catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ScheduledTaskFailedException);
        expect(JSON.stringify((error as ScheduledTaskFailedException).getResponse())).not.toContain('10.0.0.5');
        expect(held.size).toBe(0);
    });
});
