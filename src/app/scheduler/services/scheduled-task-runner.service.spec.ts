import { describe, expect, it, vi } from 'vitest';
import { MemoryTaskLock } from '../memory/memory-task-lock.adapter.js';
import { MemoryTaskRunLog } from '../memory/memory-task-run-log.adapter.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';
import type { TaskRunRecord } from '../ports/task-run-log.port.js';
import { ScheduledTaskRunner } from './scheduled-task-runner.service.js';

const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
};

const taskWith = (run: ScheduledTask['run']): ScheduledTask => ({
    name: 'plan-generation',
    schedule: { kind: 'times', settingKey: 'plan_generation_times' },
    run,
});

const OCCURRENCE = 'plan-generation@2026-10-13T08:30';
const scheduled = { trigger: 'schedule', occurrence: OCCURRENCE } as const;

/** One backend instance. Instances built over the same `lock`/`runs` see each other, like two backends on one PostgreSQL. */
const instance = (shared: { held?: Set<string>; runs?: TaskRunRecord[] } = {}) => {
    const runs = shared.runs ?? [];
    return {
        runs,
        runner: new ScheduledTaskRunner(new MemoryTaskLock(shared.held ?? new Set()), new MemoryTaskRunLog(runs)),
    };
};

describe('ScheduledTaskRunner', () => {
    it('runs the task, gives it its context and records the run', async () => {
        const { runner, runs } = instance();
        const run = vi.fn().mockResolvedValue(undefined);

        const outcome = await runner.run(taskWith(run), scheduled);

        expect(outcome).toEqual({ status: 'executed' });
        expect(run).toHaveBeenCalledWith({
            trigger: 'schedule',
            occurrence: OCCURRENCE,
            startedAt: expect.any(Date),
        });
        expect(runs).toEqual([
            expect.objectContaining({ taskName: 'plan-generation', occurrence: OCCURRENCE, trigger: 'schedule' }),
        ]);
    });

    it('skips the task while another instance is running it', async () => {
        const held = new Set<string>();
        const first = instance({ held });
        const second = instance({ held });
        const hold = gate();
        const running = first.runner.run(taskWith(async () => await hold.opened), scheduled);

        const run = vi.fn();
        const outcome = await second.runner.run(taskWith(run), scheduled);

        expect(outcome).toEqual({ status: 'skipped-locked' });
        expect(run).not.toHaveBeenCalled();
        hold.open();
        await running;
    });

    it('skips an occurrence that another instance already ran (its clock was behind)', async () => {
        const shared = { held: new Set<string>(), runs: [] as TaskRunRecord[] };
        const first = instance(shared);
        const second = instance(shared);

        await first.runner.run(taskWith(vi.fn().mockResolvedValue(undefined)), scheduled);
        const run = vi.fn();
        const outcome = await second.runner.run(taskWith(run), scheduled);

        expect(outcome).toEqual({ status: 'skipped-already-ran' });
        expect(run).not.toHaveBeenCalled();
    });

    it('runs the next occurrence of the same task', async () => {
        const { runner } = instance();
        const run = vi.fn().mockResolvedValue(undefined);

        await runner.run(taskWith(run), scheduled);
        const outcome = await runner.run(taskWith(run), {
            trigger: 'schedule',
            occurrence: 'plan-generation@2026-10-13T13:30',
        });

        expect(outcome).toEqual({ status: 'executed' });
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('does not deduplicate manual runs, only serializes them with the lock', async () => {
        const { runner, runs } = instance();
        const run = vi.fn().mockResolvedValue(undefined);

        await runner.run(taskWith(run), { trigger: 'manual', occurrence: null });
        const outcome = await runner.run(taskWith(run), { trigger: 'manual', occurrence: null });

        expect(outcome).toEqual({ status: 'executed' });
        expect(run).toHaveBeenCalledTimes(2);
        expect(runs.map((entry) => entry.trigger)).toEqual(['manual', 'manual']);
    });

    describe('two simulated instances', () => {
        it('only one executes the task when both fire at the same time', async () => {
            const shared = { held: new Set<string>(), runs: [] as TaskRunRecord[] };
            const a = instance(shared);
            const b = instance(shared);
            const hold = gate();
            const run = vi.fn(async () => await hold.opened);

            const fromA = a.runner.run(taskWith(run), scheduled);
            const fromB = b.runner.run(taskWith(run), scheduled);
            // B found the lock taken and returned without waiting; A is still running.
            expect(await fromB).toEqual({ status: 'skipped-locked' });
            hold.open();

            expect(await fromA).toEqual({ status: 'executed' });
            expect(run).toHaveBeenCalledTimes(1);
            expect(shared.runs).toHaveLength(1);
        });

        it('only one executes the task when the second one fires after the first finished', async () => {
            const shared = { held: new Set<string>(), runs: [] as TaskRunRecord[] };
            const a = instance(shared);
            const b = instance(shared);
            const run = vi.fn().mockResolvedValue(undefined);

            const outcomes = [
                await a.runner.run(taskWith(run), scheduled),
                await b.runner.run(taskWith(run), scheduled),
            ];

            expect(outcomes).toEqual([{ status: 'executed' }, { status: 'skipped-already-ran' }]);
            expect(run).toHaveBeenCalledTimes(1);
        });

        it('lets the second instance retry the occurrence when the first one failed', async () => {
            const shared = { held: new Set<string>(), runs: [] as TaskRunRecord[] };
            const a = instance(shared);
            const b = instance(shared);

            const failed = await a.runner.run(
                taskWith(async () => {
                    throw new Error('OSRM unavailable');
                }),
                scheduled,
            );
            const run = vi.fn().mockResolvedValue(undefined);
            const retried = await b.runner.run(taskWith(run), scheduled);

            expect(failed).toEqual({ status: 'failed', error: 'OSRM unavailable' });
            expect(retried).toEqual({ status: 'executed' });
            expect(run).toHaveBeenCalledTimes(1);
        });
    });

    describe('failures', () => {
        it('reports a failing task as a value, never throws, and releases the lock', async () => {
            const held = new Set<string>();
            const { runner, runs } = instance({ held });

            const outcome = await runner.run(
                taskWith(async () => {
                    throw new Error('boom');
                }),
                scheduled,
            );

            expect(outcome).toEqual({ status: 'failed', error: 'boom' });
            expect(held.size).toBe(0);
            expect(runs).toHaveLength(0);
        });

        it('does not report a task as failed when only its bookkeeping row could not be written', async () => {
            const brokenLog = {
                wasRecorded: vi.fn().mockResolvedValue(false),
                record: vi.fn().mockRejectedValue(new Error('audit_logs unavailable')),
            };
            const runner = new ScheduledTaskRunner(new MemoryTaskLock(), brokenLog as never);

            const outcome = await runner.run(taskWith(vi.fn().mockResolvedValue(undefined)), scheduled);

            expect(outcome).toEqual({ status: 'executed' });
        });

        it('reports a failure of the run-log lookup as failed, without running the task', async () => {
            const brokenLog = {
                wasRecorded: vi.fn().mockRejectedValue(new Error('db down')),
                record: vi.fn(),
            };
            const runner = new ScheduledTaskRunner(new MemoryTaskLock(), brokenLog as never);
            const run = vi.fn();

            const outcome = await runner.run(taskWith(run), scheduled);

            expect(outcome).toEqual({ status: 'failed', error: 'db down' });
            expect(run).not.toHaveBeenCalled();
        });
    });
});
