import { describe, expect, it, vi } from 'vitest';
import { MemoryTaskLock } from '../memory/memory-task-lock.adapter.js';
import { MemoryTaskRunLog } from '../memory/memory-task-run-log.adapter.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';
import type { TaskRunRecord } from '../ports/task-run-log.port.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';
import { SchedulerTicker } from './scheduler-ticker.service.js';

// America/La_Paz is UTC-4 all year: 08:30 there is 12:30Z.
const LA_PAZ_0830 = new Date('2026-10-13T12:30:00.000Z');
const LA_PAZ_0831 = new Date('2026-10-13T12:31:00.000Z');
const LA_PAZ_1500 = new Date('2026-10-13T19:00:00.000Z');

/** A fake SettingsService backed by a mutable object, like the live cache of the real one. */
const settingsOf = (values: Record<string, string>) => ({
    values,
    getString: vi.fn(async (key: string, fallback: string) => values[key] ?? fallback),
});

const task = (name: string, schedule: ScheduledTask['schedule'], run = vi.fn().mockResolvedValue(undefined)) => ({
    name,
    schedule,
    run,
});

/** One backend instance with the given tasks; instances sharing `held`/`runs` talk to the same "database". */
const instance = (
    tasks: ScheduledTask[],
    settings: ReturnType<typeof settingsOf>,
    options: { enabled?: boolean; held?: Set<string>; runs?: TaskRunRecord[] } = {},
) => {
    const registry = new ScheduledTaskRegistry();
    tasks.forEach((entry) => registry.register(entry));
    const runner = new ScheduledTaskRunner(
        new MemoryTaskLock(options.held ?? new Set()),
        new MemoryTaskRunLog(options.runs ?? []),
    );
    return new SchedulerTicker({ enabled: options.enabled ?? true } as never, registry, runner, settings as never);
};

describe('SchedulerTicker', () => {
    const generation = () =>
        task('plan-generation', { kind: 'times', settingKey: 'plan_generation_times' });

    it('runs a task at each configured time in America/La_Paz and not at other minutes', async () => {
        const settings = settingsOf({ plan_generation_times: '08:30,13:30' });
        const entry = generation();
        const ticker = instance([entry], settings);

        await ticker.tick(LA_PAZ_0831);
        expect(entry.run).not.toHaveBeenCalled();

        await ticker.tick(LA_PAZ_0830);
        expect(entry.run).toHaveBeenCalledTimes(1);
        expect(entry.run).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'schedule', occurrence: 'plan-generation@2026-10-13T08:30' }),
        );

        await ticker.tick(new Date('2026-10-13T17:30:00.000Z')); // 13:30 La Paz
        expect(entry.run).toHaveBeenCalledTimes(2);
    });

    it('follows a changed setting without redeploy', async () => {
        const settings = settingsOf({ route_cutoff_time: '15:00' });
        const entry = task('route-cutoff', { kind: 'time', settingKey: 'route_cutoff_time' });
        const ticker = instance([entry], settings);

        await ticker.tick(LA_PAZ_1500);
        expect(entry.run).toHaveBeenCalledTimes(1);

        settings.values.route_cutoff_time = '14:00';
        await ticker.tick(new Date('2026-10-14T19:00:00.000Z')); // 15:00 the next day, no longer the cutoff
        expect(entry.run).toHaveBeenCalledTimes(1);

        await ticker.tick(new Date('2026-10-14T18:00:00.000Z')); // 14:00
        expect(entry.run).toHaveBeenCalledTimes(2);
    });

    it('does not run a task whose setting is missing or invalid, and warns only once', async () => {
        const settings = settingsOf({ plan_generation_times: 'whenever' });
        const entry = generation();
        const ticker = instance([entry], settings);
        const warn = vi.spyOn((ticker as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});

        await ticker.tick(LA_PAZ_0830);
        await ticker.tick(LA_PAZ_0831);

        expect(entry.run).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('runs interval tasks on clock-aligned minutes', async () => {
        const entry = task('incomplete-orders-recovery', { kind: 'every-minutes', minutes: 15 });
        const ticker = instance([entry], settingsOf({}));

        await ticker.tick(new Date('2026-10-13T12:00:00.000Z')); // 08:00
        await ticker.tick(new Date('2026-10-13T12:07:00.000Z')); // 08:07
        await ticker.tick(new Date('2026-10-13T12:15:00.000Z')); // 08:15

        expect(entry.run).toHaveBeenCalledTimes(2);
    });

    it('runs several tasks due in the same minute', async () => {
        const settings = settingsOf({ plan_generation_times: '15:00', route_cutoff_time: '15:00' });
        const a = generation();
        const b = task('route-cutoff', { kind: 'time', settingKey: 'route_cutoff_time' });
        const ticker = instance([a, b], settings);

        await ticker.tick(LA_PAZ_1500);

        expect(a.run).toHaveBeenCalledTimes(1);
        expect(b.run).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the scheduler is disabled', async () => {
        const entry = generation();
        const ticker = instance([entry], settingsOf({ plan_generation_times: '08:30' }), { enabled: false });

        await ticker.tick(LA_PAZ_0830);

        expect(entry.run).not.toHaveBeenCalled();
    });

    it('a failing task does not stop the other tasks nor the tick', async () => {
        const settings = settingsOf({ plan_generation_times: '08:30', route_cutoff_time: '08:30' });
        const failing = task('plan-generation', { kind: 'times', settingKey: 'plan_generation_times' }, vi.fn().mockRejectedValue(new Error('boom')));
        const healthy = task('route-cutoff', { kind: 'time', settingKey: 'route_cutoff_time' });
        const ticker = instance([failing, healthy], settings);

        await expect(ticker.tick(LA_PAZ_0830)).resolves.toBeUndefined();

        expect(healthy.run).toHaveBeenCalledTimes(1);
    });

    describe('two simulated instances (same minute, same "database")', () => {
        const twoInstances = () => {
            const shared = { held: new Set<string>(), runs: [] as TaskRunRecord[] };
            const settings = settingsOf({ plan_generation_times: '08:30' });
            const run = vi.fn().mockResolvedValue(undefined);
            const build = () => instance([task('plan-generation', { kind: 'times', settingKey: 'plan_generation_times' }, run)], settings, shared);
            return { a: build(), b: build(), run, shared };
        };

        it('only one runs the task when both tick at the same moment', async () => {
            const { a, b, run } = twoInstances();

            await Promise.all([a.tick(LA_PAZ_0830), b.tick(LA_PAZ_0830)]);

            expect(run).toHaveBeenCalledTimes(1);
        });

        it('only one runs the task when the second ticks after the first finished', async () => {
            const { a, b, run, shared } = twoInstances();

            await a.tick(LA_PAZ_0830);
            await b.tick(LA_PAZ_0830);

            expect(run).toHaveBeenCalledTimes(1);
            expect(shared.runs).toHaveLength(1);
        });
    });
});
